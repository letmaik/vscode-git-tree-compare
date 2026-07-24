import {
    TreeDataProvider, TreeItem, TreeItemCollapsibleState, EventEmitter, Event,
    Disposable, TreeItemCheckboxState, TreeCheckboxChangeEvent, TreeView, ThemeIcon,
    OutputChannel, MarkdownString, window
} from 'vscode';

import { ICommitInfo, IUncommittedSummary, EMPTY_TREE_ID } from './gitHelper';
import { debounce } from './git/decorators';

/**
 * Describes which diff the main tree should display, derived from the set of
 * checked items in the commits list.
 *  - 'all':   the full comparison (working tree vs base), i.e. the default behaviour.
 *  - 'empty': nothing checked, show no files.
 *  - 'range': a tree-vs-tree or tree-vs-worktree diff between `leftRef` and `rightRef`.
 *             `rightRef === null` means the working tree (used when "Uncommitted Changes"
 *             is part of the selection).
 */
export interface CommitFilterSpec {
    kind: 'all' | 'empty' | 'range';
    leftRef?: string;
    rightRef?: string | null;
}

export function commitFilterSpecEquals(a: CommitFilterSpec, b: CommitFilterSpec): boolean {
    return a.kind === b.kind &&
        (a.leftRef ?? null) === (b.leftRef ?? null) &&
        (a.rightRef ?? null) === (b.rightRef ?? null);
}

export interface ComparisonInfo {
    repoRoot: string;
    mergeBase: string;
    headCommit: string;
}

/**
 * The contract the commits list relies on. Implemented by the main tree provider,
 * which owns the repository and the active comparison.
 */
export interface ComparisonHost {
    readonly onDidChangeComparison: Event<void>;
    // Fired when a relevant working-tree/refs change is detected, independent of whether
    // the main tree is currently visible. Used to auto-refresh the commits list.
    readonly onDidChangeRepository: Event<void>;
    getComparison(): ComparisonInfo | undefined;
    // Updates the cached comparison refs (merge base / HEAD) from git without recomputing
    // the full file diff. Must be called before reading getComparison() on auto-refresh so
    // the commits list picks up new commits even while the main tree is hidden.
    refreshComparison(): Promise<void>;
    getBranchCommits(): Promise<ICommitInfo[]>;
    getUncommittedSummary(): Promise<IUncommittedSummary>;
    setCommitFilter(spec: CommitFilterSpec): Promise<void>;
}

const UNCOMMITTED_ID = 'uncommitted';

export class UncommittedElement {
    constructor(public summary: IUncommittedSummary) {}
}

export class CommitElement {
    constructor(public commit: ICommitInfo) {}
}

export type CommitListElement = UncommittedElement | CommitElement;

function elementId(element: CommitListElement): string {
    return element instanceof CommitElement ? element.commit.hash : UNCOMMITTED_ID;
}

function formatSummary(fileCount: number, insertions: number, deletions: number): string {
    const parts: string[] = [`${fileCount} ${fileCount === 1 ? 'file' : 'files'}`];
    if (insertions > 0) {
        parts.push(`+${insertions}`);
    }
    if (deletions > 0) {
        parts.push(`-${deletions}`);
    }
    return parts.join(' ');
}

export class CommitsTreeProvider implements TreeDataProvider<CommitListElement>, Disposable {

    private _onDidChangeTreeData = new EventEmitter<CommitListElement | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private commits: ICommitInfo[] = [];
    private uncommitted: IUncommittedSummary = { fileCount: 0, insertions: 0, deletions: 0 };

    // id -> checked. Absent means checked (the default state).
    private checked = new Map<string, boolean>();

    // Identifies the current comparison; used to detect when the commit set changed.
    private commitSetKey = '';

    // The view backing this provider; used to gate auto-refresh on visibility.
    private treeView: TreeView<CommitListElement> | undefined;

    private readonly disposables: Disposable[] = [];

