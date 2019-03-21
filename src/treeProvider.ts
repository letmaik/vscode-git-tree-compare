import * as assert from 'assert'
import * as path from 'path'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState,
         Uri, Disposable, EventEmitter, Event, TextDocumentShowOptions,
         QuickPickItem, ProgressLocation, Memento, OutputChannel,
         workspace, commands, window, WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode'
import { NAMESPACE } from './constants'
import { Repository, Ref, RefType, Git } from './git/git'
import { anyEvent, filterEvent, eventToPromise } from './git/util'
import { toGitUri } from './git/uri'
import { getDefaultBranch, getMergeBase, getHeadModificationDate, getBranchCommit,
         diffIndex, IDiffStatus, StatusCode, getAbsGitDir, getAbsGitCommonDir,
         getWorkspaceFolders, getGitRepositoryFolders } from './gitHelper'
import { debounce, throttle } from './git/decorators'
import { openSync } from 'fs';

class FileElement implements IDiffStatus {
    constructor(public absPath: string, public status: StatusCode, public isSubmodule: boolean) {}
}

class FolderElement {
    constructor(public absPath: string, public useFilesOutsideTreeRoot: boolean) {}
}

class RepoRootElement extends FolderElement {
    constructor(public absPath: string) {
        super(absPath, true);
    }
}

class RefElement {
    constructor(public repositoryRoot: string, public refName: string, public hasChildren: boolean) {}
}

export type Element = FileElement | FolderElement | RepoRootElement | RefElement
type FileSystemElement = FileElement | FolderElement

class ChangeBaseRefItem implements QuickPickItem {
	protected get shortCommit(): string { return (this.ref.commit || '').substr(0, 8); }
	get label(): string { return this.ref.name!; }
	get description(): string { return this.shortCommit; }

	constructor(public ref: Ref) { }
}

class ChangeBaseTagItem extends ChangeBaseRefItem {
	get description(): string {
		return "Tag at " + this.shortCommit;
	}
}

class ChangeBaseRemoteHeadItem extends ChangeBaseRefItem {
	get description(): string {
		return "Remote branch at " + this.shortCommit;
	}
}

class ChangeBaseCommitItem implements QuickPickItem {
	get label(): string { return "$(git-commit) Custom commit"; }
	get description(): string { return ""; }
}

class ChangeRepositoryItem implements QuickPickItem {
    constructor(public repositoryRoot: string) { }

	get label(): string { return path.basename(this.repositoryRoot); }
	get description(): string { return this.repositoryRoot; }
}

type FolderAbsPath = string;

export class GitTreeCompareProvider implements TreeDataProvider<Element>, Disposable {

    private _onDidChangeTreeData: EventEmitter<Element | undefined> = new EventEmitter<Element | undefined>();
    readonly onDidChangeTreeData: Event<Element | undefined> = this._onDidChangeTreeData.event;

    private treeRootIsRepo: boolean;
    private includeFilesOutsideWorkspaceFolderRoot: boolean;
    private openChangesOnSelect: boolean;
    private autoRefresh: boolean;
    private iconsMinimal: boolean;
    private fullDiff: boolean;

    private workspaceFolder: WorkspaceFolder;
    private repository: Repository | undefined;
    private absGitDir: string;
    private absGitCommonDir: string;

    private treeRoot: FolderAbsPath;
    private repoRoot: FolderAbsPath;
    private filesInsideTreeRoot: Map<FolderAbsPath, IDiffStatus[]>;
    private filesOutsideTreeRoot: Map<FolderAbsPath, IDiffStatus[]>;
    
    private readonly loadedFolderElements: Map<FolderAbsPath, FolderElement> = new Map();

    private headLastChecked: Date;
    private headName: string | undefined;
    private headCommit: string;
    private baseRef: string;
    private mergeBase: string;

    private readonly disposables: Disposable[] = [];

