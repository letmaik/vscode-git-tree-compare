'use strict';

import * as path from 'path'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState,
	     Uri, Command, Disposable, EventEmitter, Event, TextDocumentShowOptions,
	     workspace, commands } from 'vscode'
import { Repository, Ref } from './git/git'
import { anyEvent, filterEvent } from './git/util'
import { toGitUri } from './git/uri'
import { getDefaultBranch, diffIndex, IDiffStatus } from './git_helper'
import { debounce } from './git/decorators'

class FileElement {
	constructor(public file: IDiffStatus) {}
}

class FolderElement {
	constructor(public relPath: string) {}
}

class BranchElement {
	constructor(public branchName: string) {}
}

type Element = FileElement | FolderElement | BranchElement
type FileSystemElement = FileElement | FolderElement

export class GitContextProvider implements TreeDataProvider<Element>, Disposable {

	private _onDidChangeTreeData: EventEmitter<Element | undefined> = new EventEmitter<Element | undefined>();
	readonly onDidChangeTreeData: Event<Element | undefined> = this._onDidChangeTreeData.event;

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

	getTreeItem(element: Element): TreeItem {
		return toTreeItem(element);
	}

	async getChildren(element?: Element): Promise<Element[]> {
		if (!element) {
			await this.initDiff();
			return [new BranchElement(this.baseRef)];
		} else if (element instanceof BranchElement) {
			return this.getFileSystemEntries('.');
		} else if (element instanceof FolderElement) {
			return this.getFileSystemEntries(element.relPath);
		} else {
			throw new Error(element.constructor.name + ' does not have children!');
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
			const baseRef = await getDefaultBranch(this.repository, HEAD);
			// fall-back to HEAD if no default found
			this.baseRef = baseRef ? baseRef : HEAD.name;
		}

		const diff = await diffIndex(this.repository, this.baseRef);
		for (const entry of diff) {
			const folder = path.dirname(entry.relPath);

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

	private getFileSystemEntries(folder: string): FileSystemElement[] {
		const entries: FileSystemElement[] = [];

		// add direct subfolders
		for (const folder2 of this.diffFolderMapping.keys()) {
			if (folder2 == '.') {
				continue;
			}
			if (path.dirname(folder2) == folder) {
				entries.push(new FolderElement(folder2));
			}
		}

		// add files
		const files = this.diffFolderMapping.get(folder) as IDiffStatus[];
		for (const file of files) {
			entries.push(new FileElement(file));
		}

		return entries
	}

	async showDiffWithBase(fileEntry: FileElement) {
		const right = fileEntry.file.absUri;
		const left = toGitUri(right, this.baseRef);
		const status = fileEntry.file.status;

		if (status == 'U' || status == 'A') {
			return commands.executeCommand('vscode.open', right);
		}
		if (status == 'D') {
			return commands.executeCommand('vscode.open', left);
		}		
		
		const options: TextDocumentShowOptions = {
			preview: true
		};
		const filename = path.basename(fileEntry.file.relPath);
		await commands.executeCommand('vscode.diff',
			left, right, filename + " (Working Tree)", options);
	} 

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

function toTreeItem(element: Element): TreeItem {
	const iconRoot = path.join(__dirname, '..', '..', 'resources', 'icons');
	if (element instanceof FileElement) {
		const label = path.basename(element.file.relPath);
		const item = new TreeItem(label);
		item.contextValue = 'file';
		item.iconPath = path.join(iconRoot,	toIconName(element) + '.svg');
		if (element.file.status != 'D') {
			item.command = {
				command: 'vscode.open',
				arguments: [element.file.absUri],
				title: ''
			};
		}
		return item;
	} else if (element instanceof FolderElement) {
		const label = path.basename(element.relPath);
		const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
		item.contextValue = 'folder';
		return item;
	} else if (element instanceof BranchElement) {
		const label = element.branchName;
		const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
		item.contextValue = 'branch';
		item.iconPath = {
			light: path.join(iconRoot, 'light', 'git-compare.svg'),
			dark: path.join(iconRoot, 'dark', 'git-compare.svg')
		};
		return item;
	}
	throw new Error('unsupported element type');
}

function toIconName(element: FileElement) {
	switch(element.file.status) {
		case 'U': return 'status-untracked';
		case 'A': return 'status-added';
		case 'D': return 'status-deleted';
		case 'M': return 'status-modified';
		case 'C': return 'status-conflict';
	}
}