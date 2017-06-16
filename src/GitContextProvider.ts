import * as vscode from 'vscode'
import * as path from 'path'
import { Repository } from './git/git'
import { diffIndex, IDiffStatus } from './git/git_helper'

export class GitContextProvider implements vscode.TreeDataProvider<FileSystemEntry> {

	// TODO refresh on changes, or provide a refresh button

	private _onDidChangeTreeData: vscode.EventEmitter<FileSystemEntry | undefined> = new vscode.EventEmitter<FileSystemEntry | undefined>();
	readonly onDidChangeTreeData: vscode.Event<FileSystemEntry | undefined> = this._onDidChangeTreeData.event;

	private _gitDiffTree: any;
	private _gitBaseBranch: string;
	private _diffFolderMapping: Map<string, IDiffStatus[]> = new Map();

	constructor(private baseRef: string, private repo: Repository) {
		this._diffFolderMapping.set('.', new Array());
	}

	getTreeItem(element: FileSystemEntry): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: FileSystemEntry): Promise<FileSystemEntry[]> {
		if (element) {
			return this.getFileSystemEntries(element.relPath);
		} else {
			const diff = await diffIndex(this.repo, this.baseRef);
			for (const entry of diff) {
				const folder = path.dirname(entry.path);

				// add this and all parent folders to the folder map
				let currentFolder = folder
				do {
					if (!this._diffFolderMapping.has(currentFolder)) {
						this._diffFolderMapping.set(currentFolder, new Array());
					}
					currentFolder = path.dirname(currentFolder)
				} while (currentFolder != '.')

				this._diffFolderMapping.get(folder).push(entry);
			}
			return this.getFileSystemEntries('.');
		}
	}

	private getFileSystemEntries(folder: string): FileSystemEntry[] {
		const entries: FileSystemEntry[] = [];

		// add direct subfolders
		for (const folder2 of this._diffFolderMapping.keys()) {
			if (folder2 == '.') {
				continue;
			}
			if (path.dirname(folder2) == folder) {
				entries.push(new FileSystemEntry(
					folder2, path.basename(folder2),
					vscode.TreeItemCollapsibleState.Expanded));
			}
		}		

		// add files
		for (const entry of this._diffFolderMapping.get(folder)) {
			const uri = vscode.Uri.file(path.join(this.repo.root, entry.path));
			console.log(uri)
			entries.push(new FileSystemEntry(
				entry.path, path.basename(entry.path), 
				vscode.TreeItemCollapsibleState.None,
				{
					command: 'vscode.open',
					arguments: [uri],
					title: 'Open file'
				}));
		}

		return entries
	}

}

class FileSystemEntry extends vscode.TreeItem {

	constructor(
		public readonly relPath: string,
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly command?: vscode.Command		
	) {
		super(label, collapsibleState);
	}

	// TODO remove icon for folders and add file icon according to status
	iconPath = {
		light: path.join(__filename, '..', '..', '..', 'resources', 'light', 'dependency.svg'),
		dark: path.join(__filename, '..', '..', '..', 'resources', 'dark', 'dependency.svg')
	};

	// TODO
	contextValue = 'foldertodo';

}