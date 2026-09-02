import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState,
         Uri, Disposable, EventEmitter, Event, TextDocumentShowOptions,
         QuickPickItem, ProgressLocation, Memento, OutputChannel,
         workspace, commands, window, env, WorkspaceFoldersChangeEvent, TreeView, ThemeIcon, TreeItemCheckboxState, TreeCheckboxChangeEvent, authentication, TextEditor, RelativePattern,
         TabInputTextDiff, Range, TextEditorRevealType,
         FileDecorationProvider, FileDecoration, ProviderResult, ThemeColor } from 'vscode'
import { NAMESPACE } from './constants'
import { Repository, Git } from './git/git'
import { Ref, RefType } from './git/api/git'
import { anyEvent, filterEvent, eventToPromise } from './git/util'
import { getDefaultBranch, getHeadModificationDate, getBranchCommit, getStackParentBranch,
         getDiffStatuses, diffTrees, IDiffStatus, IDiffStats, StatusCode, getAbsGitDir,
         getWorkspaceFolders, getGitRepositoryFolders, hasUncommittedChanges, rmFile,
         listWorktrees, IWorktreeInfo,
         getBranchCommits as gitGetBranchCommits, getUncommittedSummary as gitGetUncommittedSummary,
         getEmptyTreeId, EMPTY_TREE_ID, ICommitInfo, IUncommittedSummary } from './gitHelper'
import { CommitFilterSpec, ComparisonInfo, ComparisonHost, commitFilterSpecEquals } from './commitsProvider'
import { tryDeepenForMergeBase } from './deepenHelper'
import { throttle } from './git/decorators'
import { normalizePath } from './fsUtils';
import { API as GitAPI, Repository as GitAPIRepository } from './typings/git';
import { Octokit } from '@octokit/rest';


type SortOrder = 'name' | 'path' | 'status' | 'recentlyModified';
type IconStyle = 'status' | 'fileTheme';

const MAX_DIFF_ENTRIES = 10000;
const TREE_RESOURCE_SCHEME = 'git-tree-compare';

const STATUS_SORT_ORDER: { [key: string]: number } = {
    'M': 0, // Modified
    'A': 1, // Added
    'D': 2, // Deleted
    'R': 3, // Renamed
    'C': 4, // Conflict
    'U': 5, // Untracked
    'T': 6  // Type change
};

interface CheckboxStateInfo {
    state: TreeItemCheckboxState;
    timestamp: number; // When the checkbox was checked
}

class FileElement implements IDiffStatus {
    modificationDate?: Date;

    constructor(
        public srcAbsPath: string,
        public dstAbsPath: string,
        public dstRelPath: string,
        public status: StatusCode,
        public isSubmodule: boolean,
        public repositoryRoot: string,
        public stats: IDiffStats | undefined = undefined) {}

    get label(): string {
        return path.basename(this.dstAbsPath)
    }
}

class FolderElement {
    constructor(
        public label: string,
        public dstAbsPath: string,
        public useFilesOutsideTreeRoot: boolean,
        public repositoryRoot: string) {}
}

class RepoRootElement extends FolderElement {
    constructor(repositoryRoot: string, absPath: string) {
        super('/', absPath, true, repositoryRoot);
    }
}

class RepositoryElement {
    constructor(public repositoryRoot: string, public label: string, public hasChildren: boolean,
                public description: string | undefined = undefined,
                public isWorktree: boolean = false) {}
}

class RefElement {
    constructor(public repositoryRoot: string, public refName: string, public hasChildren: boolean) {}
}

export type Element = FileElement | FolderElement | RepoRootElement | RepositoryElement | RefElement
type FileSystemElement = FileElement | FolderElement

/**
 * The subset of the provider that a {@link RepositoryComparison} needs.
 * Everything here is either global configuration or a global UI concern.
 */
interface IComparisonHost {
    readonly gitApi: GitAPI;
    readonly globalState: Memento;

    readonly treeRootIsRepo: boolean;
    readonly fullDiff: boolean;
    readonly detectStackBaseBranch: boolean;
    readonly findRenames: boolean;
    readonly renameThreshold: number;
    readonly omitUntrackedFiles: boolean;
    readonly omitUnstagedChanges: boolean;
    readonly showDiffStats: boolean;
    readonly resetCheckboxOnFileChange: boolean;
    readonly viewAsList: boolean;
    readonly sortOrder: SortOrder;

    log(msg: string, error?: Error | undefined): void;
    fireTreeDataChange(): void;
    comparisonUpdated(comparison: RepositoryComparison): void;
}

class ComparisonCreationCancelledError extends Error {
    constructor() {
        super('Repository comparison creation was cancelled');
    }
}

/**
 * Owns the complete state of the comparison for a single repository.
 *
 * There is one instance per repository, and no state is ever moved between
 * instances. This is what makes concurrent work on different repositories
 * safe: an operation holds on to its own instance across `await` boundaries,
 * so it can no longer be retargeted by rendering or by another repository's
 * refresh. It also scopes the `@throttle` on `updateDiff` to one repository,
 * which would otherwise coalesce diffs across repositories.
 */
class RepositoryComparison {
    treeRoot: FolderAbsPath;

    baseRef = '';
    /** Whether the current base ref was picked explicitly by the user. */
    private baseRefExplicit = false;
    mergeBase = '';
    headLastChecked = new Date(0);
    headName: string | undefined = undefined;
    headCommit = '';

    filesInsideTreeRoot = new Map<FolderAbsPath, IDiffStatus[]>();
    filesOutsideTreeRoot = new Map<FolderAbsPath, IDiffStatus[]>();

    checkboxStates = new Map<string, CheckboxStateInfo>();
    searchFilter: string | undefined = undefined;

    // Restricts the diff to a subset of commits selected in the commits list.
    // Defaults to the full comparison (working tree vs base).
    commitFilter: CommitFilterSpec = { kind: 'all' };

    private initialLoad: Promise<void> | undefined;
    private loaded = false;

    /** Whether refs and diff have been computed successfully at least once. */
    get isLoaded(): boolean {
        return this.loaded;
    }

    constructor(
        private readonly host: IComparisonHost,
        readonly repository: Repository,
        readonly repoRoot: FolderAbsPath,
        readonly absGitDir: string,
        public workspaceFolder: string,
        readonly isOutsideWorkspace: boolean) {
        this.treeRoot = this.computeTreeRoot();
    }

    private computeTreeRoot(): FolderAbsPath {
        const repoIsWorkspaceSubfolder = this.repoRoot.startsWith(this.workspaceFolder + path.sep);
        if (this.host.treeRootIsRepo || repoIsWorkspaceSubfolder) {
            return this.repoRoot;
        }
        return this.workspaceFolder;
    }

    /** Returns true if the tree root changed and the diff has to be recomputed. */
    updateTreeRootFolder(): boolean {
        const treeRoot = this.computeTreeRoot();
        if (treeRoot === this.treeRoot) {
            return false;
        }
        this.treeRoot = treeRoot;
        return true;
    }

    /**
     * Computes refs and diff once. Concurrent callers share the same promise,
     * so expanding several repositories at the same time cannot start
     * duplicate work. A failed load is retried on the next call.
     */
    ensureLoaded(): Promise<void> {
        let load = this.initialLoad;
        if (!load) {
            load = (async () => {
                await this.updateRefs();
                await this.updateDiff(false);
                this.loaded = true;
            })();
            this.initialLoad = load;
            const pending = load;
            pending.catch(() => {
                if (this.initialLoad === pending) {
                    this.initialLoad = undefined;
                }
            });
        }
        return load;
    }

    isInsideTreeRoot(folder: string): boolean {
        return folder === this.treeRoot || folder.startsWith(this.treeRoot + path.sep);
    }

    findFile(dstAbsPath: string): IDiffStatus | undefined {
        const folder = path.dirname(dstAbsPath);
        const files = this.isInsideTreeRoot(folder) ? this.filesInsideTreeRoot : this.filesOutsideTreeRoot;
        return files.get(folder)?.find(file => file.dstAbsPath === dstAbsPath);
    }

    *iterFiles(withinFolder: string | undefined = undefined) {
        for (let filesMap of [this.filesInsideTreeRoot, this.filesOutsideTreeRoot]) {
            for (let [folder, files] of filesMap.entries()) {
                // Compare whole path segments, otherwise "src/foo" would also
                // match the sibling folder "src/foobar".
                if (withinFolder && folder !== withinFolder &&
                        !folder.startsWith(withinFolder + path.sep)) {
                    continue;
                }
                for (let file of files) {
                    if (!file.isSubmodule) {
                        yield file;
                    }
                }
            }
        }
    }

    clearFiles() {
        this.filesInsideTreeRoot = new Map();
        this.filesOutsideTreeRoot = new Map();
    }

    private async getStoredBaseRef(): Promise<string | undefined> {
        let baseRef = this.host.globalState.get<string>('baseRef_' + this.repoRoot);
        if (baseRef) {
            if (await this.isRefExisting(baseRef) || await this.isCommitExisting(baseRef)) {
                this.host.log('Using stored base ref: ' + baseRef);
            } else {
                this.host.log('Not using non-existant stored base ref: ' + baseRef);
                baseRef = undefined;
            }
        }
        return baseRef;
    }

    async isRefExisting(refName: string): Promise<boolean> {
        const refs = await this.repository.getRefs();
        return refs.some(ref => ref.name === refName);
    }

    async isCommitExisting(id: string): Promise<boolean> {
        try {
            await this.repository.getCommit(id);
            return true;
        } catch {
            return false;
        }
    }

    private updateStoredBaseRef(baseRef: string) {
        this.host.globalState.update('baseRef_' + this.repoRoot, baseRef);
    }

    async isHeadChanged(): Promise<boolean> {
        // Note that we can't rely on filesystem change notifications for .git/HEAD
        // because the workspace root may be a subfolder of the repo root
        // and change notifications are currently limited to workspace scope.
        // See https://github.com/Microsoft/vscode/issues/3025.
        const mtime = await getHeadModificationDate(this.absGitDir);
        if (mtime > this.headLastChecked) {
            return true;
        }
        // At this point we know that HEAD still points to the same symbolic ref or commit (if detached).
        // If HEAD is not detached, check if the symbolic ref resolves to a different commit.
        if (this.headName) {
            // this.repository.getBranch() is not used here to avoid git invocation overhead
            const headCommit = await getBranchCommit(this.headName, this.repository);
            if (this.headCommit !== headCommit) {
                return true;
            }
        }
        return false;
    }

    async updateRefs(baseRef?: string): Promise<void> {
        this.host.log(`Updating refs: ${this.repoRoot}`);
        const headLastChecked = new Date();
        const HEAD = await this.repository.getHEAD();
        // if detached HEAD, then .commit exists, otherwise only .name
        const headName = HEAD.name;
        const headCommit = HEAD.commit || await getBranchCommit(HEAD.name!, this.repository);
        if (baseRef) {
            const exists = await this.isRefExisting(baseRef) || await this.isCommitExisting(baseRef);
            if (!exists) {
                // happens when branch was deleted
                baseRef = undefined;
            }
            // An explicit choice stands until the branch changes, so that stack
            // detection does not undo it on the next refresh.
            this.baseRefExplicit = baseRef !== undefined;
        } else if (this.headName !== headName) {
            this.baseRefExplicit = false;
        }
        if (!baseRef && this.host.detectStackBaseBranch && !this.baseRefExplicit && headName) {
            const parent = await getStackParentBranch(this.repository, headName);
            if (parent && parent !== headName && await this.isRefExisting(parent)) {
                this.host.log(`Using gh-stack parent branch as base ref: ${parent}`);
                baseRef = parent;
            }
        }
        if (!baseRef) {
            baseRef = await this.getStoredBaseRef();
        }
        if (!baseRef) {
            baseRef = await getDefaultBranch(this.repository, HEAD);
        }
        if (!baseRef) {
            if (HEAD.name) {
                baseRef = HEAD.name;
            } else {
                // detached HEAD and no default branch was found
                // pick an arbitrary ref as base, give preference to common refs
                const refs = await this.repository.getRefs();
                const commonRefs = ['origin/main', 'main', 'origin/master', 'master'];
                const match = refs.find(ref => ref.name !== undefined && commonRefs.indexOf(ref.name) !== -1);
                if (match) {
                    baseRef = match.name;
                } else if (refs.length > 0) {
                    baseRef = refs[0].name;
                }
            }
        }
        if (!baseRef) {
            // this should never happen
            throw new Error('Base ref could not be determined!');
        }
        const HEADref: string = (HEAD.name || HEAD.commit)!;
        let mergeBase = baseRef;
        if (!this.host.fullDiff && baseRef != HEAD.name) {
            // determine merge base to create more sensible/compact diff
            let mergeBaseResult: string | undefined;
            try {
                mergeBaseResult = await this.repository.getMergeBase(HEADref, baseRef);
            } catch (e) {
                // sometimes the merge base cannot be determined
                // this can be the case with shallow clones but may have other reasons
            }
            if (!mergeBaseResult) {
                const gitApiRepo = this.host.gitApi.getRepository(Uri.file(this.repository.root));
                if (gitApiRepo) {
                    mergeBaseResult = await tryDeepenForMergeBase(
                        this.repository, gitApiRepo, HEADref, HEAD.name, baseRef,
                        msg => this.host.log(msg));
                }
            }
            if (!mergeBaseResult) {
                throw new Error(
                    `No merge base could be found between "${HEADref}" and "${baseRef}". ` +
                    `This can happen with shallow clones that don't have enough depth. ` +
                    `Try fetching more history, or switch the diff mode to "full".`);
            }
            mergeBase = mergeBaseResult;
        }
        if (this.headName !== headName) {
            this.host.log(`HEAD ref updated: ${this.headName} -> ${headName}`);
            this.checkboxStates.clear();
        }
        if (this.headCommit !== headCommit) {
            this.host.log(`HEAD ref commit updated: ${this.headCommit} -> ${headCommit}`);
        }
        if (this.baseRef !== baseRef) {
            this.host.log(`Base ref updated: ${this.baseRef} -> ${baseRef}`);
        }
        if (!this.host.fullDiff && this.mergeBase !== mergeBase) {
            this.host.log(`Merge base updated: ${this.mergeBase} -> ${mergeBase}`);
        }
        // If the comparison identity changed (different merge base or HEAD commit), any
        // previous commit selection no longer applies; reset to the full comparison.
        if (this.mergeBase !== mergeBase || this.headCommit !== headCommit) {
            this.commitFilter = { kind: 'all' };
        }
        this.headLastChecked = headLastChecked;
        this.headName = headName;
        this.headCommit = headCommit;
        this.baseRef = baseRef;
        this.mergeBase = mergeBase;
        this.updateStoredBaseRef(baseRef);
    }

    /**
     * Resolves the two endpoints of the currently displayed diff, honouring the commit
     * selection. `rightRef === null` means the working tree.
     */
    getDiffEndpoints(): { leftRef: string, rightRef: string | null } {
        if (this.commitFilter.kind === 'range') {
            return { leftRef: this.commitFilter.leftRef!, rightRef: this.commitFilter.rightRef ?? null };
        }
        return { leftRef: this.mergeBase, rightRef: null };
    }

