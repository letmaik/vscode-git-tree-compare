'use strict';

import * as path from 'path'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState,
	     Uri, Command, Disposable, EventEmitter, Event, TextDocumentShowOptions,
	     workspace, commands } from 'vscode'
import { Repository, Ref } from './git/git'
import { anyEvent, filterEvent } from './git/util'
import { toGitUri } from './git/uri'
import { getParentBranch, diffIndex, IDiffStatus } from './git_helper'
import { debounce } from './git/decorators'

export class GitContextProvider implements TreeDataProvider<FileSystemEntry>, Disposable {

	private _onDidChangeTreeData: EventEmitter<FileSystemEntry | undefined> = new EventEmitter<FileSystemEntry | undefined>();
	readonly onDidChangeTreeData: Event<FileSystemEntry | undefined> = this._onDidChangeTreeData.event;

	private readonly diffFolderMapping: Map<string, IDiffStatus[]> = new Map();

	private baseRef: string;
	private HEAD: Ref;

	private disposables: Disposable[] = [];

	constructor(private repository: Repository) {
		const fsWatcher = workspace.createFileSystemWatcher('**');
		this.disposables.push(fsWatcher);

		// copied from vscode\extensions\git\src\model.ts
		const onWorkspaceChange = anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
		const onGitChange = filterEvent(onWorkspaceChange, uri => /\/\.git\//.test(uri.path));
		const onRelevantGitChange = filterEvent(onGitChange, uri => !/\/\.git\/index\.lock$/.test(uri.path));
		const onNonGitChange = filterEvent(onWorkspaceChange, uri => !/\/\.git\//.test(uri.path));
		const onRelevantWorkspaceChange = anyEvent(onRelevantGitChange, onNonGitChange);

		this.disposables.push(onRelevantWorkspaceChange(this.handleWorkspaceChange, this));
	}

	getTreeItem(element: FileSystemEntry): TreeItem {
		return element;
	}

	async getChildren(element?: FileSystemEntry): Promise<FileSystemEntry[]> {
		if (element) {
			return this.getFileSystemEntries(element.relPath);
		} else {
			await this.initDiff()
			return this.getFileSystemEntries('.');
		}
	}

	private async initDiff() {
		this.diffFolderMapping.clear();
		this.diffFolderMapping.set('.', new Array());

		const HEAD = await this.repository.getHEAD();
		if (!HEAD.name) {
			return;
		}
		if (!this.HEAD || this.HEAD.name != HEAD.name) {
			this.HEAD = HEAD;
			const baseRef = await getParentBranch(this.repository, HEAD);
			// fall-back to HEAD if no parent found
			this.baseRef = baseRef ? baseRef : HEAD.name;
		}

		const diff = await diffIndex(this.repository, this.baseRef);
		for (const entry of diff) {
			const folder = path.dirname(entry.path);

			// add this and all parent folders to the folder map
			let currentFolder = folder
			do {
				if (!this.diffFolderMapping.has(currentFolder)) {
					this.diffFolderMapping.set(currentFolder, new Array());
				}
				currentFolder = path.dirname(currentFolder)
			} while (currentFolder != '.')

			const entries = this.diffFolderMapping.get(folder) as IDiffStatus[];
			entries.push(entry);
		}
	}

	@debounce(1000)
	private async handleWorkspaceChange(path: Uri) {
		await this.initDiff();
		this._onDidChangeTreeData.fire()
	}

	private getFileSystemEntries(folder: string): FileSystemEntry[] {
		const entries: FileSystemEntry[] = [];

		// add direct subfolders
		for (const folder2 of this.diffFolderMapping.keys()) {
			if (folder2 == '.') {
				continue;
			}
			if (path.dirname(folder2) == folder) {
				entries.push(new FileSystemEntry(folder2));
			}
		}

		// add files
		const files = this.diffFolderMapping.get(folder) as IDiffStatus[];
		for (const file of files) {
			const uri = Uri.file(path.join(this.repository.root, file.path));
			const command = file.status == 'D' ? undefined : {
				command: 'vscode.open',
				arguments: [uri],
				title: ''
			};
			entries.push(new FileSystemEntry(
				file.path, file, command));
		}

		return entries
	}

	async showDiffWithBase(fileEntry: FileSystemEntry) {
		const right = Uri.file(path.join(this.repository.root, fileEntry.relPath));
		const left = toGitUri(right, this.baseRef);
		const status = (fileEntry.fileStatus as IDiffStatus).status;

		if (status == 'U' || status == 'A') {
			return commands.executeCommand('vscode.open', right);
		}
		if (status == 'D') {
			return commands.executeCommand('vscode.open', left);
		}		
		
		const options: TextDocumentShowOptions = {
			preview: true
		};
		await commands.executeCommand('vscode.diff',
			left, right, fileEntry.label + " (Working Tree)", options);
	} 

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

class FileSystemEntry extends TreeItem {

	constructor(
		public readonly relPath: string,
		public readonly fileStatus?: IDiffStatus,
		public readonly command?: Command
	) {
		super(path.basename(relPath));
		if (fileStatus) {
			this.collapsibleState = TreeItemCollapsibleState.None;
			this.contextValue = 'file';
			const iconName = toIconName(fileStatus);
			this.iconPath = path.join(__dirname, '..', '..', 'resources', 'icons', iconName + '.svg');
		} else {
			this.collapsibleState = TreeItemCollapsibleState.Expanded;
			this.contextValue = 'folder';
		}
	}
}

function toIconName(diffStatus: IDiffStatus) {
	switch(diffStatus.status) {
		case 'U': return 'status-untracked';
		case 'A': return 'status-added';
		case 'D': return 'status-deleted';
		case 'M': return 'status-modified';
		case 'C': return 'status-conflict';
	}
}