    constructor(private readonly host: ComparisonHost, private readonly outputChannel: OutputChannel) {
        this.disposables.push(this.host.onDidChangeComparison(() => {
            this.refresh().catch(e => this.log('Failed to refresh commits list', e));
        }));
        this.disposables.push(this.host.onDidChangeRepository(() => this.scheduleAutoRefresh()));
    }

    init(treeView: TreeView<CommitListElement>) {
        this.treeView = treeView;
        this.disposables.push(treeView.onDidChangeCheckboxState(this.handleCheckboxChange, this));
        // Refresh when the view becomes visible again to catch up on changes that
        // happened while it was hidden.
        this.disposables.push(treeView.onDidChangeVisibility(e => {
            if (e.visible) {
                this.autoRefresh().catch(err => this.log('Failed to refresh commits list on show', err));
            }
        }));
        this.refresh().catch(e => this.log('Failed to initialise commits list', e));
    }

    // Debounced auto-refresh triggered by repository changes. Skips work when the
    // window is unfocused or the view is hidden; the visibility handler refreshes
    // once the view is shown again.
    @debounce(2000)
    private scheduleAutoRefresh() {
        this.autoRefresh().catch(e => this.log('Failed to auto-refresh commits list', e));
    }

    // Brings the comparison refs up to date (so new commits are picked up) and then
    // refreshes the list, but only while the window is focused and the view is visible.
    private async autoRefresh(): Promise<void> {
        if (!window.state.focused || !(this.treeView?.visible ?? false)) {
            return;
        }
        await this.host.refreshComparison();
        await this.refresh();
    }

    private log(msg: string, error?: unknown) {
        if (error) {
            const message = error instanceof Error ? error.message : String(error);
            msg = `${msg}: ${message}`;
        }
        this.outputChannel.appendLine(msg);
    }

    private isChecked(id: string): boolean {
        return this.checked.get(id) ?? true;
    }

    async refresh(): Promise<void> {
        const comparison = this.host.getComparison();
        if (!comparison) {
            this.commits = [];
            this.uncommitted = { fileCount: 0, insertions: 0, deletions: 0 };
            this.commitSetKey = '';
            this._onDidChangeTreeData.fire();
            return;
        }

        const key = `${comparison.mergeBase}..${comparison.headCommit}`;
        const keyChanged = key !== this.commitSetKey;

        if (keyChanged) {
            this.commits = await this.host.getBranchCommits();
            this.commitSetKey = key;
            // A new comparison resets the selection to "all" (everything checked).
            this.checked.clear();
        }
        this.uncommitted = await this.host.getUncommittedSummary();

        this._onDidChangeTreeData.fire();

        if (keyChanged) {
            // Selection was reset; make sure the main tree shows the full comparison.
            // (No-op if the filter is already 'all'.)
            await this.host.setCommitFilter({ kind: 'all' });
        }
    }

    // The list is a single vertical timeline: the "Uncommitted Changes" entry sits
    // on top (newest), followed by the commits newest-first. A selection always maps
    // to a contiguous range of this timeline, so the ids are ordered accordingly.
    private orderedIds(): string[] {
        return [UNCOMMITTED_ID, ...this.commits.map(c => c.hash)];
    }

    // Snaps the current selection to a contiguous block: everything between the
    // topmost and bottommost checked entry becomes checked, everything outside
    // becomes unchecked. This keeps the checkboxes honest about the range that is
    // actually diffed (intermediate commits can't be left out of a range).
    private enforceContiguousSelection(): void {
        const ids = this.orderedIds();
        const checkedIndices = ids
            .map((id, i) => (this.isChecked(id) ? i : -1))
            .filter(i => i >= 0);
        if (checkedIndices.length === 0) {
            return; // nothing checked -> empty selection, leave as-is
        }
        const min = checkedIndices[0];
        const max = checkedIndices[checkedIndices.length - 1];
        ids.forEach((id, i) => {
            this.checked.set(id, i >= min && i <= max);
        });
    }