    /** Computes the set of changed files for the active commit filter. */
    private async computeDiff(): Promise<IDiffStatus[]> {
        const filter = this.commitFilter;
        if (filter.kind === 'empty') {
            return [];
        }
        const { findRenames, renameThreshold, omitUntrackedFiles, omitUnstagedChanges, showDiffStats } = this.host;
        if (filter.kind === 'range' && (filter.rightRef ?? null) !== null) {
            return diffTrees(this.repository, filter.leftRef!, filter.rightRef!,
                findRenames, renameThreshold, showDiffStats);
        }
        // Either the full comparison, or a range whose right side is the working tree.
        // Both diff against the working tree, which also brings in untracked files.
        const leftRef = filter.kind === 'range' ? filter.leftRef! : this.mergeBase;
        return getDiffStatuses(this.repository, leftRef, findRenames,
            renameThreshold, omitUntrackedFiles, omitUnstagedChanges, showDiffStats);
    }

    @throttle
    async updateDiff(fireChangeEvents: boolean) {
        if (!this.baseRef) {
            await this.updateRefs();
        }

        const filesInsideTreeRoot = new Map<FolderAbsPath, IDiffStatus[]>();
        const filesOutsideTreeRoot = new Map<FolderAbsPath, IDiffStatus[]>();

        const diff = await this.computeDiff();
        const untrackedCount = diff.reduce((prev, cur, _) => prev + (cur.status === 'U' ? 1 : 0), 0);
        this.host.log(`${diff.length} diff entries (${untrackedCount} untracked)`);

        if (diff.length > MAX_DIFF_ENTRIES) {
            const msg = `Too many changes to display (${diff.length}, limit is ${MAX_DIFF_ENTRIES}). Choose a closer base ref to reduce the number of changes.`;
            this.host.log(msg);
            window.showErrorMessage(msg);
            this.clearFiles();
            if (fireChangeEvents) {
                this.host.fireTreeDataChange();
            }
            this.host.comparisonUpdated(this);
            return;
        }

        const newFilePaths = new Set<string>();
        // Collect files that need mtime checking for async batch processing
        const filesToCheckMtime: Array<{filePath: string, stateInfo: CheckboxStateInfo}> = [];

        for (const entry of diff) {
            const folder = path.dirname(entry.dstAbsPath);

            const isInsideTreeRoot = this.isInsideTreeRoot(folder);
            const files = isInsideTreeRoot ? filesInsideTreeRoot : filesOutsideTreeRoot;
            const rootFolder = isInsideTreeRoot ? this.treeRoot : this.repoRoot;

            if (files.size == 0) {
                files.set(rootFolder, new Array());
            }

            // add this and all parent folders to the folder map
            let currentFolder = folder
            while (currentFolder != rootFolder) {
                if (!files.has(currentFolder)) {
                    files.set(currentFolder, new Array());
                }
                currentFolder = path.dirname(currentFolder)
            }

            const entries = files.get(folder)!;
            entries.push(entry);

            // Track new file paths
            newFilePaths.add(entry.dstAbsPath);

            // Collect checked files for mtime checking to reset if modified after being checked
            if (this.host.resetCheckboxOnFileChange) {
                const stateInfo = this.checkboxStates.get(entry.dstAbsPath);
                if (stateInfo && stateInfo.state === TreeItemCheckboxState.Checked) {
                    filesToCheckMtime.push({filePath: entry.dstAbsPath, stateInfo});
                }
            }
        }

        // Check file modification times asynchronously in parallel
        if (this.host.resetCheckboxOnFileChange && filesToCheckMtime.length > 0) {
            const statPromises = filesToCheckMtime.map(async ({filePath, stateInfo}) => {
                try {
                    const stats = await fs.promises.stat(filePath);
                    const fileMtime = stats.mtimeMs;

                    // If file was modified after checkbox was checked, reset it
                    if (fileMtime > stateInfo.timestamp) {
                        return filePath;
                    }
                } catch (error: unknown) {
                    // File might be deleted or inaccessible - this is expected in some cases
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.host.log(`Could not stat file for checkbox reset check: ${filePath}: ${errorMessage}`);
                }
                return null;
            });

            const pathsToReset = await Promise.all(statPromises);
            const actualPathsToReset = pathsToReset.filter((filePath): filePath is string => filePath !== null);
            actualPathsToReset.forEach(filePath => this.checkboxStates.delete(filePath));

            // Fire tree refresh to update checkbox UI
            if (actualPathsToReset.length > 0) {
                this.host.fireTreeDataChange();
            }
        }

        // Clear checkbox state for files that no longer exist in the diff
        const pathsToDelete: string[] = [];
        for (const [filePath] of this.checkboxStates) {
            if (!newFilePaths.has(filePath)) {
                pathsToDelete.push(filePath);
            }
        }
        for (const filePath of pathsToDelete) {
            this.checkboxStates.delete(filePath);
        }

        let treeHasChanged = false;
        if (fireChangeEvents) {
            const hasChanged = (folderPath: string, insideTreeRoot: boolean) => {
                const oldFiles = insideTreeRoot ? this.filesInsideTreeRoot : this.filesOutsideTreeRoot;
                const newFiles = insideTreeRoot ? filesInsideTreeRoot : filesOutsideTreeRoot;
                const oldItems = oldFiles.get(folderPath)!.map(f => `${f.status}|${f.dstAbsPath}`);
                const newItems = newFiles.get(folderPath)!.map(f => `${f.status}|${f.dstAbsPath}`);
                for (const {files, items} of [{files: oldFiles, items: oldItems},
                                              {files: newFiles, items: newItems}]) {
                    // add direct subdirectories to items list
                    for (const folder of files.keys()) {
                        if (path.dirname(folder) === folderPath) {
                            items.push(folder);
                        }
                    }
                }
                return !sortedArraysEqual(oldItems, newItems);
            }

            const treeRootChanged = !filesInsideTreeRoot.size !== !this.filesInsideTreeRoot.size;
            const mustAddOrRemoveRepoRootElement = !filesOutsideTreeRoot.size !== !this.filesOutsideTreeRoot.size;
            if (treeRootChanged || mustAddOrRemoveRepoRootElement) {
                treeHasChanged = true;
            } else {
                for (const folder of filesInsideTreeRoot.keys()) {
                    if (!this.filesInsideTreeRoot.has(folder) ||
                            hasChanged(folder, true)) {
                        treeHasChanged = true;
                        break;
                    }
                }
                if (!treeHasChanged) {
                    for (const folder of filesOutsideTreeRoot.keys()) {
                        if (!this.filesOutsideTreeRoot.has(folder) ||
                                hasChanged(folder, false)) {
                            treeHasChanged = true;
                            break;
                        }
                    }
                }
            }
        }

        this.filesInsideTreeRoot = filesInsideTreeRoot;
        this.filesOutsideTreeRoot = filesOutsideTreeRoot;

        // Always refresh when sorting by recently modified in list view, as file mtimes may have changed
        const needsRefreshForSorting = this.host.viewAsList && this.host.sortOrder === 'recentlyModified';

        if (fireChangeEvents && (treeHasChanged || needsRefreshForSorting || this.host.showDiffStats)) {
            this.host.log('Refreshing tree')
            this.host.fireTreeDataChange();
        }

        // Let the commits list know the comparison may have changed (new commits,
        // updated uncommitted summary, etc.).
        this.host.comparisonUpdated(this);
    }
}

class ChangeBaseRefItem implements QuickPickItem {
	protected get shortCommit(): string { return (this.ref.commit || '').substr(0, 8); }
	get label(): string { return this.ref.name!; }
	get description(): string { return this.shortCommit; }

	constructor(public ref: Ref) { }
}

class ChangeBaseTagItem extends ChangeBaseRefItem {
	override get description(): string {
		return "Tag at " + this.shortCommit;
	}
}

class ChangeBaseRemoteHeadItem extends ChangeBaseRefItem {
	override get description(): string {
		return "Remote branch at " + this.shortCommit;
	}
}

class ChangeBaseCommitItem implements QuickPickItem {
	get label(): string { return "$(git-commit) Custom commit"; }
	get description(): string { return ""; }
}

interface RepositoryPickItem extends QuickPickItem {
    repositoryPath: string;
}

class ChangeRepositoryItem implements RepositoryPickItem {
    constructor(public repositoryRoot: string) { }

    get repositoryPath(): string { return normalizePath(this.repositoryRoot); }
	get label(): string { return path.basename(this.repositoryRoot); }
	get description(): string { return this.repositoryRoot; }
}

class WorkingTreePickItem implements RepositoryPickItem {
    constructor(public repositoryPath: string) { }

    get label(): string { return '$(home) Working Tree'; }
    get description(): string { return this.repositoryPath; }
}

class ChangeWorktreeItem implements RepositoryPickItem {
    constructor(public worktree: IWorktreeInfo) { }

    get repositoryPath(): string { return this.worktree.path; }
    get label(): string {
        if (this.worktree.branch) {
            return `$(git-branch) ${this.worktree.branch}`;
        }
        return `$(git-commit) ${this.worktree.head.substr(0, 8)}`;
    }
    get description(): string { return this.worktree.path; }
}

type FolderAbsPath = string;

export class GitTreeCompareProvider implements TreeDataProvider<Element>, Disposable, IComparisonHost, ComparisonHost {

    // Events
    private _onDidChangeTreeData = new EventEmitter<Element | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    // Fired whenever the comparison the commits list is bound to changes (repository,
    // base/merge base or HEAD), so the commits list can refresh itself.
    private _onDidChangeComparison = new EventEmitter<void>();
    readonly onDidChangeComparison: Event<void> = this._onDidChangeComparison.event;

    // Fired when a relevant change is detected in a repository working tree or refs,
    // before the (tree-visibility-gated) diff recompute. Lets dependents such as the
    // commits list refresh on their own schedule/visibility instead of piggybacking on
    // the main tree's update.
    private _onDidChangeRepository = new EventEmitter<void>();
    readonly onDidChangeRepository: Event<void> = this._onDidChangeRepository.event;

    fireTreeDataChange() {
        this.parentMap.clear();
        this.elementMap.clear();
        this._onDidChangeTreeData.fire();
    }

    // Configuration options
    treeRootIsRepo: boolean;
    private includeFilesOutsideWorkspaceFolderRoot: boolean;
    private openChangesOnSelect: boolean;
    private autoChangeRepository: boolean;
    private multiRepositoryView: boolean;
    private autoRefresh: boolean;
    private iconsMinimal: boolean;
    private iconStyle: IconStyle;
    fullDiff: boolean;
    detectStackBaseBranch: boolean;
    findRenames: boolean;
    renameThreshold: number;
    private showCollapsed: boolean;
    private compactFolders: boolean;
    private showCheckboxes: boolean;
    resetCheckboxOnFileChange: boolean;
    omitUntrackedFiles: boolean;
    omitUnstagedChanges: boolean;
    sortOrder: SortOrder;
    private autoReveal: boolean;
    showDiffStats: boolean;

    // One comparison per repository, keyed by canonical repository root.
    private comparisons = new Map<FolderAbsPath, RepositoryComparison>();
    // Workspace repository root -> linked worktree currently displayed for it.
    // Only used in the repository-node layout, where each repository node shows
    // one checkout of that repository.
    private worktreeOverrides = new Map<FolderAbsPath, FolderAbsPath>();
    // Maps any path used to look up a repository to its canonical root.
    private rootAliases = new Map<string, FolderAbsPath>();
    // In-flight creations, so concurrent lookups share one RepositoryComparison.
    private pendingComparisons = new Map<string, Promise<RepositoryComparison>>();
    // Incremented whenever repository membership is reset. Async creations
    // must match the current generation before publishing any state.
    private comparisonGeneration = 0;
    // Load failures already reported to the user, to avoid repeating a dialog
    // for the same persistent error on every tree refresh.
    private reportedLoadErrors = new Map<string, string>();
    // The repository shown when the tree does not show repository nodes.
    private activeComparison: RepositoryComparison | undefined;
    // The repository whose commits the commits list shows. Follows the selection in the
    // tree so the list stays usable in the repository-node layout, where there is no
    // single active comparison.
    private commitsRepoRoot: FolderAbsPath | undefined;

    // Dynamic options
    viewAsList = false;
    private hideCheckedFiles = false;

    // UI state
    private treeView: TreeView<Element>;
    private parentMap: Map<string, Element> = new Map();
    private elementMap: Map<string, FileElement> = new Map();
    private pendingRefreshRoots = new Set<FolderAbsPath>();
    private pendingRefreshTimer: NodeJS.Timeout | undefined;
    private refreshInProgress = false;
    private disposed = false;
    // Incremented on each "Collapse All". Changing folder ids makes VS Code
    // apply their collapsed state instead of restoring their previous state.
    // The ref keeps its stable id and remains expanded.
    private collapseGeneration = 0;

    // Other
    private readonly disposables: Disposable[] = [];
    private extraRepositoryWatchers = new Map<FolderAbsPath, Disposable>();
    private repositoryUiSubscriptions = new Map<string, Disposable>();

    constructor(private readonly git: Git, readonly gitApi: GitAPI, private readonly outputChannel: OutputChannel, readonly globalState: Memento,
                private readonly asAbsolutePath: (relPath: string) => string) {
        this.readConfig();
    }

    /**
     * Single source of truth for the tree layout: repository nodes are only
     * shown when the feature is enabled *and* there is more than one
     * repository. A single repository always uses the original layout.
     */
    private showRepositoryNodes(): boolean {
        return this.multiRepositoryView && this.getRepositoryRoots().length > 1;
    }

    /** Workspace repository roots, de-duplicated by canonical root. */
    private getRepositoryRoots(selectedFirst=false): string[] {
        const roots = getGitRepositoryFolders(this.gitApi, selectedFirst).map(normalizePath);
        const uniqueRoots: string[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
            const canonical = this.rootAliases.get(root) ?? root;
            if (!seen.has(canonical)) {
                uniqueRoots.push(root);
                seen.add(canonical);
            }
        }
        return uniqueRoots;
    }

    private getExistingComparison(repositoryRoot: string): RepositoryComparison | undefined {
        const normalized = normalizePath(repositoryRoot);
        const canonical = this.rootAliases.get(normalized) ?? normalized;
        return this.comparisons.get(canonical);
    }

    /**
     * Returns the comparison for a repository, creating it if necessary.
     * Concurrent calls for the same repository share a single creation, so a
     * repository can never end up with two diverging comparison objects.
     */
    private async getComparison(repositoryRoot: string): Promise<RepositoryComparison> {
        const existing = this.getExistingComparison(repositoryRoot);
        if (existing) {
            return existing;
        }
        const requested = normalizePath(repositoryRoot);
        let pending = this.pendingComparisons.get(requested);
        if (!pending) {
            pending = this.createComparison(requested, this.comparisonGeneration);
            this.pendingComparisons.set(requested, pending);
            const creation = pending;
            const settled = () => {
                if (this.pendingComparisons.get(requested) === creation) {
                    this.pendingComparisons.delete(requested);
                }
            };
            pending.then(settled, settled);
        }
        return pending;
    }

    private invalidateComparisonCreations() {
        this.comparisonGeneration++;
        this.pendingComparisons.clear();
    }