    constructor(private readonly git: Git, private readonly outputChannel: OutputChannel, private readonly workspaceState: Memento) {
        this.readConfig();
        this.disposables.push(workspace.onDidChangeConfiguration(this.handleConfigChange, this));

        this.disposables.push(workspace.onDidChangeWorkspaceFolders(this.handleWorkspaceFoldersChanged, this));

        const fsWatcher = workspace.createFileSystemWatcher('**');
        this.disposables.push(fsWatcher);

        const onWorkspaceChange = anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
        const onNonGitChange = filterEvent(onWorkspaceChange, uri => !/\/\.git\//.test(uri.path) && !/\/\.git$/.test(uri.path));
        const onGitRefsChange = filterEvent(onWorkspaceChange, uri => /\/\.git\/refs\//.test(uri.path));

        const onRelevantWorkspaceChange = anyEvent(onNonGitChange, onGitRefsChange);
        this.disposables.push(onRelevantWorkspaceChange(this.handleWorkspaceChange, this));
    }

    async setRepository(repositoryRoot: string) {
        this.repository = this.git.open(repositoryRoot);
        this.repoRoot = path.normalize(this.repository.root);
        this.absGitDir = await getAbsGitDir(this.repository);
        this.absGitCommonDir = await getAbsGitCommonDir(this.repository);
        const workspaceFolders = getWorkspaceFolders(this.repoRoot);
        // Sort descending by folder depth
        workspaceFolders.sort((a, b) => {
            const aDepth = a.uri.fsPath.split(path.sep).length;
            const bDepth = b.uri.fsPath.split(path.sep).length;
            return bDepth - aDepth;
        });
        // If repo appears in multiple workspace folders, pick the deepest one.
        // TODO let the user choose which one
        this.workspaceFolder = workspaceFolders[0];
        this.updateTreeRootFolder();
        this.log('Using repository: ' + this.repoRoot);
    }

    async unsetRepository() {
        this.repository = undefined;
        this._onDidChangeTreeData.fire();
        this.log('No repository selected');
    }

    async changeRepository(repositoryRoot: string) {
        try {
            await this.setRepository(repositoryRoot);
            await this.updateRefs();
            await this.updateDiff(false);
        } catch (e) {
            let msg = 'Changing the repository failed';
            this.log(msg, e);
            window.showErrorMessage(`${msg}: ${e.message}`);
            return;
        }
        this._onDidChangeTreeData.fire();
    }

    async promptChangeRepository() {
        // TODO cache repo folders to avoid delays
        //      better would be if we could fetch the open repos from the git extension directly
        const gitRepos = await getGitRepositoryFolders(this.git);
        const gitReposWithoutCurrent = gitRepos.filter(w => this.repoRoot !== w);
        const picks = gitReposWithoutCurrent.map(r => new ChangeRepositoryItem(r));
        const placeHolder = 'Select a repository';
        const choice = await window.showQuickPick<ChangeRepositoryItem>(picks, { placeHolder });

        if (!choice) {
            return;
        }

        await this.changeRepository(choice.repositoryRoot);
    }

    private async handleWorkspaceFoldersChanged(e: WorkspaceFoldersChangeEvent) {
        // If the folder got removed that was currently active in the diff,
        // then pick an arbitrary new one.
        for (var removedFolder of e.removed) {
            if (removedFolder.uri.toString() === this.workspaceFolder.uri.toString()) {
                const gitRepos = await getGitRepositoryFolders(this.git);
                if (gitRepos.length > 0) {
                    const newFolder = gitRepos[0];
                    await this.changeRepository(newFolder);
                } else {
                    await this.unsetRepository();
                }
            }
        }
        // If no repository is selected but new folders were added,
        // then pick an arbitrary new one.
        if (!this.repository && e.added) {
            const gitRepos = await getGitRepositoryFolders(this.git);
            if (gitRepos.length > 0) {
                const newFolder = gitRepos[0];
                await this.changeRepository(newFolder);
            }
        }
    }

    private log(msg: string, error: Error | undefined=undefined) {
        if (error) {
            console.warn(msg, error);
            msg = `${msg}: ${error.message}`;
        }
        this.outputChannel.appendLine(msg);
    }

    private updateTreeRootFolder() {
        const repoIsWorkspaceSubfolder = this.repoRoot.startsWith(this.workspaceFolder.uri.fsPath + path.sep);
        if (this.treeRootIsRepo || repoIsWorkspaceSubfolder) {
            this.treeRoot = this.repoRoot;
        } else {
            this.treeRoot = this.workspaceFolder.uri.fsPath;
        }
    }

    private readConfig() {
        const config = workspace.getConfiguration(NAMESPACE);
        this.treeRootIsRepo = config.get<string>('root') === 'repository';
        this.includeFilesOutsideWorkspaceFolderRoot = config.get<boolean>('includeFilesOutsideWorkspaceRoot', true);
        this.openChangesOnSelect = config.get<boolean>('openChanges', true);
        this.autoRefresh = config.get<boolean>('autoRefresh', true);
        this.iconsMinimal = config.get<boolean>('iconsMinimal', false);
        this.fullDiff = config.get<string>('diffMode') === 'full';
    }

    private async getStoredBaseRef(): Promise<string | undefined> {
        let baseRef = this.workspaceState.get<string>('baseRef_' + this.workspaceFolder.name);
        if (baseRef) {
            if (await this.isRefExisting(baseRef)) {
                this.log('Using stored base ref: ' + baseRef);
            } else {
                this.log('Not using non-existant stored base ref: ' + baseRef);
                baseRef = undefined;
            }
        }
        return baseRef;
    }

    private async isRefExisting(refName: string): Promise<boolean> {
        const refs = await this.repository!.getRefs();
        const exists = refs.some(ref => ref.name === refName);
        return exists;
    }

    private updateStoredBaseRef(baseRef: string) {
        this.workspaceState.update('baseRef_' + this.workspaceFolder.name, baseRef);
    }

    getTreeItem(element: Element): TreeItem {
        return toTreeItem(element, this.openChangesOnSelect, this.iconsMinimal);
    }

    async getChildren(element?: Element): Promise<Element[]> {
        if (!element) {
            if (!this.repository) {
                return [];
            }
            if (!this.filesInsideTreeRoot) {
                try {
                    await this.updateDiff(false);
                } catch (e) {
                    // some error occured, ignore and try again next time
                    this.log('Ignoring updateDiff() error during initial getChildren()', e);
                    return [];
                }
            }
            const hasFiles =
                this.filesInsideTreeRoot.size > 0 ||
                (this.includeFilesOutsideWorkspaceFolderRoot && this.filesOutsideTreeRoot.size > 0);

                return [new RefElement(this.repoRoot, this.baseRef, hasFiles)];
        } else if (element instanceof RefElement) {
            const entries: Element[] = [];
            if (this.includeFilesOutsideWorkspaceFolderRoot && this.filesOutsideTreeRoot.size > 0) {
                entries.push(new RepoRootElement(this.repoRoot));
            }
            return entries.concat(this.getFileSystemEntries(this.treeRoot, false));
        } else if (element instanceof FolderElement) {
            this.loadedFolderElements.set(element.absPath, element);
            return this.getFileSystemEntries(element.absPath, element.useFilesOutsideTreeRoot);
        }
        assert(false, "unsupported element type");
        return [];
    }

    private async updateRefs(baseRef?: string): Promise<void>
    {
        this.log('Updating refs');
        try {
            const headLastChecked = new Date();
            const HEAD = await this.repository!.getHEAD();
            // if detached HEAD, then .commit exists, otherwise only .name
            const headName = HEAD.name;
            const headCommit = HEAD.commit || await getBranchCommit(this.absGitCommonDir, HEAD.name!);
            if (baseRef) {
                const exists = await this.isRefExisting(baseRef);
                if (!exists) {
                    // happens when branch was deleted
                    baseRef = undefined;
                }
            }
            if (!baseRef) {
                baseRef = await this.getStoredBaseRef();           
            }
            if (!baseRef) {
                baseRef = await getDefaultBranch(this.repository!, this.absGitCommonDir, HEAD);
            }
            if (!baseRef) {
                if (HEAD.name) {
                    baseRef = HEAD.name;
                } else {
                    // detached HEAD and no default branch was found
                    // pick an arbitrary ref as base, give preference to common refs
                    const refs = await this.repository!.getRefs();
                    const commonRefs = ['origin/master', 'master'];
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
            if (!this.fullDiff && baseRef != HEAD.name) {
                // determine merge base to create more sensible/compact diff
                try {
                    mergeBase = await getMergeBase(this.repository!, HEADref, baseRef);
                } catch (e) {
                    // sometimes the merge base cannot be determined
                    // this can be the case with shallow clones but may have other reasons
                }
            }
            if (this.headName !== headName) {
                this.log(`HEAD ref updated: ${this.headName} -> ${headName}`);
            }
            if (this.headCommit !== headCommit) {
                this.log(`HEAD ref commit updated: ${this.headCommit} -> ${headCommit}`);
            }
            if (this.baseRef !== baseRef) {
                this.log(`Base ref updated: ${this.baseRef} -> ${baseRef}`);
            }
            if (!this.fullDiff && this.mergeBase !== mergeBase) {
                this.log(`Merge base updated: ${this.mergeBase} -> ${mergeBase}`);
            }
            this.headLastChecked = headLastChecked;
            this.headName = headName;
            this.headCommit = headCommit;
            this.baseRef = baseRef;
            this.mergeBase = mergeBase;
            this.updateStoredBaseRef(baseRef);
        } catch (e) {
            throw e;
        }
    }

    @throttle
    private async updateDiff(fireChangeEvents: boolean) {
        if (!this.baseRef) {
            await this.updateRefs();
        }

        const filesInsideTreeRoot = new Map<FolderAbsPath, IDiffStatus[]>();
        const filesOutsideTreeRoot = new Map<FolderAbsPath, IDiffStatus[]>();

        let diff = await diffIndex(this.repository!, this.mergeBase);
        this.log(`${diff.length} diff entries`);

        for (const entry of diff) {
            const folder = path.dirname(entry.absPath);

            const isInsideTreeRoot = folder === this.treeRoot || folder.startsWith(this.treeRoot + path.sep);
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
        }

        // determine folders in the old diff which have changed entries and fire change events
        const minDirtyFolders: string[] = [];
        if (fireChangeEvents) {
            const hasChanged = (folderPath: string, insideTreeRoot: boolean) => {
                const oldFiles = insideTreeRoot ? this.filesInsideTreeRoot : this.filesOutsideTreeRoot;
                const newFiles = insideTreeRoot ? filesInsideTreeRoot : filesOutsideTreeRoot;
                const oldItems = oldFiles.get(folderPath)!.map(f => f.absPath);
                const newItems = newFiles.get(folderPath)!.map(f => f.absPath);
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
            if (treeRootChanged || mustAddOrRemoveRepoRootElement || (filesInsideTreeRoot.size && hasChanged(this.treeRoot, true))) {
                // full refresh
                this.loadedFolderElements.clear();
                this._onDidChangeTreeData.fire();
            } else {
                // collect all folders which had direct changes (not in subfolders)
                const dirtyFoldersInsideTreeRoot: string[] = [];
                const dirtyFoldersOutsideTreeRoot: string[] = [];
                for (const folderPath of this.loadedFolderElements.keys()) {
                    const isTreeRootSubfolder = folderPath.startsWith(this.treeRoot + path.sep);
                    const files = isTreeRootSubfolder ? filesInsideTreeRoot : filesOutsideTreeRoot;
                    const dirtyFolders = isTreeRootSubfolder ? dirtyFoldersInsideTreeRoot : dirtyFoldersOutsideTreeRoot;
                    if (!files.has(folderPath)) {
                        // folder was removed; dirty state will be handled by parent folder
                        this.loadedFolderElements.delete(folderPath);
                    } else if (hasChanged(folderPath, isTreeRootSubfolder)) {
                        dirtyFolders.push(folderPath);
                    }
                }

                // merge all subfolder changes with parent changes to obtain minimal set of change events
                for (const dirtyFolders of [dirtyFoldersInsideTreeRoot, dirtyFoldersOutsideTreeRoot]) {
                    dirtyFolders.sort();
                    let lastAddedFolder = '';
                    for (const dirtyFolder of dirtyFolders) {
                        if (!dirtyFolder.startsWith(lastAddedFolder + path.sep)) {
                            minDirtyFolders.push(dirtyFolder);
                            lastAddedFolder = dirtyFolder;
                        }
                    }
                }

                // clean up old subfolder entries of minDirtyFolders in loadedFolderElements
                // note that the folders in minDirtyFolders are kept so that events can be sent
                // (those entries will be overwritten anyway after the tree update)
                for (const dirtyFolder of minDirtyFolders) {
                    const dirtyPrefix = dirtyFolder + path.sep;
                    for (const loadedFolder of this.loadedFolderElements.keys()) {
                        if (loadedFolder.startsWith(dirtyPrefix)) {
                            this.loadedFolderElements.delete(loadedFolder);
                        }
                    }
                }
            }
        }

        this.filesInsideTreeRoot = filesInsideTreeRoot;
        this.filesOutsideTreeRoot = filesOutsideTreeRoot;

        if (fireChangeEvents) {
            if (minDirtyFolders.length) {
                this.log('Tree changes:');
            } else {
                this.log('No tree changes');
            }
            // send events to trigger tree refresh
            for (const dirtyFolder of minDirtyFolders) {
                this.log('  ' + path.relative(this.repoRoot, dirtyFolder));
                const element = this.loadedFolderElements.get(dirtyFolder);
                assert(element !== undefined)
                this._onDidChangeTreeData.fire(element);
            }
        }
    }

    private async isHeadChanged() {
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
            const headCommit = await getBranchCommit(this.absGitCommonDir, this.headName);
            if (this.headCommit !== headCommit) {
                return true;
            }
        }
        return false;
    }

    @debounce(2000)
    private async handleWorkspaceChange(path: Uri) {
        if (!this.autoRefresh || !this.repository) {
            return
        }
        if (!window.state.focused) {
            const onDidFocusWindow = filterEvent(window.onDidChangeWindowState, e => e.focused);
            await eventToPromise(onDidFocusWindow);
            this.handleWorkspaceChange(path);
            return;
        }
        if (await this.isHeadChanged()) {
            // make sure merge base is updated when switching branches
            try {
                await this.updateRefs(this.baseRef);
            } catch (e) {
                // some error occured, ignore and try again next time
                this.log('Ignoring updateRefs() error during handleWorkspaceChange()', e);
                return;
            }
        }
        try {
            await this.updateDiff(true);
        } catch (e) {
            // some error occured, ignore and try again next time
            this.log('Ignoring updateDiff() error during handleWorkspaceChange()', e);
            return;
        }
    }

    private async handleConfigChange() {
        const oldTreeRootIsRepo = this.treeRootIsRepo;
        const oldInclude = this.includeFilesOutsideWorkspaceFolderRoot;
        const oldOpenChangesOnSelect = this.openChangesOnSelect;
        const oldAutoRefresh = this.autoRefresh;
        const oldIconsMinimal = this.iconsMinimal;
        const oldFullDiff = this.fullDiff;
        this.readConfig();
        if (oldTreeRootIsRepo != this.treeRootIsRepo ||
            oldInclude != this.includeFilesOutsideWorkspaceFolderRoot ||
            oldOpenChangesOnSelect != this.openChangesOnSelect ||
            oldIconsMinimal != this.iconsMinimal ||
            (!oldAutoRefresh && this.autoRefresh) ||
            oldFullDiff != this.fullDiff) {

            if (!this.repository) {
                return;
            }

            if (oldTreeRootIsRepo != this.treeRootIsRepo) {
                this.updateTreeRootFolder();
            }
            
            if (oldFullDiff != this.fullDiff) {
                await this.updateRefs(this.baseRef);
                await this.updateDiff(false);
            }
            this._onDidChangeTreeData.fire();
        }
    }

    private getFileSystemEntries(folder: string, useFilesOutsideTreeRoot: boolean): FileSystemElement[] {
        const entries: FileSystemElement[] = [];
        const files = useFilesOutsideTreeRoot ? this.filesOutsideTreeRoot : this.filesInsideTreeRoot;

        // add direct subfolders
        for (const folder2 of files.keys()) {
            if (path.dirname(folder2) === folder) {
                entries.push(new FolderElement(folder2, useFilesOutsideTreeRoot));
            }
        }

        // add files
        const fileEntries = files.get(folder);
        // there is no mapping entry if treeRoot!=repoRoot and
        // there are no files within treeRoot, therefore, this is guarded
        if (fileEntries) {
            for (const file of fileEntries) {
                entries.push(new FileElement(file.absPath, file.status, file.isSubmodule));
            }
        }

        return entries
    }

    async openChanges(fileEntry: FileElement) {
        await this.doOpenChanges(fileEntry.absPath, fileEntry.status);
    }

    async doOpenChanges(absPath: string, status: StatusCode, preview=true) {
        const right = Uri.file(absPath);
        const left = toGitUri(right, this.mergeBase);

        if (status === 'U' || status === 'A') {
            return commands.executeCommand('vscode.open', right);
        }
        if (status === 'D') {
            return commands.executeCommand('vscode.open', left);
        }

        const options: TextDocumentShowOptions = {
            preview: preview
        };
        const filename = path.basename(absPath);
        await commands.executeCommand('vscode.diff',
            left, right, filename + " (Working Tree)", options);
    }

    openAllChanges() {
        for (let file of this.iterFiles()) {
            this.doOpenChanges(file.absPath, file.status, false);
        }
    }

    async openFile(fileEntry: FileElement) {
        return this.doOpenFile(fileEntry.absPath, fileEntry.status);
    }

    async doOpenFile(absPath: string, status: StatusCode, preview=false) {
        const right = Uri.file(absPath);
        const left = toGitUri(right, this.mergeBase);
        const uri = status === 'D' ? left : right;
        const options: TextDocumentShowOptions = {
            preview: preview
        };
        return commands.executeCommand('vscode.open', uri, options);
    }

    openChangedFiles() {
        for (let file of this.iterFiles()) {
            if (file.status == 'D') {
                continue;
            }
            this.doOpenFile(file.absPath, file.status, false);
        }
    }

    *iterFiles() {
        for (let filesMap of [this.filesInsideTreeRoot, this.filesOutsideTreeRoot]) {
            for (let files of filesMap.values()) {
                for (let file of files) {
                    if (!file.isSubmodule) {
                        yield file;
                    }
                }
            }
        }
    }

    async promptChangeBase() {
        if (!this.repository) {
            window.showErrorMessage('No repository selected');
            return;
        }
        const commit = new ChangeBaseCommitItem();
        const refs = (await this.repository.getRefs()).filter(ref => ref.name);
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
        
        if (this.baseRef === baseRef) {
            return;
        }
        window.withProgress({ location: ProgressLocation.Window, title: 'Updating Tree Base' }, async p => {
            try {
                await this.updateRefs(baseRef);
            } catch (e) {
                let msg = 'Updating the git tree base failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
                return;
            }
            try {
                await this.updateDiff(false);
            } catch (e) {
                let msg = 'Updating the git tree failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
                // clear the tree as it would be confusing to display the old tree under the new base
                this.filesInsideTreeRoot = new Map();
                this.filesOutsideTreeRoot = new Map();
            }
            // manual cleaning necessary as the whole tree is updated
            this.log('Updating full tree');
            this.loadedFolderElements.clear();
            this._onDidChangeTreeData.fire();
        });
    }

    async manualRefresh() {
        window.withProgress({ location: ProgressLocation.Window, title: 'Updating Tree' }, async p => {
            try {
                if (await this.isHeadChanged()) {
                    // make sure merge base is updated when switching branches
                    await this.updateRefs(this.baseRef);
                }
                await this.updateDiff(true);
            } catch (e) {
                let msg = 'Updating the git tree failed';
                this.log(msg, e);
                window.showErrorMessage(`${msg}: ${e.message}`);
            }
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

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

function toTreeItem(element: Element, openChangesOnSelect: boolean, iconsMinimal: boolean): TreeItem {
    const iconRoot = path.join(__dirname, '..', '..', 'resources', 'icons');
    if (element instanceof FileElement) {
        const label = path.basename(element.absPath);
        const item = new TreeItem(label);
        item.tooltip = element.absPath;
        item.contextValue = element.isSubmodule ? 'submodule' : 'file';
        item.id = element.absPath;
        item.iconPath = path.join(iconRoot,	toIconName(element) + '.svg');
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
        const label = '/';
        const item = new TreeItem(label, TreeItemCollapsibleState.Collapsed);
        item.tooltip = element.absPath;
        item.contextValue = 'root';
        item.id = 'root'
        if (!iconsMinimal) {
            item.iconPath = {
                light: path.join(iconRoot, 'light', 'FolderOpen_16x.svg'),
                dark: path.join(iconRoot, 'dark', 'FolderOpen_16x_inverse.svg')
            };
        }
        return item;
    } else if (element instanceof FolderElement) {
        const label = path.basename(element.absPath);
        const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
        item.tooltip = element.absPath;
        item.contextValue = 'folder';
        item.id = element.absPath;
        if (!iconsMinimal) {
            item.iconPath = {
                light: path.join(iconRoot, 'light', 'FolderOpen_16x.svg'),
                dark: path.join(iconRoot, 'dark', 'FolderOpen_16x_inverse.svg')
            };
        }
        return item;
    } else if (element instanceof RefElement) {
        const label = element.refName;
        const state = element.hasChildren ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None;
        const item = new TreeItem(label, state);
        item.tooltip = `${element.refName} (${path.basename(element.repositoryRoot)})`;
        item.contextValue = 'ref';
        item.id = 'ref'
        if (!iconsMinimal) {
            item.iconPath = {
                light: path.join(iconRoot, 'light', 'git-compare.svg'),
                dark: path.join(iconRoot, 'dark', 'git-compare.svg')
            };
        }
        return item;
    }
    throw new Error('unsupported element type');
}

function toIconName(element: FileElement) {
    switch(element.status) {
        case 'U': return 'status-untracked';
        case 'A': return 'status-added';
        case 'D': return 'status-deleted';
        case 'M': return 'status-modified';
        case 'C': return 'status-conflict';
        case 'T': return 'status-typechange';
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