    private computeSpec(): CommitFilterSpec {
        const total = this.commits.length + 1; // + uncommitted item
        const checkedCommits = this.commits.filter(c => this.isChecked(c.hash));
        const uncommittedChecked = this.isChecked(UNCOMMITTED_ID);
        const checkedCount = checkedCommits.length + (uncommittedChecked ? 1 : 0);

        if (checkedCount === total) {
            return { kind: 'all' };
        }
        if (checkedCount === 0) {
            return { kind: 'empty' };
        }
        if (checkedCommits.length === 0) {
            // Only uncommitted changes: working tree vs HEAD.
            return { kind: 'range', leftRef: 'HEAD', rightRef: null };
        }
        // commits are newest-first, so the first checked is the newest and the last is the oldest.
        const newest = checkedCommits[0];
        const oldest = checkedCommits[checkedCommits.length - 1];
        const leftRef = oldest.parents.length > 0 ? oldest.parents[0] : EMPTY_TREE_ID;
        const rightRef = uncommittedChecked ? null : newest.hash;
        return { kind: 'range', leftRef, rightRef };
    }

    private applyFilter(): Promise<void> {
        return this.host.setCommitFilter(this.computeSpec());
    }

    private async handleCheckboxChange(e: TreeCheckboxChangeEvent<CommitListElement>) {
        for (const [element, state] of e.items) {
            this.checked.set(elementId(element), state === TreeItemCheckboxState.Checked);
        }
        // Fill any gap so the checkboxes always show one contiguous range, then
        // refresh the list to reflect the auto-checked entries.
        this.enforceContiguousSelection();
        this._onDidChangeTreeData.fire();
        await this.applyFilter();
    }

    async selectAll(): Promise<void> {
        this.checked.clear(); // absent => checked
        this._onDidChangeTreeData.fire();
        await this.applyFilter();
    }

    async deselectAll(): Promise<void> {
        this.checked.clear();
        for (const c of this.commits) {
            this.checked.set(c.hash, false);
        }
        this.checked.set(UNCOMMITTED_ID, false);
        this._onDidChangeTreeData.fire();
        await this.applyFilter();
    }

    getTreeItem(element: CommitListElement): TreeItem {
        if (element instanceof CommitElement) {
            const c = element.commit;
            const item = new TreeItem(c.subject || c.shortHash, TreeItemCollapsibleState.None);
            item.id = c.hash;
            item.description = `${c.shortHash}  ${formatSummary(c.fileCount, c.insertions, c.deletions)}`;
            item.iconPath = new ThemeIcon('git-commit');
            item.contextValue = 'commit';
            item.checkboxState = this.isChecked(c.hash) ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked;
            const tooltip = new MarkdownString();
            tooltip.appendMarkdown(`**${escapeMarkdown(c.subject)}**\n\n`);
            tooltip.appendMarkdown(`\`${c.shortHash}\``);
            if (c.authorName) {
                tooltip.appendMarkdown(` &middot; ${escapeMarkdown(c.authorName)}`);
            }
            if (c.authorDate) {
                tooltip.appendMarkdown(` &middot; ${c.authorDate.toLocaleString()}`);
            }
            tooltip.appendMarkdown(`\n\n${formatSummary(c.fileCount, c.insertions, c.deletions)}`);
            item.tooltip = tooltip;
            return item;
        }
        const s = element.summary;
        const item = new TreeItem('Uncommitted Changes', TreeItemCollapsibleState.None);
        item.id = UNCOMMITTED_ID;
        item.description = formatSummary(s.fileCount, s.insertions, s.deletions);
        item.iconPath = new ThemeIcon('source-control');
        item.contextValue = 'uncommitted';
        item.checkboxState = this.isChecked(UNCOMMITTED_ID) ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked;
        item.tooltip = 'Uncommitted changes in the working tree (compared to HEAD)';
        return item;
    }

    async getChildren(element?: CommitListElement): Promise<CommitListElement[]> {
        if (element) {
            return []; // flat list
        }
        if (!this.host.getComparison()) {
            return [];
        }
        const items: CommitListElement[] = [new UncommittedElement(this.uncommitted)];
        for (const c of this.commits) {
            items.push(new CommitElement(c));
        }
        return items;
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}