    /** Returns a fully loaded comparison, or undefined if the repository is unusable. */
    private async loadComparison(repositoryRoot: string): Promise<RepositoryComparison | undefined> {
        const key = normalizePath(repositoryRoot);
        try {
            const comparison = await this.getComparison(repositoryRoot);
            await comparison.ensureLoaded();
            this.reportedLoadErrors.delete(key);
            return comparison;
        } catch (e: any) {
            if (e instanceof ComparisonCreationCancelledError) {
                return undefined;
            }
            const msg = `Comparing repository ${path.basename(key)} failed`;
            this.log(`${msg} (${key})`, e);
            // getChildren() retries on every tree refresh, so report a given
            // failure only once, until the repository loads again or starts
            // failing for a different reason.
            if (this.reportedLoadErrors.get(key) !== e.message) {
                this.reportedLoadErrors.set(key, e.message);
                window.showErrorMessage(`${msg}: ${e.message}`);
            }
            return undefined;
        }
    }

    /**
     * Resolves which repository a command acts on. Commands invoked from the
     * tree carry the repository in their element. Commands invoked from the
     * command palette use the active repository, or ask when several
     * repositories are shown, instead of silently picking one.
     */
    private async resolveRepositoryRoot(element?: Element): Promise<string | undefined> {
        if (element) {
            return element.repositoryRoot;
        }
        if (!this.showRepositoryNodes()) {
            if (this.activeComparison) {
                return this.activeComparison.repoRoot;
            }
            const roots = this.getRepositoryRoots(true);
            return roots[0];
        }
        const picks = this.getRepositoryRoots(true).map(root => new ChangeRepositoryItem(root));
        const choice = await window.showQuickPick<ChangeRepositoryItem>(picks,
            { placeHolder: 'Select a repository' });
        return choice?.repositoryRoot;
    }

    private async resolveComparison(element?: Element): Promise<RepositoryComparison | undefined> {
        const repositoryRoot = await this.resolveRepositoryRoot(element);
        return repositoryRoot ? await this.loadComparison(repositoryRoot) : undefined;
    }

    // --- ComparisonHost implementation (consumed by the commits list) ---

    /**
     * The comparison the commits list is bound to: the one selected in the tree, or the
     * active comparison of the single-repository layout when nothing is selected.
     */
    private get commitsComparison(): RepositoryComparison | undefined {
        const bound = this.commitsRepoRoot ? this.getExistingComparison(this.commitsRepoRoot) : undefined;
        return bound ?? this.activeComparison;
    }

    /** Rebinds the commits list after a tree selection or repository change. */
    private bindCommitsTo(repositoryRoot: FolderAbsPath | undefined) {
        const previous = this.commitsComparison;
        this.commitsRepoRoot = repositoryRoot;
        const current = this.commitsComparison;
        if (current === previous) {
            return;
        }
        // The commits list only ever reflects the comparison it is bound to, so a
        // filter left behind on the previous one would be unreachable state: a
        // restricted diff with no checkboxes anywhere to explain or undo it.
        if (previous) {
            void this.clearCommitFilter(previous);
        }
        this._onDidChangeComparison.fire();
    }

    /** Restores the full comparison, recomputing the diff if a filter was active. */
    private async clearCommitFilter(comparison: RepositoryComparison): Promise<void> {
        if (comparison.commitFilter.kind === 'all') {
            return;
        }
        comparison.commitFilter = { kind: 'all' };
        try {
            await comparison.updateDiff(false);
        } catch (e: any) {
            this.log('Restoring the full comparison failed', e);
        }
        this.fireTreeDataChange();
    }

    /** Restores the full comparison everywhere, e.g. when the commits panel is disabled. */
    async clearCommitFilters(): Promise<void> {
        for (const comparison of [...this.comparisons.values()]) {
            await this.clearCommitFilter(comparison);
        }
    }

    /** Called by a comparison once its refs and diff have been recomputed. */
    comparisonUpdated(comparison: RepositoryComparison) {
        if (comparison === this.commitsComparison) {
            this._onDidChangeComparison.fire();
        }
    }

    getCommitsComparison(): ComparisonInfo | undefined {
        const comparison = this.commitsComparison;
        if (!comparison || !comparison.baseRef) {
            return undefined;
        }
        return {
            repoRoot: comparison.repoRoot,
            mergeBase: comparison.mergeBase,
            headCommit: comparison.headCommit,
        };
    }

    /**
     * Updates the cached comparison refs (merge base / HEAD) from git without recomputing
     * the full file diff. Cheap enough to run on the commits list's own refresh schedule,
     * so it stays current even while the main tree is hidden and its diff recompute is
     * paused.
     */
    async refreshCommitsComparison(): Promise<void> {
        const comparison = this.commitsComparison;
        if (!comparison) {
            return;
        }
        try {
            if (await comparison.isHeadChanged()) {
                const filterBefore = comparison.commitFilter;
                await comparison.updateRefs(comparison.baseRef);
                // updateRefs drops a commit selection that no longer applies. The file
                // list still belongs to the old range at this point, and the commits
                // list cannot recover it (setCommitFilter would see the filter already
                // reset and do nothing), so recompute the diff here.
                if (filterBefore.kind !== 'all' && comparison.commitFilter.kind === 'all') {
                    await comparison.updateDiff(false);
                    this.fireTreeDataChange();
                }
            }
        } catch (e: any) {
            this.log('Refreshing the comparison for the commits list failed', e);
        }
    }

    async getBranchCommits(): Promise<ICommitInfo[]> {
        const comparison = this.commitsComparison;
        if (!comparison) {
            return [];
        }
        return gitGetBranchCommits(comparison.repository, comparison.mergeBase, comparison.headCommit);
    }

    async getUncommittedSummary(): Promise<IUncommittedSummary> {
        const comparison = this.commitsComparison;
        if (!comparison) {
            return { fileCount: 0, insertions: 0, deletions: 0 };
        }
        return gitGetUncommittedSummary(comparison.repository, this.omitUntrackedFiles);
    }

    async setCommitFilter(spec: CommitFilterSpec): Promise<void> {
        const comparison = this.commitsComparison;
        if (!comparison) {
            return;
        }
        // The commits list uses the SHA-1 empty tree as the base for a root commit,
        // which does not exist in SHA-256 repositories.
        if (spec.leftRef === EMPTY_TREE_ID) {
            spec = { ...spec, leftRef: await getEmptyTreeId(comparison.repository) };
        }
        if (commitFilterSpecEquals(comparison.commitFilter, spec)) {
            return;
        }
        comparison.commitFilter = spec;
        try {
            await comparison.updateDiff(false);
        } catch (e: any) {
            this.log('Updating the diff for the commit selection failed', e);
            window.showErrorMessage(`Updating the diff failed: ${e.message}`);
        }
        this.fireTreeDataChange();
        // Keep a currently visible diff in sync with the new selection.
        await this.refreshActiveDiff(comparison);
    }

    /**
     * If the active editor is a diff we opened for a file that is still part of the
     * current selection, re-open it so it reflects the newly selected commit(s).
     */
    private async refreshActiveDiff(comparison: RepositoryComparison): Promise<void> {
        const tab = window.tabGroups.activeTabGroup?.activeTab;
        if (!tab || !(tab.input instanceof TabInputTextDiff)) {
            return;
        }
        // Only update a preview tab: re-opening replaces it in place. Pinned/non-preview
        // diffs are left as the user explicitly kept them (and can't be replaced cleanly).
        if (!tab.isPreview) {
            return;
        }
        const input = tab.input;
        // Only act on diffs produced by this extension (the left side is a git: URI).
        if (input.original.scheme !== 'git') {
            return;
        }
        const dstAbsPath = uriToAbsPath(input.modified);
        if (!dstAbsPath) {
            return;
        }
        const diffStatus = comparison.findFile(dstAbsPath);
        if (!diffStatus) {
            // File is not part of the current selection; leave the existing diff untouched.
            return;
        }

        // Remember the current scroll position (top visible line) so we can restore it
        // after re-opening with the new commit's content.
        const oldUris = new Set([input.original.toString(), input.modified.toString()]);
        const prevEditor = window.visibleTextEditors.find(e => oldUris.has(e.document.uri.toString()));
        const anchorLine = prevEditor?.visibleRanges[0]?.start.line;

        const showOptions: TextDocumentShowOptions = { viewColumn: tab.group.viewColumn, preserveFocus: true };
        if (anchorLine !== undefined) {
            // Positions the re-opened diff near the previous location during the open itself.
            showOptions.selection = new Range(anchorLine, 0, anchorLine, 0);
        }

        await this.doOpenChanges(comparison, diffStatus.srcAbsPath, diffStatus.dstAbsPath, diffStatus.status, showOptions);

        if (anchorLine === undefined) {
            return;
        }

        // Refine: pin the previous top line to the top of the viewport.
        const { leftRef, rightRef } = comparison.getDiffEndpoints();
        const newUris = new Set<string>([
            (rightRef === null ? Uri.file(diffStatus.dstAbsPath) : this.gitApi.toGitUri(Uri.file(diffStatus.dstAbsPath), rightRef)).toString(),
            this.gitApi.toGitUri(Uri.file(diffStatus.srcAbsPath), leftRef).toString(),
        ]);
        const newEditor = window.visibleTextEditors.find(e => newUris.has(e.document.uri.toString()));
        if (newEditor) {
            const line = Math.min(anchorLine, Math.max(0, newEditor.document.lineCount - 1));
            newEditor.revealRange(new Range(line, 0, line, 0), TextEditorRevealType.AtTop);
        }
    }

    /**
     * Finds the repository a changed path belongs to. This deliberately
     * searches known comparisons rather than workspace repositories, so that
     * repositories outside the workspace (linked worktrees) and repositories
     * whose git dir lives elsewhere keep receiving auto refreshes.
     */
    private findComparisonForPath(absPath: string): RepositoryComparison | undefined {
        const normPath = normalizePath(absPath);
        let best: RepositoryComparison | undefined;
        let bestLength = -1;
        for (const comparison of this.comparisons.values()) {
            const bases = [comparison.repoRoot, normalizePath(comparison.absGitDir)];
            for (const base of bases) {
                if (normPath !== base && !normPath.startsWith(base + path.sep)) {
                    continue;
                }
                if (base.length > bestLength) {
                    bestLength = base.length;
                    best = comparison;
                }
            }
        }
        return best;
    }

    async init(treeView: TreeView<Element>) {
        this.treeView = treeView

        // Use the original single-repository behavior unless the tree actually
        // shows repository nodes.
        if (!this.showRepositoryNodes()) {
            const gitRepos = this.getRepositoryRoots(true);
            if (gitRepos.length > 0) {
                await this.changeRepository(gitRepos[0]);
            }
        }

        this.disposables.push(workspace.onDidChangeConfiguration(this.handleConfigChange, this));
        this.disposables.push(workspace.onDidChangeWorkspaceFolders(this.handleWorkspaceFoldersChanged, this));
        this.disposables.push(window.registerFileDecorationProvider(new GitTreeCompareFileDecorationProvider()));
        this.disposables.push(this.gitApi.onDidOpenRepository(this.handleRepositoryOpened, this));
        this.disposables.push(this.gitApi.onDidCloseRepository(this.handleRepositoryClosed, this));
        for (const repository of this.gitApi.repositories) {
            this.watchRepositoryUi(repository);
        }

        const fsWatcher = workspace.createFileSystemWatcher('**');
        this.disposables.push(fsWatcher);
        const onWorkspaceChange = anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
        const onRelevantWorkspaceChange = filterEvent(onWorkspaceChange, uri => this.isRelevantChange(uri));
        this.disposables.push(onRelevantWorkspaceChange(this.handleWorkspaceChange, this));

        this.disposables.push(treeView.onDidChangeCheckboxState(this.handleChangeCheckboxState, this));
        this.disposables.push(treeView.onDidChangeSelection(e => {
            const repositoryRoot = e.selection[0]?.repositoryRoot;
            if (repositoryRoot) {
                this.bindCommitsTo(repositoryRoot);
            }
        }));
        this.disposables.push(window.onDidChangeActiveTextEditor(this.handleActiveEditorChange, this));
        this.disposables.push(new Disposable(() => {
            this.disposed = true;
            if (this.pendingRefreshTimer) {
                clearTimeout(this.pendingRefreshTimer);
                this.pendingRefreshTimer = undefined;
            }
        }));

        this.updateViewState();
    }

    /**
     * If a repository is covered by multiple workspace folders, the deepest one
     * is used. `outsideWorkspace` repositories (linked worktrees) fall back to
     * the repository root.
     * TODO let the user choose which one
     */
    private pickWorkspaceFolder(repoRoot: string, outsideWorkspace: boolean,
                                workspaceFolders = getWorkspaceFolders(repoRoot)): string {
        if (outsideWorkspace || workspaceFolders.length === 0) {
            return repoRoot;
        }
        // Sort descending by folder depth
        const sorted = [...workspaceFolders].sort((a, b) => {
            const aDepth = a.uri.fsPath.split(path.sep).length;
            const bDepth = b.uri.fsPath.split(path.sep).length;
            return bDepth - aDepth;
        });
        return normalizePath(sorted[0].uri.fsPath);
    }

    private async createComparison(repositoryRoot: string, generation: number): Promise<RepositoryComparison> {
        const requestedRepositoryRoot = normalizePath(repositoryRoot);
        const actualRepositoryRoot = normalizePath(await this.git.getRepositoryRoot(requestedRepositoryRoot));
        const dotGit = await this.git.getRepositoryDotGit(actualRepositoryRoot);
        const repository = this.git.open(actualRepositoryRoot, dotGit);
        const absGitDir = await getAbsGitDir(repository);
        const repoRoot = normalizePath(repository.root);

        const workspaceFolders = getWorkspaceFolders(repoRoot);
        const outsideWorkspace = workspaceFolders.length == 0;
        if (outsideWorkspace) {
            const worktrees = await listWorktrees(repository);
            const isLinkedWorktree = worktrees.some(wt => wt.path === repoRoot);
            if (!isLinkedWorktree) {
                throw new Error(`Could not find any workspace folder for ${repositoryRoot}`);
            }
            workspaceFolders.push({ uri: Uri.file(repoRoot), name: path.basename(repoRoot), index: 0 });
        }

        const workspaceFolder = this.pickWorkspaceFolder(repoRoot, outsideWorkspace, workspaceFolders);

        if (generation !== this.comparisonGeneration) {
            throw new ComparisonCreationCancelledError();
        }

        this.rootAliases.set(requestedRepositoryRoot, repoRoot);
        this.rootAliases.set(repoRoot, repoRoot);

        // A different alias may have created the comparison while we awaited.
        const existing = this.comparisons.get(repoRoot);
        if (existing) {
            return existing;
        }

        const comparison = new RepositoryComparison(
            this, repository, repoRoot, absGitDir, workspaceFolder, outsideWorkspace);
        this.comparisons.set(repoRoot, comparison);
        this.log('Using repository: ' + repoRoot);
        this.addExtraRepositoryWatcher(comparison);
        return comparison;
    }

    /**
     * Publishes everything derived from the current layout: the view title and
     * the context keys that menus depend on. Menu visibility must be driven by
     * `showRepositoryNodes` rather than by the raw setting or by the git
     * extension's repository count, because neither of those matches the
     * layout this provider actually renders.
     */
    /**
     * Worktree switching operates on the single active comparison, so it is
     * only offered in the single-repository layout. In the repository-node
     * layout there is no unambiguous "current" repository to switch.
     */
    private updateWorktreeContext(showRepositoryNodes: boolean) {
        const comparison = showRepositoryNodes ? undefined : this.activeComparison;
        if (!comparison) {
            commands.executeCommand('setContext', NAMESPACE + '.viewingWorktree', false);
            commands.executeCommand('setContext', NAMESPACE + '.hasWorktrees', false);
            return;
        }
        listWorktrees(comparison.repository).then(worktrees => {
            // The layout or active repository may have changed while listing.
            if (this.disposed || this.activeComparison !== comparison || this.showRepositoryNodes()) {
                return;
            }
            const workspaceRoot = this.findWorkspaceWorktreeRoot(worktrees);
            const viewingWorktree = workspaceRoot !== undefined &&
                comparison.repoRoot !== workspaceRoot;
            commands.executeCommand('setContext', NAMESPACE + '.viewingWorktree', viewingWorktree);
            commands.executeCommand('setContext', NAMESPACE + '.hasWorktrees', worktrees.length > 1);
        }, e => {
            this.log('Listing the worktrees failed', e);
            commands.executeCommand('setContext', NAMESPACE + '.viewingWorktree', false);
            commands.executeCommand('setContext', NAMESPACE + '.hasWorktrees', false);
        });
    }

    private updateViewState() {
        const showRepositoryNodes = this.showRepositoryNodes();
        commands.executeCommand('setContext', NAMESPACE + '.showRepositoryNodes', showRepositoryNodes);

        const isFiltered = showRepositoryNodes
            ? [...this.comparisons.values()].some(c => c.searchFilter)
            : !!this.activeComparison?.searchFilter;
        commands.executeCommand('setContext', NAMESPACE + '.isFiltered', isFiltered);

        this.updateWorktreeContext(showRepositoryNodes);

        if (!this.treeView) {
            return;
        }
        if (showRepositoryNodes) {
            this.treeView.title = isFiltered ? 'Git Tree Compare (filtered)' : 'Git Tree Compare';
            return;
        }
        const comparison = this.activeComparison;
        if (!comparison) {
            this.treeView.title = 'none';
            return;
        }
        const repoName = path.basename(comparison.repoRoot);
        this.treeView.title = comparison.searchFilter ? `${repoName} (filtered)` : repoName;
    }

    async unsetRepository() {
        this.invalidateComparisonCreations();
        this.activeComparison = undefined;
        this.commitsRepoRoot = undefined;
        this.comparisons.clear();
        this.rootAliases.clear();
        this.reportedLoadErrors.clear();
        this.disposeExtraRepositoryWatchers();
        this.fireTreeDataChange();
        this._onDidChangeComparison.fire();
        this.log('No repository selected');

        this.updateViewState();
    }

    async changeRepository(repositoryRoot: string) {
        let comparison: RepositoryComparison;
        try {
            comparison = await this.getComparison(repositoryRoot);
        } catch (e: any) {
            if (e instanceof ComparisonCreationCancelledError) {
                return;
            }
            let msg = 'Changing the repository failed';
            this.log(msg, e);
            window.showErrorMessage(`${msg}: ${e.message}`);
            return;
        }
        // Select the repository even if loading fails, so that a transient
        // error does not leave the view stuck on no repository at all.
        const previousCommitsComparison = this.commitsComparison;
        this.activeComparison = comparison;
        // The commits list follows the newly selected repository unless the user
        // picks something else in the tree.
        this.commitsRepoRoot = undefined;
        if (this.commitsComparison !== previousCommitsComparison) {
            if (previousCommitsComparison) {
                void this.clearCommitFilter(previousCommitsComparison);
            }
            this._onDidChangeComparison.fire();
        }
        if (comparison.isLoaded) {
            // ensureLoaded() is a no-op once loaded, so refresh explicitly to
            // avoid showing a stale diff when switching back to a repository.
            await this.refreshComparison(comparison, true);
        } else {
            try {
                await comparison.ensureLoaded();
            } catch (e: any) {
                let msg = 'Changing the repository failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
            }
        }
        this.updateViewState();
        this.fireTreeDataChange();
    }

    /** The checkout currently displayed for a workspace repository root. */
    private displayedRoot(workspaceRoot: string): string {
        return this.worktreeOverrides.get(normalizePath(workspaceRoot)) ?? normalizePath(workspaceRoot);
    }

    /**
     * The workspace folder that is a worktree of the repository the given
     * worktree list belongs to, i.e. where "the working tree" is for that
     * repository. Scoped to that repository's worktrees rather than the global
     * repository list, so that a multi-root workspace does not resolve to an
     * unrelated repository.
     */
    private findWorkspaceWorktreeRoot(worktrees: IWorktreeInfo[]): string | undefined {
        const worktreePaths = new Set(worktrees.map(wt => normalizePath(wt.path)));
        for (const root of this.getRepositoryRoots(true)) {
            const normalized = normalizePath(root);
            if (worktreePaths.has(normalized)) {
                return normalized;
            }
        }
        return undefined;
    }

    private async listWorktreesOf(comparison: RepositoryComparison): Promise<IWorktreeInfo[] | undefined> {
        try {
            return await listWorktrees(comparison.repository);
        } catch (e: any) {
            const msg = 'Listing the worktrees failed';
            this.log(msg, e);
            window.showErrorMessage(`${msg}: ${e.message}`);
            return undefined;
        }
    }

    async switchToWorkingTree(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            window.showErrorMessage('No repository selected');
            return;
        }
        const worktrees = await this.listWorktreesOf(comparison);
        if (!worktrees) {
            return;
        }
        const workspaceRoot = this.findWorkspaceWorktreeRoot(worktrees);
        if (!workspaceRoot) {
            window.showErrorMessage('No workspace repository found');
            return;
        }
        if (workspaceRoot === comparison.repoRoot) {
            return;
        }
        await this.showWorktree(workspaceRoot, workspaceRoot);
    }

    async promptChangeWorktree(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            window.showErrorMessage('No repository selected');
            return;
        }

        const worktrees = await this.listWorktreesOf(comparison);
        if (!worktrees) {
            return;
        }
        const workspaceRoot = this.findWorkspaceWorktreeRoot(worktrees);

        let picks: RepositoryPickItem[] = worktrees
            .filter(wt => wt.path !== comparison.repoRoot && wt.path !== workspaceRoot)
            .map(wt => new ChangeWorktreeItem(wt));

        picks.sort((a, b) => a.label.localeCompare(b.label));

        if (workspaceRoot && workspaceRoot !== comparison.repoRoot) {
            picks = [new WorkingTreePickItem(workspaceRoot), ...picks];
        }

        if (picks.length === 0) {
            window.showInformationMessage('No other worktrees available');
            return;
        }

        const choice = await window.showQuickPick(picks, { placeHolder: 'Select a worktree' });
        if (!choice) {
            return;
        }
        await this.showWorktree(choice.repositoryPath, workspaceRoot);
    }

    /**
     * Displays a checkout of a repository. In the repository-node layout the
     * repository keeps its node and only the checkout it shows changes, because
     * the nodes are the workspace repositories. Otherwise the view as a whole
     * switches to that checkout.
     */
    private async showWorktree(worktreeRoot: string, workspaceRoot: string | undefined) {
        if (!this.showRepositoryNodes()) {
            await this.changeRepository(worktreeRoot);
            return;
        }
        if (!workspaceRoot) {
            window.showErrorMessage('No workspace repository found');
            return;
        }
        const key = normalizePath(workspaceRoot);
        const previousRoot = this.displayedRoot(workspaceRoot);
        if (normalizePath(worktreeRoot) === key) {
            this.worktreeOverrides.delete(key);
        } else {
            this.worktreeOverrides.set(key, normalizePath(worktreeRoot));
            try {
                // Surfaces load errors here rather than as an empty node.
                await this.loadComparison(worktreeRoot);
            } catch (e: any) {
                this.worktreeOverrides.delete(key);
                const msg = 'Changing the worktree failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
                return;
            }
        }
        // The previous checkout is no longer shown in the tree, so a commits
        // binding pointing at it would leave both its commit list and any filter
        // it applied unreachable.
        if (this.commitsRepoRoot !== undefined &&
                normalizePath(this.commitsRepoRoot) === previousRoot &&
                previousRoot !== this.displayedRoot(workspaceRoot)) {
            this.bindCommitsTo(this.displayedRoot(workspaceRoot));
        }
        this.updateViewState();
        this.fireTreeDataChange();
    }

    async promptChangeRepository() {
        const activeRoot = this.activeComparison?.repoRoot;
        const gitRepos = this.getRepositoryRoots();
        const gitReposWithoutCurrent = gitRepos.filter(
            root => (this.rootAliases.get(root) ?? root) !== activeRoot);
        const picks = gitReposWithoutCurrent.map(r => new ChangeRepositoryItem(r));
        const placeHolder = 'Select a repository';
        const choice = await window.showQuickPick<ChangeRepositoryItem>(picks, { placeHolder });

        if (!choice) {
            return;
        }

        await this.changeRepository(choice.repositoryRoot);
    }

    private async handleRepositoryOpened(repository: GitAPIRepository) {
        // Subscribe before awaiting so that a close arriving in the meantime
        // disposes the subscription instead of leaving it behind.
        this.watchRepositoryUi(repository);
        if (!this.showRepositoryNodes() && this.activeComparison === undefined) {
            await this.changeRepository(repository.rootUri.fsPath);
        } else {
            this.updateViewState();
            this.fireTreeDataChange();
        }
    }

    private watchRepositoryUi(repository: GitAPIRepository) {
        const repoRoot = normalizePath(repository.rootUri.fsPath);
        this.repositoryUiSubscriptions.get(repoRoot)?.dispose();
        this.repositoryUiSubscriptions.set(repoRoot,
            repository.ui.onDidChange(() => this.handleRepositoryUiChange(repository)));
    }

    private async handleRepositoryUiChange(repository: GitAPIRepository) {
        if (!this.autoChangeRepository || !repository.ui.selected) {
            return;
        }
        // Following the SCM selection is meaningless when all repositories are
        // shown side by side.
        if (this.showRepositoryNodes()) {
            return;
        }
        const repoRoot = normalizePath(repository.rootUri.fsPath);
        const inWorkspace = getGitRepositoryFolders(this.gitApi).map(normalizePath).includes(repoRoot);
        if (!inWorkspace) {
            const active = this.activeComparison;
            const worktrees = active ? await listWorktrees(active.repository) : [];
            if (!worktrees.some(wt => wt.path === repoRoot)) {
                return;
            }
        }
        if (repoRoot === this.activeComparison?.repoRoot) {
            return;
        }
        this.log(`SCM repository change detected - changing repository: ${repoRoot}`);
        await this.changeRepository(repoRoot);
    }

    private isRelevantChange(uri: Uri): boolean {
        if (uri.scheme != 'file') {
            return false;
        }
        // non-git change
        if (!/\/\.git\//.test(uri.path) && !/\/\.git$/.test(uri.path)) {
            return true;
        }
        // git ref change (including linked worktrees)
        if (/\/\.git\/(?:worktrees\/[^/]+\/)?refs\//.test(uri.path) && !/\/\.git\/refs\/remotes\/.+\/actions/.test(uri.path)) {
            return true;
        }
        // git HEAD change, e.g. on branch switch (including linked worktrees)
        if (/\/\.git\/(?:worktrees\/[^/]+\/)?HEAD$/.test(uri.path)) {
            return true;
        }
        // git index change (including linked worktrees)
        if (/\/\.git\/(?:worktrees\/[^/]+\/)?index$/.test(uri.path)) {
            return true;
        }
        this.log(`Ignoring irrelevant change: ${uri.fsPath}`);
        return false;
    }

    /**
     * Watches repositories that the workspace-wide watcher does not cover:
     * repositories outside the workspace, and git dirs that live outside their
     * repository root (linked worktrees).
     */
    private addExtraRepositoryWatcher(comparison: RepositoryComparison) {
        if (this.extraRepositoryWatchers.has(comparison.repoRoot)) {
            return;
        }
        const watchers: Disposable[] = [];
        const subscriptions: Disposable[] = [];
        const watch = (folder: string) => {
            const watcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.file(folder), '**'));
            watchers.push(watcher);
            const onWorkspaceChange = anyEvent(watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete);
            const onRelevantWorkspaceChange = filterEvent(onWorkspaceChange, uri => this.isRelevantChange(uri));
            subscriptions.push(onRelevantWorkspaceChange(this.handleWorkspaceChange, this));
        };

        if (comparison.isOutsideWorkspace) {
            watch(comparison.repoRoot);
        }
        const normalizedGitDir = normalizePath(comparison.absGitDir);
        if (normalizedGitDir !== comparison.repoRoot && !normalizedGitDir.startsWith(comparison.repoRoot + path.sep)) {
            watch(comparison.absGitDir);
        }

        if (watchers.length === 0) {
            return;
        }
        this.extraRepositoryWatchers.set(comparison.repoRoot, Disposable.from(...watchers, ...subscriptions));
    }

    private disposeExtraRepositoryWatchers() {
        for (const watcher of this.extraRepositoryWatchers.values()) {
            watcher.dispose();
        }
        this.extraRepositoryWatchers.clear();
    }

    /** Forgets a comparison and everything attached to it. */
    private removeComparison(comparison: RepositoryComparison) {
        this.invalidateComparisonCreations();
        const repoRoot = comparison.repoRoot;
        const previousCommitsComparison = this.commitsComparison;
        this.comparisons.delete(repoRoot);
        this.extraRepositoryWatchers.get(repoRoot)?.dispose();
        this.extraRepositoryWatchers.delete(repoRoot);
        this.pendingRefreshRoots.delete(repoRoot);
        this.reportedLoadErrors.delete(repoRoot);
        for (const [alias, canonical] of [...this.rootAliases]) {
            if (canonical === repoRoot) {
                this.rootAliases.delete(alias);
            }
        }
        if (this.activeComparison === comparison) {
            this.activeComparison = undefined;
        }
        if (previousCommitsComparison === comparison) {
            // The commits list was showing this repository; drop the binding so it
            // falls back instead of keeping the removed repository's commits, whose
            // hashes would otherwise be applied to whatever comparison takes over.
            this.commitsRepoRoot = undefined;
            this._onDidChangeComparison.fire();
        }
    }

    /** Drops comparisons for repositories that are no longer in the workspace. */
    private pruneComparisons() {
        const liveRoots = new Set(this.getRepositoryRoots().map(root => this.rootAliases.get(root) ?? root));
        for (const workspaceRoot of [...this.worktreeOverrides.keys()]) {
            if (!liveRoots.has(this.rootAliases.get(workspaceRoot) ?? workspaceRoot)) {
                this.worktreeOverrides.delete(workspaceRoot);
            }
        }
        const displayedWorktrees = new Set(this.worktreeOverrides.values());
        for (const [repoRoot, comparison] of [...this.comparisons]) {
            // Repositories outside the workspace (linked worktrees) never appear
            // in the workspace repository list, so keep them while they are active
            // or displayed by a repository node.
            const keep = liveRoots.has(repoRoot) || displayedWorktrees.has(repoRoot) ||
                (comparison === this.activeComparison && comparison.isOutsideWorkspace);
            if (keep) {
                continue;
            }
            this.removeComparison(comparison);
        }
    }

    private async handleRepositoryClosed(repository: GitAPIRepository) {
        // Also invalidates a creation that has not published its comparison yet.
        this.invalidateComparisonCreations();
        const repoRoot = normalizePath(repository.rootUri.fsPath);
        this.repositoryUiSubscriptions.get(repoRoot)?.dispose();
        this.repositoryUiSubscriptions.delete(repoRoot);
        const comparison = this.getExistingComparison(repository.rootUri.fsPath);
        if (comparison) {
            this.removeComparison(comparison);
        }
        if (!this.showRepositoryNodes() && !this.activeComparison) {
            const gitRepos = this.getRepositoryRoots(true);
            if (gitRepos.length > 0) {
                await this.changeRepository(gitRepos[0]);
            } else {
                await this.unsetRepository();
            }
            return;
        }
        this.updateViewState();
        this.fireTreeDataChange();
    }

    private async handleWorkspaceFoldersChanged(e: WorkspaceFoldersChangeEvent) {
        if (e.removed.length > 0) {
            this.invalidateComparisonCreations();
            this.pruneComparisons();
        }

        // A repository can be covered by several workspace folders. If the one
        // that was used as tree root got removed, the comparison survives but
        // has to fall back to another folder of the same repository.
        const staleComparisons: RepositoryComparison[] = [];
        for (const comparison of this.comparisons.values()) {
            const workspaceFolder = this.pickWorkspaceFolder(
                comparison.repoRoot, comparison.isOutsideWorkspace);
            if (workspaceFolder === comparison.workspaceFolder) {
                continue;
            }
            comparison.workspaceFolder = workspaceFolder;
            const treeRootChanged = comparison.updateTreeRootFolder();
            // Comparisons that have not been loaded yet pick up the new tree
            // root when they are first expanded.
            if (treeRootChanged && comparison.isLoaded) {
                staleComparisons.push(comparison);
            }
        }
        for (const comparison of staleComparisons) {
            try {
                await comparison.updateDiff(false);
            } catch (e: any) {
                this.log('Updating the git tree failed', e);
                comparison.clearFiles();
            }
        }

        if (!this.showRepositoryNodes()) {
            // If the repository that was active got removed, or none was
            // selected yet, then pick an arbitrary new one.
            const active = this.activeComparison;
            if (!active || !this.comparisons.has(active.repoRoot)) {
                this.activeComparison = undefined;
                const gitRepos = this.getRepositoryRoots(true);
                if (gitRepos.length > 0) {
                    await this.changeRepository(gitRepos[0]);
                    return;
                }
                if (e.removed.length > 0) {
                    await this.unsetRepository();
                    return;
                }
            }
        }

        if (e.removed.length > 0 || e.added.length > 0) {
            this.updateViewState();
            this.fireTreeDataChange();
        }
    }

    private async handleChangeCheckboxState(e: TreeCheckboxChangeEvent<Element>) {
        for (let [element, state] of e.items) {
            if (element instanceof FileElement || element instanceof FolderElement) {
                const comparison = this.getExistingComparison(element.repositoryRoot);
                if (!comparison) {
                    continue;
                }
                comparison.checkboxStates.set(element.dstAbsPath, {
                    state: state,
                    timestamp: Date.now()
                });
            }
        }
        if (this.hideCheckedFiles) {
            this._onDidChangeTreeData.fire();
        }
    }

    private handleActiveEditorChange(editor: TextEditor | undefined) {
        if (!this.autoReveal || !editor || !this.treeView.visible) {
            return;
        }
        const uri = editor.document.uri;
        if (uri.scheme !== 'file') {
            return;
        }
        const fileElement = this.elementMap.get(uri.fsPath);
        if (fileElement) {
            this.treeView.reveal(fileElement, { select: true, focus: false }).then(undefined, () => {
                // Element may not be in the tree (e.g. not yet expanded), ignore
            });
        }
    }

    log(msg: string, error: Error | undefined=undefined) {
        if (error) {
            console.warn(msg, error);
            msg = `${msg}: ${error.message}`;
        }
        this.outputChannel.appendLine(msg);
    }

    private readConfig() {
        const config = workspace.getConfiguration(NAMESPACE);
        this.treeRootIsRepo = config.get<string>('root') === 'repository';
        this.includeFilesOutsideWorkspaceFolderRoot = config.get<boolean>('includeFilesOutsideWorkspaceRoot', true);
        this.openChangesOnSelect = config.get<boolean>('openChanges', true);
        this.autoChangeRepository = config.get<boolean>('autoChangeRepository', false);
        this.multiRepositoryView = config.get<boolean>('multiRepositoryView', false);
        this.autoRefresh = config.get<boolean>('autoRefresh', true);
        this.iconsMinimal = config.get<boolean>('iconsMinimal', false);
        this.iconStyle = config.get<IconStyle>('iconStyle', 'status');
        this.fullDiff = config.get<string>('diffMode') === 'full';
        this.detectStackBaseBranch = config.get<boolean>('detectStackBaseBranch', true);
        this.findRenames = config.get<boolean>('findRenames', true);
        this.renameThreshold = config.get<number>('renameThreshold', 50);
        this.showCollapsed = config.get<boolean>('collapsed', false);
        this.compactFolders = config.get<boolean>('compactFolders', false);
        this.showCheckboxes = config.get<boolean>('showCheckboxes', false);
        this.resetCheckboxOnFileChange = config.get<boolean>('resetCheckboxOnFileChange', false);
        this.omitUntrackedFiles = config.get<boolean>('omitUntrackedFiles', false);
        this.omitUnstagedChanges = config.get<boolean>('omitUnstagedChanges', false);
        this.sortOrder = config.get<SortOrder>('sortOrder', 'path');
        this.autoReveal = config.get<boolean>('autoReveal', true);
        this.showDiffStats = config.get<boolean>('showDiffStats', false);
    }

    getTreeItem(element: Element): TreeItem {
        const comparison = this.getExistingComparison(element.repositoryRoot);
        let checkboxState: TreeItemCheckboxState | undefined;
        if (this.showCheckboxes && comparison) {
            if (element instanceof FileElement) {
                const stateInfo = comparison.checkboxStates.get(element.dstAbsPath);
                checkboxState = stateInfo?.state ?? TreeItemCheckboxState.Unchecked;
            } else if (element instanceof FolderElement) {
                // Compute folder state from children: checked if all children are checked
                checkboxState = this.computeFolderCheckboxState(comparison, element);
            }
        }
        const item = toTreeItem(element, this.openChangesOnSelect, this.iconsMinimal, this.iconStyle, this.showCollapsed, this.viewAsList, this.showDiffStats, checkboxState, this.asAbsolutePath);
        if (this.collapseGeneration > 0 && element instanceof FolderElement) {
            item.collapsibleState = TreeItemCollapsibleState.Collapsed;
            item.id = getElementId(element) + '#c' + this.collapseGeneration;
        }
        return item;
    }

    getParent(element: Element): Element | undefined {
        const id = getElementId(element);
        return this.parentMap.get(id);
    }

    private computeFolderCheckboxState(comparison: RepositoryComparison, folder: FolderElement): TreeItemCheckboxState {
        // Check if user explicitly set state on this folder
        const explicitState = comparison.checkboxStates.get(folder.dstAbsPath);
        if (explicitState) {
            return explicitState.state;
        }

        // Otherwise derive from files: folder is checked only if ALL files under it are checked
        const files = folder.useFilesOutsideTreeRoot ? comparison.filesOutsideTreeRoot : comparison.filesInsideTreeRoot;
        let hasFiles = false;
        let allChecked = true;

        for (const [folderPath, fileEntries] of files.entries()) {
            // Check if this folder is under the target folder
            if (folderPath === folder.dstAbsPath || folderPath.startsWith(folder.dstAbsPath + path.sep)) {
                for (const file of fileEntries) {
                    hasFiles = true;
                    const stateInfo = comparison.checkboxStates.get(file.dstAbsPath);
                    if (!stateInfo || stateInfo.state !== TreeItemCheckboxState.Checked) {
                        allChecked = false;
                        break;
                    }
                }
                if (!allChecked) break;
            }
        }

        return (hasFiles && allChecked) ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked;
    }

    private hasFiles(comparison: RepositoryComparison): boolean {
        return comparison.filesInsideTreeRoot.size > 0 ||
            (this.includeFilesOutsideWorkspaceFolderRoot && comparison.filesOutsideTreeRoot.size > 0);
    }

    async getChildren(element?: Element): Promise<Element[]> {
        if (!element) {
            this.updateViewState();
            if (this.showRepositoryNodes()) {
                const roots = this.getRepositoryRoots(true);
                // Repositories are labelled by folder name, which is not unique
                // across checkouts, so disambiguate collisions with the parent.
                const nameCounts = new Map<string, number>();
                for (const root of roots) {
                    const name = path.basename(root);
                    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
                }
                return roots.map(root => {
                    const name = path.basename(root);
                    const ambiguous = (nameCounts.get(name) ?? 0) > 1;
                    const displayed = this.displayedRoot(root);
                    const isWorktree = displayed !== normalizePath(root);
                    // A repository showing a linked worktree is labelled with
                    // that worktree, which is more useful than the parent
                    // folder used to disambiguate equal repository names.
                    const description = isWorktree
                        ? path.basename(displayed)
                        : (ambiguous ? path.basename(path.dirname(root)) : undefined);
                    return new RepositoryElement(displayed, name, true, description, isWorktree);
                });
            }
            const comparison = this.activeComparison;
            if (!comparison) {
                return [];
            }
            try {
                // Retries if a previous load failed.
                await comparison.ensureLoaded();
            } catch (e: any) {
                this.log('Ignoring error during initial getChildren()', e);
                return [];
            }
            // RefElement is the root, no parent to record
            return [new RefElement(comparison.repoRoot, comparison.baseRef, this.hasFiles(comparison))];
        } else if (element instanceof RepositoryElement) {
            const comparison = await this.loadComparison(element.repositoryRoot);
            if (!comparison) {
                return [];
            }
            const children = [new RefElement(comparison.repoRoot, comparison.baseRef, this.hasFiles(comparison))];
            this.recordParents(element, children);
            return children;
        } else if (element instanceof RefElement) {
            const comparison = await this.loadComparison(element.repositoryRoot);
            if (!comparison) {
                return [];
            }
            const entries: Element[] = [];
            if (this.includeFilesOutsideWorkspaceFolderRoot && comparison.filesOutsideTreeRoot.size > 0) {
                entries.push(new RepoRootElement(comparison.repoRoot, comparison.repoRoot));
            }
            const children = entries.concat(this.getFileSystemEntries(comparison, comparison.treeRoot, false));
            this.recordParents(element, children);
            return children;
        } else if (element instanceof FolderElement) {
            const comparison = await this.loadComparison(element.repositoryRoot);
            if (!comparison) {
                return [];
            }
            const children = this.getFileSystemEntries(comparison, element.dstAbsPath, element.useFilesOutsideTreeRoot);
            this.recordParents(element, children);
            return children;
        }
        assert.fail("unsupported element type");
        return [];
    }

    private recordParents(parent: Element, children: Element[]) {
        for (const child of children) {
            this.parentMap.set(getElementId(child), parent);
            if (child instanceof FileElement) {
                this.elementMap.set(child.dstAbsPath, child);
            }
        }
    }

    private handleWorkspaceChange(uri: Uri) {
        if (!this.autoRefresh) {
            return
        }
        const comparison = this.findComparisonForPath(uri.fsPath);
        if (!comparison) {
            // Either the change is outside every known repository, or it belongs
            // to a repository that has not been opened in the tree yet, in which
            // case there is no diff to refresh.
            this.log(`Ignoring change outside of repositories: ${uri.fsPath}`)
            return;
        }
        this.pendingRefreshRoots.add(comparison.repoRoot);
        if (comparison === this.commitsComparison) {
            // Notify dependents (e.g. the commits list) about the relevant change before
            // the visibility-gated refresh below, so they can update on their own schedule
            // even while the main tree is hidden.
            this._onDidChangeRepository.fire();
        }
        if (this.pendingRefreshTimer) {
            clearTimeout(this.pendingRefreshTimer);
        }
        this.pendingRefreshTimer = setTimeout(() => {
            this.pendingRefreshTimer = undefined;
            void this.processPendingRefreshes();
        }, 2000);
    }

    /**
     * Refreshes all repositories with pending changes. Entries are only removed
     * once they are actually processed, and a second invocation while one is
     * already running is a no-op, so a burst of changes while the window is in
     * the background cannot drop a repository's only pending refresh.
     */
    private async processPendingRefreshes() {
        if (this.refreshInProgress) {
            return;
        }
        this.refreshInProgress = true;
        try {
            while (this.pendingRefreshRoots.size > 0 && !this.disposed) {
                if (!window.state.focused || !this.treeView.visible) {
                    await this.waitUntilFocusedAndVisible();
                    continue;
                }
                const repoRoot = this.pendingRefreshRoots.values().next().value as FolderAbsPath;
                this.pendingRefreshRoots.delete(repoRoot);
                const comparison = this.comparisons.get(repoRoot);
                if (!comparison) {
                    continue;
                }
                this.log(`Relevant workspace change detected: ${repoRoot}`)
                await this.refreshComparison(comparison);
            }
        } finally {
            this.refreshInProgress = false;
        }
    }

    private async waitUntilFocusedAndVisible(): Promise<void> {
        const onDidFocusWindow = filterEvent(window.onDidChangeWindowState, e => e.focused);
        const onDidBecomeVisible = filterEvent(this.treeView.onDidChangeVisibility, e => e.visible);
        const onDidFocusWindowOrBecomeVisible = anyEvent<any>(onDidFocusWindow, onDidBecomeVisible);
        await eventToPromise(onDidFocusWindowOrBecomeVisible);
    }

    private async refreshComparison(comparison: RepositoryComparison, showErrors=false) {
        try {
            if (await comparison.isHeadChanged()) {
                // make sure merge base is updated when switching branches
                await comparison.updateRefs(comparison.baseRef);
            }
            await comparison.updateDiff(true);
        } catch (e: any) {
            // some error occured, ignore and try again next time
            let msg = 'Updating the git tree failed';
            this.log(msg, e);
            if (showErrors) {
                window.showErrorMessage(`${msg}: ${e.message}`);
            }
        }
    }

    private async handleConfigChange() {
        const oldTreeRootIsRepo = this.treeRootIsRepo;
        const oldInclude = this.includeFilesOutsideWorkspaceFolderRoot;
        const oldOpenChangesOnSelect = this.openChangesOnSelect;
        const oldAutoRefresh = this.autoRefresh;
        const oldIconsMinimal = this.iconsMinimal;
        const oldIconStyle = this.iconStyle;
        const oldFullDiff = this.fullDiff;
        const oldDetectStackBaseBranch = this.detectStackBaseBranch;
        const oldFindRenames = this.findRenames;
        const oldRenameThreshold = this.renameThreshold;
        const oldCompactFolders = this.compactFolders;
        const oldshowCheckboxes = this.showCheckboxes;
        const oldOmitUntrackedFiles = this.omitUntrackedFiles;
        const oldOmitUnstagedChanges = this.omitUnstagedChanges;
        const oldSortOrder = this.sortOrder;
        const oldMultiRepositoryView = this.multiRepositoryView;
        const oldShowDiffStats = this.showDiffStats;
        this.readConfig();
        if (oldshowCheckboxes && !this.showCheckboxes && this.hideCheckedFiles) {
            this.hideCheckedFiles = false;
            commands.executeCommand('setContext', NAMESPACE + '.hideCheckedFiles', false);
        }
        if (oldTreeRootIsRepo != this.treeRootIsRepo ||
            oldInclude != this.includeFilesOutsideWorkspaceFolderRoot ||
            oldOpenChangesOnSelect != this.openChangesOnSelect ||
            oldMultiRepositoryView != this.multiRepositoryView ||
            oldIconsMinimal != this.iconsMinimal ||
            oldIconStyle != this.iconStyle ||
            (!oldAutoRefresh && this.autoRefresh) ||
            oldFullDiff != this.fullDiff ||
            oldDetectStackBaseBranch != this.detectStackBaseBranch ||
            oldFindRenames != this.findRenames ||
            oldRenameThreshold != this.renameThreshold ||
            oldCompactFolders != this.compactFolders ||
            oldshowCheckboxes != this.showCheckboxes ||
            oldOmitUntrackedFiles != this.omitUntrackedFiles ||
            oldOmitUnstagedChanges != this.omitUnstagedChanges ||
            oldSortOrder != this.sortOrder ||
            oldShowDiffStats != this.showDiffStats) {

            if (oldMultiRepositoryView != this.multiRepositoryView) {
                // The layout changed, start from a clean slate.
                this.invalidateComparisonCreations();
                this.activeComparison = undefined;
                this.comparisons.clear();
                this.rootAliases.clear();
                this.reportedLoadErrors.clear();
                this.pendingRefreshRoots.clear();
                this.disposeExtraRepositoryWatchers();
                if (!this.showRepositoryNodes()) {
                    const gitRepos = this.getRepositoryRoots(true);
                    if (gitRepos.length > 0) {
                        await this.changeRepository(gitRepos[0]);
                    } else {
                        await this.unsetRepository();
                    }
                    return;
                }
                this.updateViewState();
                this.fireTreeDataChange();
                return;
            }

            const needsReload =
                oldFullDiff != this.fullDiff ||
                oldDetectStackBaseBranch != this.detectStackBaseBranch ||
                oldFindRenames != this.findRenames ||
                oldRenameThreshold != this.renameThreshold ||
                (!oldAutoRefresh && this.autoRefresh) ||
                oldOmitUntrackedFiles != this.omitUntrackedFiles ||
                oldOmitUnstagedChanges != this.omitUnstagedChanges ||
                oldShowDiffStats != this.showDiffStats;

            // Only repositories that have already been loaded need updating.
            // The rest pick up the new settings when they are first expanded.
            for (const comparison of [...this.comparisons.values()]) {
                const treeRootChanged = oldTreeRootIsRepo != this.treeRootIsRepo &&
                    comparison.updateTreeRootFolder();
                if (!needsReload && !treeRootChanged) {
                    continue;
                }
                try {
                    await comparison.updateRefs(comparison.baseRef);
                    await comparison.updateDiff(false);
                } catch (e: any) {
                    let msg = 'Updating the git tree failed';
                    this.log(msg, e);
                    window.showErrorMessage(`${msg}: ${e.message}`);
                    // clear the tree as it would be confusing to display stale data under the new settings
                    comparison.clearFiles();
                }
            }
            this.updateViewState();
            this.fireTreeDataChange();
        }
    }

    private matchesFilter(comparison: RepositoryComparison, filePath: string, relPathBase: string): boolean {
        if (!comparison.searchFilter) {
            return true;
        }
        const fileName = path.basename(filePath);
        const relativePath = path.relative(relPathBase, filePath);
        const searchLower = comparison.searchFilter.toLowerCase();
        return fileName.toLowerCase().includes(searchLower) ||
               relativePath.toLowerCase().includes(searchLower);
    }

    private isFileCheckboxChecked(comparison: RepositoryComparison, dstAbsPath: string): boolean {
        const stateInfo = comparison.checkboxStates.get(dstAbsPath);
        return stateInfo?.state === TreeItemCheckboxState.Checked;
    }

    /** Whether this file row should appear in the tree (search + optional hide-checked). */
    private fileVisibleInTree(comparison: RepositoryComparison, dstAbsPath: string, relPathBase: string): boolean {
        if (!this.matchesFilter(comparison, dstAbsPath, relPathBase)) {
            return false;
        }
        if (this.hideCheckedFiles && this.isFileCheckboxChecked(comparison, dstAbsPath)) {
            return false;
        }
        return true;
    }

    private folderHasMatchingFiles(comparison: RepositoryComparison, folder: string, useFilesOutsideTreeRoot: boolean): boolean {
        if (!comparison.searchFilter && !this.hideCheckedFiles) {
            return true;
        }
        const files = useFilesOutsideTreeRoot ? comparison.filesOutsideTreeRoot : comparison.filesInsideTreeRoot;
        const relPathBase = useFilesOutsideTreeRoot ? comparison.repoRoot : comparison.treeRoot;

        for (const [folderPath, fileEntries] of files.entries()) {
            if (folderPath === folder || folderPath.startsWith(folder + path.sep)) {
                for (const file of fileEntries) {
                    if (this.fileVisibleInTree(comparison, file.dstAbsPath, relPathBase)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private getFileSystemEntries(comparison: RepositoryComparison, folder: string, useFilesOutsideTreeRoot: boolean): FileSystemElement[] {
        const entries: FileSystemElement[] = [];
        const files = useFilesOutsideTreeRoot ? comparison.filesOutsideTreeRoot : comparison.filesInsideTreeRoot;
        const relPathBase = useFilesOutsideTreeRoot ? comparison.repoRoot : comparison.treeRoot;

        if (this.viewAsList) {
            // add files of direct and nested subfolders
            const folders: string[] = [];
            for (const folder2 of files.keys()) {
                if (folder2.startsWith(folder + path.sep)) {
                    folders.push(folder2);
                }
            }
            // TODO sorting should be folder-aware to match SCM view
            folders.sort((a, b) => a.localeCompare(b));
            for (const folder2 of folders) {
                const fileEntries = files.get(folder2)!;
                for (const file of fileEntries) {
                    if (this.fileVisibleInTree(comparison, file.dstAbsPath, relPathBase)) {
                        const dstRelPath = path.relative(relPathBase, file.dstAbsPath);
                        entries.push(new FileElement(file.srcAbsPath, file.dstAbsPath, dstRelPath, file.status, file.isSubmodule, comparison.repoRoot, file.stats));
                    }
                }
            }
        } else if (this.compactFolders) {
            // add direct subfolders and apply compaction
            for (const folder2 of files.keys()) {
                if (path.dirname(folder2) === folder) {
                    if (!this.folderHasMatchingFiles(comparison, folder2, useFilesOutsideTreeRoot)) {
                        continue;
                    }
                    let compactedPath = folder2;
                    // not very efficient, needs a better data structure
                    outer: while (true) {
                        const hasFiles = files.get(compactedPath)!.length > 0;
                        if (hasFiles) {
                            break;
                        }
                        let subfolder: string | null = null;
                        for (const folder3 of files.keys()) {
                            if (path.dirname(folder3) === compactedPath) {
                                if (subfolder === null) {
                                    subfolder = folder3;
                                } else {
                                    subfolder = null;
                                    break outer;
                                }
                            }
                        }
                        if (subfolder === null) {
                            throw new Error('unexpected');
                        }
                        compactedPath = subfolder;
                    }

                    const label = path.relative(folder, compactedPath);
                    entries.push(new FolderElement(
                        label, compactedPath, useFilesOutsideTreeRoot, comparison.repoRoot));
                }
            }
            entries.sort((a, b) => a.label.split(path.sep, 1)[0].localeCompare(b.label.split(path.sep, 1)[0]));
        } else {
            // add direct subfolders
            for (const folder2 of files.keys()) {
                if (path.dirname(folder2) === folder) {
                    if (this.folderHasMatchingFiles(comparison, folder2, useFilesOutsideTreeRoot)) {
                        const label = path.basename(folder2);
                        entries.push(new FolderElement(
                            label, folder2, useFilesOutsideTreeRoot, comparison.repoRoot));
                    }
                }
            }
            entries.sort((a, b) => path.basename(a.dstAbsPath).localeCompare(path.basename(b.dstAbsPath)));
        }

        // add files of folder
        const fileEntries = files.get(folder);
        // there is no mapping entry if treeRoot!=repoRoot and
        // there are no files within treeRoot, therefore, this is guarded
        if (fileEntries) {
            for (const file of fileEntries) {
                if (this.fileVisibleInTree(comparison, file.dstAbsPath, relPathBase)) {
                    const dstRelPath = path.relative(relPathBase, file.dstAbsPath);
                    entries.push(new FileElement(file.srcAbsPath, file.dstAbsPath, dstRelPath, file.status, file.isSubmodule, comparison.repoRoot, file.stats));
                }
            }
        }

        // Apply sorting logic only for list view and non-path sorting
        // (path sorting uses the existing default logic)
        if (this.viewAsList && this.sortOrder !== 'path') {
            this.applySorting(entries);
        }

        return entries
    }

    private applySorting(entries: FileSystemElement[]) {
        // Separate files from folders (folders should stay at the top)
        const fileElements = entries.filter(e => e instanceof FileElement) as FileElement[];
        const folderElements = entries.filter(e => e instanceof FolderElement);

        // Populate modification dates if sorting by recently modified
        if (this.sortOrder === 'recentlyModified') {
            for (const file of fileElements) {
                try {
                    const stats = fs.statSync(file.dstAbsPath);
                    file.modificationDate = stats.mtime;
                } catch (e) {
                    // If file doesn't exist (e.g., deleted), use epoch
                    file.modificationDate = new Date(0);
                }
            }
        }

        // Sort files based on sort order
        switch (this.sortOrder) {
            case 'name':
                fileElements.sort((a, b) => a.label.localeCompare(b.label));
                break;
            case 'status':
                fileElements.sort((a, b) => {
                    const aOrder = STATUS_SORT_ORDER[a.status] ?? 99;
                    const bOrder = STATUS_SORT_ORDER[b.status] ?? 99;
                    if (aOrder !== bOrder) {
                        return aOrder - bOrder;
                    }
                    // Secondary sort by path
                    return a.dstRelPath.localeCompare(b.dstRelPath);
                });
                break;
            case 'recentlyModified':
                fileElements.sort((a, b) => {
                    const aTime = a.modificationDate?.getTime() ?? 0;
                    const bTime = b.modificationDate?.getTime() ?? 0;
                    // Sort descending (most recent first)
                    if (bTime !== aTime) {
                        return bTime - aTime;
                    }
                    // Secondary sort by path
                    return a.dstRelPath.localeCompare(b.dstRelPath);
                });
                break;
        }

        // Replace entries array with sorted files (folders first, then sorted files)
        entries.length = 0;
        entries.push(...folderElements, ...fileElements);
    }

    /**
     * Resolves the diff status of a file together with the repository it
     * belongs to. Returns undefined when the file is not part of any loaded
     * comparison, so a command can never act on another repository's state.
     */
    private resolveFile(fileEntry?: FileElement): { comparison: RepositoryComparison, status: IDiffStatus } | undefined {
        if (fileEntry) {
            const comparison = this.getExistingComparison(fileEntry.repositoryRoot);
            return comparison ? { comparison, status: fileEntry } : undefined;
        }
        const uri = window.activeTextEditor && window.activeTextEditor.document.uri;
        if (!uri || uri.scheme !== 'file') {
            return;
        }
        const comparison = this.findComparisonForPath(uri.fsPath);
        if (!comparison) {
            return;
        }
        const status = comparison.findFile(uri.fsPath);
        return status ? { comparison, status } : undefined;
    }

    async openChanges(fileEntry?: FileElement) {
        const resolved = this.resolveFile(fileEntry);
        if (!resolved) {
            return;
        }
        const { comparison, status } = resolved;
        await this.doOpenChanges(comparison, status.srcAbsPath, status.dstAbsPath, status.status);
    }

    async doOpenChanges(comparison: RepositoryComparison, srcAbsPath: string, dstAbsPath: string, status: StatusCode,
                        showOptions: TextDocumentShowOptions = {}) {
        const { leftRef, rightRef } = comparison.getDiffEndpoints();
        const right = rightRef === null ? Uri.file(dstAbsPath) : this.gitApi.toGitUri(Uri.file(dstAbsPath), rightRef);
        const left = this.gitApi.toGitUri(Uri.file(srcAbsPath), leftRef);

        const options: TextDocumentShowOptions = { preview: true, ...showOptions };

        if (status === 'U' || status === 'A') {
            return commands.executeCommand('vscode.open', right, options);
        }
        if (status === 'D') {
            return commands.executeCommand('vscode.open', left, options);
        }

        const filename = path.basename(dstAbsPath);
        const rightLabel = rightRef === null ? 'Working Tree' : rightRef.substr(0, 7);
        return await commands.executeCommand('vscode.diff',
            left, right, `${filename} (${rightLabel})`, options);
    }

    async openAllChanges(entry: RefElement | RepoRootElement | FolderElement | RepositoryElement | undefined) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            return;
        }
        const withinFolder = entry instanceof FolderElement ? entry.dstAbsPath : undefined;
        const resources: [Uri, Uri | undefined, Uri | undefined][] = [];
        const { leftRef, rightRef } = comparison.getDiffEndpoints();

        for (const file of comparison.iterFiles(withinFolder)) {
            const right = rightRef === null
                ? Uri.file(file.dstAbsPath)
                : this.gitApi.toGitUri(Uri.file(file.dstAbsPath), rightRef);
            const left = this.gitApi.toGitUri(Uri.file(file.srcAbsPath), leftRef);

            if (file.status === 'A' || file.status === 'U') {
                resources.push([right, undefined, right]);
            } else if (file.status === 'D') {
                resources.push([Uri.file(file.srcAbsPath), left, undefined]);
            } else {
                resources.push([right, left, right]);
            }
        }

        if (resources.length > 0) {
            try {
                await commands.executeCommand('vscode.changes', `Changes against ${comparison.baseRef}`, resources);
            } catch (e: any) {
                const msg = 'Opening all changes failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
            }
        }
    }

    async openFile(fileEntries: FileElement[]) {
        for (const fileEntry of fileEntries) {
            const resolved = this.resolveFile(fileEntry);
            if (resolved) {
                await this.doOpenFile(resolved.comparison, resolved.status.dstAbsPath, resolved.status.status);
            }
        }
    }

    async doOpenFile(comparison: RepositoryComparison, dstAbsPath: string, status: StatusCode, preview=false) {
        const { leftRef, rightRef } = comparison.getDiffEndpoints();
        const right = rightRef === null
            ? Uri.file(dstAbsPath)
            : this.gitApi.toGitUri(Uri.file(dstAbsPath), rightRef);
        const left = this.gitApi.toGitUri(Uri.file(dstAbsPath), leftRef);
        const uri = status === 'D' ? left : right;
        const options: TextDocumentShowOptions = {
            preview: preview
        };
        return commands.executeCommand('vscode.open', uri, options);
    }

    async discardChanges(entries: (FileElement | FolderElement)[]) {
        const statusesByRepository = new Map<RepositoryComparison, IDiffStatus[]>();
        for (const entry of entries) {
            const comparison = this.getExistingComparison(entry.repositoryRoot);
            if (!comparison) {
                continue;
            }
            let statuses = statusesByRepository.get(comparison);
            if (!statuses) {
                statuses = [];
                statusesByRepository.set(comparison, statuses);
            }
            if (entry instanceof FolderElement) {
                statuses.push(...comparison.iterFiles(entry.dstAbsPath));
            } else {
                statuses.push(entry);
            }
        }
        for (const [comparison, statuses] of statusesByRepository) {
            await this.doDiscardChanges(comparison, statuses);
        }
    }

    async discardAllChanges(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            return;
        }
        await this.doDiscardChanges(comparison, [...comparison.iterFiles()]);
    }

    async doDiscardChanges(comparison: RepositoryComparison, statuses: IDiffStatus[]) {
        if (statuses.length === 0) {
            return;
        }
        // Discarding writes to the working tree, which is not what a commit range shows.
        if (comparison.commitFilter.kind !== 'all') {
            window.showInformationMessage(
                'Discarding changes is only available in the full comparison. Select all commits first.');
            return;
        }
        const actions: Function[] = [];
        const prompts: [string, string][] = [];
        const uncommittedChanges: string[] = [];

        for (const diffStatus of statuses) {
            const filename = path.basename(diffStatus.dstAbsPath);
            if (diffStatus.status === 'U') {
                uncommittedChanges.push(filename);
                prompts.push([
                    `Do you really want to DELETE ${filename}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.`,
                    'Delete File'
                ]);
                actions.push(async () => {
                    fs.unlinkSync(diffStatus.dstAbsPath);
                });
            } else if (diffStatus.status === 'A') {
                const dirty = await hasUncommittedChanges(comparison.repository, diffStatus.dstAbsPath);
                let msg = `Do you really want to delete ${filename}?`;
                if (dirty) {
                    uncommittedChanges.push(filename);
                    msg = `${msg}\nThis file has UNCOMMITTED changes which will be FOREVER LOST!`;
                }
                prompts.push([msg, 'Delete File']);
                actions.push(async () => {
                    await rmFile(comparison.repository, diffStatus.dstAbsPath);
                });
            } else if (diffStatus.status === 'M' || diffStatus.status === 'D') {
                let msg = `Do you really want to restore ${filename} with the contents from ${comparison.baseRef}?`;
                if (diffStatus.status !== 'D') {
                    const dirty = await hasUncommittedChanges(comparison.repository, diffStatus.dstAbsPath);
                    if (dirty) {
                        uncommittedChanges.push(filename);
                        msg = `${msg}\nThis file has UNCOMMITTED changes which will be FOREVER LOST!`;
                    }
                }
                prompts.push([msg, 'Restore File']);
                actions.push(async () => {
                    await comparison.repository.checkout(comparison.mergeBase, [diffStatus.dstAbsPath]);
                });
            } else if (diffStatus.status === 'R') {
                const srcFolder = path.dirname(diffStatus.srcAbsPath);
                const dstFolder = path.dirname(diffStatus.dstAbsPath);
                let srcFile: string;
                let dstFile: string;
                let verb: string;
                if (srcFolder === dstFolder) {
                    verb = 'rename';
                    srcFile = path.basename(diffStatus.srcAbsPath);
                    dstFile = path.basename(diffStatus.dstAbsPath);
                } else {
                    verb = 'move';
                    const relPathBase = comparison.treeRoot;
                    srcFile = path.relative(relPathBase, diffStatus.srcAbsPath);
                    dstFile = path.relative(relPathBase, diffStatus.dstAbsPath);
                }
                let msg = `Do you really want to ${verb} ${srcFile} to ${dstFile} and restore contents from ${comparison.baseRef}?`;
                const dirty = await hasUncommittedChanges(comparison.repository, diffStatus.dstAbsPath);
                if (dirty) {
                    uncommittedChanges.push(filename);
                    msg = `${msg}\nThis file has UNCOMMITTED changes which will be FOREVER LOST!`;
                }
                prompts.push([msg, 'Restore File']);
                actions.push(async () => {
                    await rmFile(comparison.repository, diffStatus.dstAbsPath);
                    await comparison.repository.checkout(comparison.mergeBase, [diffStatus.srcAbsPath]);
                });
            } else {
                window.showInformationMessage(
                    `Discarding changes for files with git status ${diffStatus.status} is not yet supported.`);
            }
        }

        if (prompts.length === 1) {
            const [msg, btn] = prompts[0];
            const answer = await window.showWarningMessage(
                msg,
                { modal: true },
                btn);
            if (answer !== btn) {
                return;
            }
            actions[0]();
        } else {
            let msg = `Are you sure you want to discard changes in ${prompts.length} files?`;
            if (uncommittedChanges.length > 0) {
                msg = `${msg}\n\nThe following files have UNCOMMITTED changes which will be FOREVER LOST:\n` +
                    uncommittedChanges.map(f => `${f}`).join('\n');
            }
            const btn = 'Discard Changes';
            const answer = await window.showWarningMessage(
                msg,
                { modal: true },
                btn);
            if (answer !== btn) {
                return;
            }
            for (const action of actions) {
                await action();
            }
        }
    }

    async openChangedFiles(entry: RefElement | RepoRootElement | FolderElement | RepositoryElement | undefined) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            return;
        }
        const withinFolder = entry instanceof FolderElement ? entry.dstAbsPath : undefined;
        for (const file of comparison.iterFiles(withinFolder)) {
            if (file.status == 'D') {
                continue;
            }
            this.doOpenFile(comparison, file.dstAbsPath, file.status, false);
        }
    }

    async promptChangeBase(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            window.showErrorMessage('No repository selected');
            return;
        }
        const commit = new ChangeBaseCommitItem();
        const sortOrder = workspace.getConfiguration(NAMESPACE).get<'alphabetically' | 'committerdate'>('refSortOrder', 'committerdate');
        const refs = (await comparison.repository.getRefs({ sort: sortOrder })).filter(ref => ref.name);
        const heads = refs.filter(ref => ref.type === RefType.Head).map(ref => new ChangeBaseRefItem(ref));
        const tags = refs.filter(ref => ref.type === RefType.Tag).map(ref => new ChangeBaseTagItem(ref));
        const remoteHeads = refs.filter(ref => ref.type === RefType.RemoteHead).map(ref => new ChangeBaseRemoteHeadItem(ref));
        const picks = [commit, ...heads, ...tags, ...remoteHeads];

        const placeHolder = 'Select a ref to use as comparison base';
        const choice = await window.showQuickPick<QuickPickItem>(picks, { placeHolder });

        if (!choice) {
            return;
        }

        let baseRef: string;

        if (choice instanceof ChangeBaseRefItem) {
            baseRef = choice.ref.name!;
        } else if (choice instanceof ChangeBaseCommitItem) {
            const commitInput = await window.showInputBox({
                prompt: 'Enter a commit hash to use as comparison base',
                placeHolder: 'Commit hash'
            })
            if (!commitInput) {
                return;
            }
            baseRef = commitInput;
        } else {
            throw new Error("unsupported item type");
        }

        if (comparison.baseRef === baseRef) {
            return;
        }
        window.withProgress({ location: ProgressLocation.Window, title: 'Updating Tree Base' }, async _ => {
            try {
                await comparison.updateRefs(baseRef);
            } catch (e: any) {
                let msg = 'Updating the git tree base failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
                return;
            }
            try {
                await comparison.updateDiff(false);
            } catch (e: any) {
                let msg = 'Updating the git tree failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
                // clear the tree as it would be confusing to display the old tree under the new base
                comparison.clearFiles();
            }
            this.log('Refreshing tree');
            this.fireTreeDataChange();
        });
    }

    async compareGitHubPullRequest(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            window.showErrorMessage('No repository selected');
            return;
        }

        const repository = comparison.repository;

        // Check for uncommitted changes (ignoring untracked files)
        try {
            if (await hasUncommittedChanges(repository, repository.root, true)) {
                window.showErrorMessage(
                    'Please commit your changes or stash them before continuing.',
                    { modal: true }
                );
                    return;
            }
        } catch (e: any) {
            this.log('Error checking for uncommitted changes', e);
            // Continue anyway
        }

        // Prompt for PR URL
        const prUrl = await window.showInputBox({
            prompt: 'Enter GitHub Pull Request URL',
            placeHolder: 'https://github.com/owner/repo/pull/123',
            validateInput: (value: string) => {
                const match = value.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
                if (!match) {
                    return 'Invalid GitHub PR URL. Expected format: https://github.com/owner/repo/pull/123';
                }
                return null;
            }
        });

        if (!prUrl) {
            return;
        }

        // Parse the PR URL
        const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
        if (!match) {
            window.showErrorMessage('Invalid GitHub PR URL format');
            return;
        }

        const [, owner, repo, prNumberStr] = match;
        const prNumber = parseInt(prNumberStr, 10);

        await window.withProgress({
            location: ProgressLocation.Notification,
            title: `Fetching PR #${prNumber} from ${owner}/${repo}`,
            cancellable: false
        }, async () => {
            try {
                // Authenticate with GitHub
                const session = await authentication.getSession('github', ['repo'], { createIfNone: true });
                const octokit = new Octokit({ auth: session.accessToken });

                // Fetch PR details
                this.log(`Fetching PR details for ${owner}/${repo}#${prNumber}`);
                const { data: pr } = await octokit.pulls.get({
                    owner,
                    repo,
                    pull_number: prNumber
                });

                // Extract base and head information
                const baseRef = pr.base.ref;
                const headRef = pr.head.ref;
                const headSha = pr.head.sha;

                this.log(`PR #${prNumber}: base=${baseRef}, head=${headRef}, sha=${headSha}`);

                // Fetch the PR branch if it's from a fork
                const headRepo = pr.head.repo;
                if (!headRepo) {
                    window.showErrorMessage('Cannot access PR head repository. It may have been deleted.');
                    return;
                }

                const headRepoUrl = headRepo.clone_url;
                const isFork = headRepo.full_name !== pr.base.repo.full_name;

                // Find which local remote points to the base repo (may not be 'origin')
                const baseCloneUrl = pr.base.repo.clone_url;
                const baseSshUrl = pr.base.repo.ssh_url;
                const normalizeRemoteUrl = (u: string) => u.toLowerCase().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
                const remotes = await repository.getRemotes();
                const baseRemoteName = remotes.find(r => {
                    const url = normalizeRemoteUrl(r.fetchUrl || r.pushUrl || '');
                    return url === normalizeRemoteUrl(baseCloneUrl) || url === normalizeRemoteUrl(baseSshUrl);
                })?.name ?? 'origin';

                // Extract head owner for branch naming
                const headOwner = pr.head.user?.login || pr.head.repo?.owner.login;
                if (!headOwner) {
                    window.showErrorMessage('Could not determine PR head owner.');
                    return;
                }

                // Create a local branch name for the PR with owner and ref name
                const localBranchName = `pr/${prNumber}/${headOwner}/${headRef}`;

                // Fetch and create/update local branch for the PR
                try {
                    if (isFork) {
                        // For forks, add a remote with pr-fork- prefix
                        const forkRemoteName = `pr-fork-${headOwner}`;
                        
                        this.log(`Fetching PR #${prNumber} from fork owned by ${headOwner}: ${headRepoUrl}`);
                        
                        // Check if remote already exists, if not add it
                        try {
                            const existingUrl = (await repository.exec(['remote', 'get-url', forkRemoteName])).stdout.trim();
                            // Update URL if it's different
                            if (existingUrl !== headRepoUrl) {
                                await repository.exec(['remote', 'set-url', forkRemoteName, headRepoUrl]);
                                this.log(`Updated remote ${forkRemoteName} URL to ${headRepoUrl}`);
                            }
                        } catch {
                            await repository.exec(['remote', 'add', forkRemoteName, headRepoUrl]);
                            this.log(`Added remote ${forkRemoteName}`);
                        }
                        
                        // Fetch the head ref from the fork
                        await repository.fetch({ remote: forkRemoteName, ref: headRef });
                        
                        // Create/update local branch pointing to the fetched commit
                        try {
                            // Try to create new branch
                            await repository.exec(['branch', localBranchName, headSha]);
                        } catch {
                            // Branch exists, force update it
                            await repository.exec(['branch', '-f', localBranchName, headSha]);
                        }
                        
                        // Set upstream to the fork remote
                        await repository.exec(['branch', '--set-upstream-to', `${forkRemoteName}/${headRef}`, localBranchName]);
                        
                        this.log(`Created local branch ${localBranchName} tracking ${forkRemoteName}/${headRef}`);
                    } else {
                        // For same repo, use GitHub's pull/<id>/head refspec
                        this.log(`Fetching PR #${prNumber} from ${baseRemoteName}`);
                        await repository.exec(['fetch', baseRemoteName, `pull/${prNumber}/head:${localBranchName}`]);
                        
                        // Set upstream to <remote>/<headRef> if the branch exists there
                        try {
                            // Fetch the actual head ref to update the remote tracking branch
                            await repository.fetch({ remote: baseRemoteName, ref: headRef });
                            await repository.exec(['branch', '--set-upstream-to', `${baseRemoteName}/${headRef}`, localBranchName]);
                            this.log(`Created local branch ${localBranchName} tracking ${baseRemoteName}/${headRef}`);
                        } catch {
                            this.log(`Created local branch ${localBranchName} (no upstream - ${baseRemoteName}/${headRef} not found)`);
                        }
                    }
                } catch (e: any) {
                    let msg = 'Failed to fetch and create PR branch';
                    this.log(msg, e);
                    window.showErrorMessage(`${msg}: ${e.message}`);
                    return;
                }

                // Checkout the local PR branch
                try {
                    this.log(`Checking out branch: ${localBranchName}`);
                    await repository.checkout(localBranchName, []);
                } catch (e: any) {
                    let msg = 'Failed to checkout PR branch';
                    this.log(msg, e);
                    window.showErrorMessage(`${msg}: ${e.message}`);
                    return;
                }

                // Update the comparison base to the PR base branch (use origin/* to avoid stale refs)
                try {
                    const originBaseRef = `origin/${baseRef}`;
                    this.log(`Updating base to: ${originBaseRef}`);
                    await comparison.updateRefs(originBaseRef);
                    await comparison.updateDiff(false);
                    this.log('Refreshing tree');
                    this.fireTreeDataChange();
                    window.showInformationMessage(`Now comparing PR #${prNumber}: ${pr.title}`);
                } catch (e: any) {
                    let msg = 'Failed to update comparison base';
                    this.log(msg, e);
                    window.showErrorMessage(`${msg}: ${e.message}`);
                    return;
                }
            } catch (e: any) {
                let msg = 'Failed to fetch GitHub PR';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message || e}`);
            }
        });
    }

    async manualRefresh(entry?: RefElement | RepositoryElement) {
        const repositoryRoot = await this.resolveRepositoryRoot(entry);
        if (!repositoryRoot) {
            window.showErrorMessage('No repository selected');
            return;
        }
        await window.withProgress({ location: ProgressLocation.Window, title: 'Updating Tree' }, async _ => {
            await this.refreshOrLoadComparison(repositoryRoot);
        });
    }

    private async refreshOrLoadComparison(repositoryRoot: string): Promise<void> {
        const comparison = this.getExistingComparison(repositoryRoot);
        if (comparison?.isLoaded) {
            await this.refreshComparison(comparison, true);
            return;
        }
        // The initial load already computes refs and the complete diff. Do not
        // immediately run a second refresh when Refresh races tree expansion.
        if (await this.loadComparison(repositoryRoot)) {
            this.fireTreeDataChange();
        }
    }

    async manualRefreshAll() {
        if (!this.showRepositoryNodes()) {
            await this.manualRefresh(undefined);
            return;
        }
        await window.withProgress({ location: ProgressLocation.Window, title: 'Updating Tree' }, async _ => {
            for (const repoRoot of this.getRepositoryRoots(true)) {
                await this.refreshOrLoadComparison(repoRoot);
            }
            this.fireTreeDataChange();
        });
    }

    async switchToMergeDiff() {
        const config = workspace.getConfiguration(NAMESPACE);
        await config.update('diffMode', 'merge', true);
    }

    async switchToFullDiff() {
        const config = workspace.getConfiguration(NAMESPACE);
        await config.update('diffMode', 'full', true);
    }

    async hideCheckboxes(v: boolean) {
        const config = workspace.getConfiguration(NAMESPACE);
        await config.update('showCheckboxes', !v, true);
    }

    viewAsTree(v: boolean) {
        const viewAsList = !v;
        if (viewAsList === this.viewAsList)
            return;
        this.viewAsList = viewAsList;
        commands.executeCommand('setContext', NAMESPACE + '.viewAsList', viewAsList);
        this.log('Refreshing tree');
        this._onDidChangeTreeData.fire();
    }

    setHideCheckedFiles(hide: boolean) {
        if (hide === this.hideCheckedFiles) {
            return;
        }
        this.hideCheckedFiles = hide;
        commands.executeCommand('setContext', NAMESPACE + '.hideCheckedFiles', hide);
        this.log('Refreshing tree');
        this.fireTreeDataChange();
    }

    async sortByName() {
        const config = workspace.getConfiguration(NAMESPACE);
        await config.update('sortOrder', 'name', true);
    }

    async sortByPath() {
        const config = workspace.getConfiguration(NAMESPACE);
        await config.update('sortOrder', 'path', true);
    }

    async sortByStatus() {
        const config = workspace.getConfiguration(NAMESPACE);
        await config.update('sortOrder', 'status', true);
    }

    async sortByRecentlyModified() {
        const config = workspace.getConfiguration(NAMESPACE);
        await config.update('sortOrder', 'recentlyModified', true);
    }

    async collapseAll() {
        this.collapseGeneration++;
        this.fireTreeDataChange();
    }

    /**
     * Builds a workspace search include pattern for a file.
     *
     * Patterns have to use forward slashes, and have to be anchored with `./`
     * and qualified with the workspace folder in multi-root workspaces.
     * A bare relative path would otherwise also match the same path inside
     * every other workspace folder.
     */
    private toSearchPattern(absPath: string): string | undefined {
        const folder = workspace.getWorkspaceFolder(Uri.file(absPath));
        if (!folder) {
            return undefined;
        }
        const relPath = path.relative(folder.uri.fsPath, absPath).split(path.sep).join('/');
        if (!relPath || relPath.startsWith('../')) {
            return undefined;
        }
        const multiRoot = (workspace.workspaceFolders?.length ?? 0) > 1;
        // In multi-root workspaces the first segment is matched against the
        // workspace folder name, which can be overridden in a .code-workspace
        // file and is therefore not always the directory basename.
        return multiRoot ? `./${folder.name}/${relPath}` : `./${relPath}`;
    }

    async searchChanges(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            return;
        }
        const files = [...comparison.iterFiles()];
        const patterns: string[] = [];
        for (const file of files) {
            const pattern = this.toSearchPattern(file.dstAbsPath);
            if (pattern) {
                patterns.push(pattern);
            }
        }
        if (patterns.length === 0) {
            window.showInformationMessage(files.length === 0
                ? 'No changed files to search.'
                : 'No changed files inside the workspace to search.');
            return;
        }
        if (patterns.length < files.length) {
            this.log(`Excluding ${files.length - patterns.length} changed file(s) outside the workspace from search`);
        }
        await commands.executeCommand('workbench.action.findInFiles', {
            query: '',
            filesToInclude: patterns.join(','),
            triggerSearch: true
        });
    }

    async filterFiles(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison) {
            return;
        }
        const searchTerm = await window.showInputBox({
            prompt: 'Enter text to filter files (leave empty to show all)',
            placeHolder: 'Filter by filename or path...',
            value: comparison.searchFilter || ''
        });

        if (searchTerm === undefined) {
            return;
        }

        comparison.searchFilter = searchTerm.trim() || undefined;
        this.updateViewState();
        this.log(comparison.searchFilter ? `Filtering files by: ${comparison.searchFilter}` : 'Cleared file filter');
        this.fireTreeDataChange();
    }

    async clearFilter(entry?: RefElement | RepositoryElement) {
        const comparison = await this.resolveComparison(entry);
        if (!comparison || !comparison.searchFilter) {
            return;
        }
        comparison.searchFilter = undefined;
        this.updateViewState();
        this.log('Cleared file filter');
        this.fireTreeDataChange();
    }

    async copyPath(fileEntry: FileElement) {
        const resolved = this.resolveFile(fileEntry);
        if (!resolved) {
            return;
        }
        await env.clipboard.writeText(resolved.status.dstAbsPath);
    }

    async copyRelativePath(fileEntry: FileElement) {
        const resolved = this.resolveFile(fileEntry);
        if (!resolved) {
            return;
        }
        // Calculate relative path from workspace folder root (not git repo root)
        // Note: If the file is outside the workspace folder, the path will start with ../
        const relativePath = path.relative(resolved.comparison.workspaceFolder, resolved.status.dstAbsPath);
        await env.clipboard.writeText(relativePath);
    }

    async openChangesWithDifftool(fileEntry: FileElement) {
        const resolved = this.resolveFile(fileEntry);
        if (!resolved) {
            return;
        }
        const { comparison, status: diffStatus } = resolved;

        const { dstAbsPath, status } = diffStatus;

        // For deleted files, we can't show a diff since the file doesn't exist in the working tree
        if (status === 'D') {
            window.showInformationMessage('Cannot open difftool for deleted files.');
            return;
        }

        // For added/untracked files, there's no base version to compare against
        if (status === 'U' || status === 'A') {
            window.showInformationMessage('Cannot open difftool for untracked or newly added files that are not in the base commit.');
            return;
        }

        // Calculate relative path from repository root
        const dstRelPath = path.relative(comparison.repository.root, dstAbsPath);

        // For modified files, use git difftool with the active comparison endpoints
        // (merge base vs working tree by default, or the selected commit range).
        const { leftRef, rightRef } = comparison.getDiffEndpoints();
        const args = ['difftool', '--no-prompt', leftRef];
        if (rightRef !== null) {
            args.push(rightRef);
        }
        args.push('--', dstRelPath);

        try {
            // Execute git difftool - this will launch the external tool
            await comparison.repository.exec(args);
        } catch (error: any) {
            const errorMessage = error.stderr || error.message || 'Unknown error';
            // Check for common error patterns indicating difftool is not configured
            // Note: Error messages may vary across Git versions and locales
            if (errorMessage.includes('diff.tool') || errorMessage.includes('not configured') || errorMessage.includes('difftool') && errorMessage.includes('unknown')) {
                window.showErrorMessage(
                    'Git difftool is not configured. Please configure your diff tool in Git settings (e.g., git config --global diff.tool <tool-name>).',
                );
            } else {
                window.showErrorMessage(`Failed to open difftool: ${errorMessage}`);
            }
            this.log(`Failed to open difftool: ${errorMessage}`);
        }
    }

    dispose(): void {
        this.disposed = true;
        this.invalidateComparisonCreations();
        this.disposeExtraRepositoryWatchers();
        for (const subscription of this.repositoryUiSubscriptions.values()) {
            subscription.dispose();
        }
        this.repositoryUiSubscriptions.clear();
        this.disposables.forEach(d => d.dispose());
    }
}

function getElementId(element: Element): string {
    const repositoryRoot = element.repositoryRoot;
    if (element instanceof RepositoryElement) {
        return `repo:${repositoryRoot}`;
    }
    if (element instanceof RefElement) {
        return `ref:${repositoryRoot}`;
    } else if (element instanceof RepoRootElement) {
        return `root:${repositoryRoot}`;
    } else {
        return `${repositoryRoot}:${element.dstAbsPath}`;
    }
}

function formatDiffStats(stats: IDiffStats): string {
    if (stats.isBinary) {
        return 'binary';
    }
    const parts: string[] = [];
    if (stats.insertions !== undefined && stats.insertions > 0) {
        parts.push(`+${stats.insertions}`);
    }
    if (stats.deletions !== undefined && stats.deletions > 0) {
        parts.push(`-${stats.deletions}`);
    }
    return parts.join(' ');
}

class GitTreeCompareFileDecorationProvider implements FileDecorationProvider {
    provideFileDecoration(uri: Uri): ProviderResult<FileDecoration> {
        if (uri.scheme !== TREE_RESOURCE_SCHEME || !isStatusCode(uri.query)) {
            return undefined;
        }
        return new FileDecoration(getStatusBadge(uri.query), getStatusText(uri.query), getStatusColor(uri.query));
    }
}

function toTreeItem(element: Element, openChangesOnSelect: boolean, iconsMinimal: boolean,
                    iconStyle: IconStyle, showCollapsed: boolean, viewAsList: boolean, showDiffStats: boolean,
                    checkboxState: TreeItemCheckboxState | undefined,
                    asAbsolutePath: (relPath: string) => string): TreeItem {
    const gitIconRoot = asAbsolutePath('resources/git-icons');
    if (element instanceof FileElement) {
        const statsText = showDiffStats && element.stats ? formatDiffStats(element.stats) : '';
        const displayLabel = statsText ? `${element.label}  ${statsText}` : element.label;
        const item = new TreeItem(displayLabel);
        // In fileTheme mode the status is already shown via the file decoration
        // tooltip, so avoid mentioning it twice.
        const statusText = iconStyle === 'fileTheme' ? '' : getStatusText(element.status);
        item.tooltip = statusText ? `${element.dstAbsPath} • ${statusText}` : element.dstAbsPath;
        if (element.srcAbsPath !== element.dstAbsPath) {
            item.tooltip = `${element.srcAbsPath} → ${item.tooltip}`;
        }
        if (statsText) {
            item.tooltip = `${item.tooltip} • ${statsText}`;
        }
        if (viewAsList) {
            item.description = path.dirname(element.dstRelPath);
            if (item.description === '.') {
                item.description = '';
            }
        }
        item.contextValue = element.isSubmodule ? 'submodule' : 'file';
        item.id = getElementId(element);
        if (iconStyle === 'fileTheme') {
            item.resourceUri = toTreeResourceUri(element.dstAbsPath, element.status);
            item.iconPath = ThemeIcon.File;
        } else {
            item.iconPath = path.join(gitIconRoot, toIconName(element.status) + '.svg');
        }
        if (checkboxState !== undefined) {
            item.checkboxState = checkboxState;
        }
        if (!element.isSubmodule) {
            const command = openChangesOnSelect ? 'openChanges' : 'openFile';
            item.command = {
                command: NAMESPACE + '.' + command,
                arguments: [element],
                title: ''
            };
        }
        return item;
    } else if (element instanceof RepoRootElement) {
        const item = new TreeItem(element.label, TreeItemCollapsibleState.Collapsed);
        item.tooltip = element.dstAbsPath;
        item.contextValue = 'root';
        item.id = getElementId(element);
        if (!iconsMinimal) {
            if (iconStyle === 'fileTheme') {
                item.resourceUri = toTreeResourceUri(element.dstAbsPath);
                item.iconPath = ThemeIcon.Folder;
            } else {
                item.iconPath = new ThemeIcon('folder-opened');
            }
        }
        return item;
    } else if (element instanceof RepositoryElement) {
        // Repository sections stay expanded. The collapsed setting applies to
        // folders inside each repository, not to the repository itself.
        const state = element.hasChildren ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None;
        const item = new TreeItem(element.label, state);
        item.description = element.description;
        item.tooltip = element.repositoryRoot;
        item.contextValue = 'repo';
        item.id = getElementId(element);
        if (!iconsMinimal) {
            // Matches VS Code's Source Control view, which marks worktrees with
            // a dedicated icon.
            item.iconPath = new ThemeIcon(element.isWorktree ? 'worktree' : 'repo');
        }
        return item;
    } else if (element instanceof FolderElement) {
        const item = new TreeItem(element.label, showCollapsed ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.Expanded);
        item.tooltip = element.dstAbsPath;
        item.contextValue = 'folder';
        item.id = getElementId(element);
        if (checkboxState !== undefined) {
            item.checkboxState = checkboxState;
        }
        if (!iconsMinimal) {
            if (iconStyle === 'fileTheme') {
                item.resourceUri = toTreeResourceUri(element.dstAbsPath);
                item.iconPath = ThemeIcon.Folder;
            } else {
                item.iconPath = new ThemeIcon('folder-opened');
            }
        }
        return item;
    } else if (element instanceof RefElement) {
        const label = element.refName;
        const state = element.hasChildren ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None;
        const item = new TreeItem(label, state);
        item.tooltip = `${element.refName} (${path.basename(element.repositoryRoot)})`;
        item.contextValue = 'ref';
        item.id = getElementId(element);
        if (!iconsMinimal) {
            item.iconPath = new ThemeIcon('git-compare');
        }
        return item;
    }
    throw new Error('unsupported element type');
}

/**
 * Resolves the file system path a diff editor URI refers to, for both working tree
 * (`file:`) and git object (`git:`) URIs.
 */
function uriToAbsPath(uri: Uri): string | undefined {
    if (uri.scheme === 'file') {
        return uri.fsPath;
    }
    if (uri.scheme === 'git') {
        try {
            const params = JSON.parse(uri.query);
            if (params && typeof params.path === 'string') {
                return params.path;
            }
        } catch {
            // not a git URI we can interpret
        }
    }
    return undefined;
}

function toTreeResourceUri(absPath: string, status?: StatusCode): Uri {
    return Uri.file(absPath).with({ scheme: TREE_RESOURCE_SCHEME, query: status });
}

function toIconName(status: StatusCode) {
    switch(status) {
        case 'U': return 'status-untracked';
        case 'A': return 'status-added';
        case 'D': return 'status-deleted';
        case 'M': return 'status-modified';
        case 'C': return 'status-conflict';
        case 'T': return 'status-typechange';
        case 'R': return 'status-renamed';
    }
}

function isStatusCode(status: string): status is StatusCode {
    return status === 'U' || status === 'A' || status === 'D' || status === 'M' || status === 'C' || status === 'T' || status === 'R';
}

function getStatusText(status: StatusCode) {
    switch(status) {
        case 'U': return 'Untracked';
        case 'A': return 'Added';
        case 'D': return 'Deleted';
        case 'M': return 'Modified';
        case 'C': return 'Conflict';
        case 'T': return 'Type changed';
        case 'R': return 'Renamed';
    }
}

function getStatusBadge(status: StatusCode) {
    return status === 'C' ? '!' : status;
}

function getStatusColor(status: StatusCode): ThemeColor {
    switch(status) {
        case 'U': return new ThemeColor('gitDecoration.untrackedResourceForeground');
        case 'A': return new ThemeColor('gitDecoration.addedResourceForeground');
        case 'D': return new ThemeColor('gitDecoration.deletedResourceForeground');
        case 'M': return new ThemeColor('gitDecoration.modifiedResourceForeground');
        case 'C': return new ThemeColor('gitDecoration.conflictingResourceForeground');
        case 'T': return new ThemeColor('gitDecoration.modifiedResourceForeground');
        case 'R': return new ThemeColor('gitDecoration.renamedResourceForeground');
    }
}

function sortedArraysEqual<T> (a: T[], b: T[]): boolean {
    if (a.length != b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
