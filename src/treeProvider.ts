import * as assert from 'assert'
import * as path from 'path'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState,
	     Uri, Command, Disposable, EventEmitter, Event, TextDocumentShowOptions,
		 QuickPickItem,
	     workspace, commands, window } from 'vscode'
import { NAMESPACE } from './constants'
import { Repository, Ref, RefType } from './git/git'
import { anyEvent, filterEvent } from './git/util'
import { toGitUri } from './git/uri'
import { getDefaultBranch, diffIndex, IDiffStatus, StatusCode } from './gitHelper'
import { debounce } from './git/decorators'

class FileElement implements IDiffStatus {
	constructor(public absPath: string, public status: StatusCode) {}
}

class FolderElement {
	constructor(public absPath: string, public excludeTreeRoot?: boolean) {}
}

class RootElement {
	// TODO without a member the type checker throws up otherwise further down
	foo;
}

class RefElement {
	constructor(public refName: string) {}
}

type Element = FileElement | FolderElement | RootElement | RefElement
type FileSystemElement = FileElement | FolderElement

class RefItem implements QuickPickItem {
	label: string
	description: string
	constructor(public ref: Ref) {
		this.label = ref.name!;
		this.description = (ref.commit || '').substr(0, 8);
	}
}

// FIXME quickly changing config settings triggers the case that diffFolderMapping is updated async while the tree is redrawn
//    which can lead to undefined references
// -> it would be better to make it immutable and supply diffFolderMapping to Element nodes so that this.diffFolderMapping
//    is only used for the root empty node -> remove "readonly" and create new Map each time!

export class GitTreeCompareProvider implements TreeDataProvider<Element>, Disposable {

	private _onDidChangeTreeData: EventEmitter<Element | undefined> = new EventEmitter<Element | undefined>();
	readonly onDidChangeTreeData: Event<Element | undefined> = this._onDidChangeTreeData.event;

	private treeRoot: string;
	private readonly repoRoot: string;

	private readonly diffFolderMapping: Map<string, IDiffStatus[]> = new Map();
	private hasFilesOutsideTreeRoot: boolean;
	private includeFilesOutsideWorkspaceRoot: boolean;

	private baseRef: string;
	private HEAD: Ref;

	private readonly disposables: Disposable[] = [];

	constructor(private repository: Repository) {		
		this.repoRoot = path.normalize(repository.root);
		this.readConfig();

		this.disposables.push(workspace.onDidChangeConfiguration(this.handleConfigChange, this));

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

	private readConfig() {
		const config = workspace.getConfiguration(NAMESPACE);
		if (config.get<string>('root') == 'repository') {
			this.treeRoot = this.repoRoot;
		} else {
			this.treeRoot = workspace.rootPath!;
		}
		this.includeFilesOutsideWorkspaceRoot = config.get<boolean>('includeFilesOutsideWorkspaceRoot', true);
	}

	getTreeItem(element: Element): TreeItem {
		return toTreeItem(element);
	}

	async getChildren(element?: Element): Promise<Element[]> {
		if (!element) {
			if (this.diffFolderMapping.size == 0) {
				await this.initDiff();
			}
			return [new RefElement(this.baseRef)];
		} else if (element instanceof RefElement) {
			const entries: Element[] = [];
			if (this.hasFilesOutsideTreeRoot && this.includeFilesOutsideWorkspaceRoot) {
				entries.push(new RootElement());
			}
			return entries.concat(this.getFileSystemEntries(this.treeRoot));
		} else if (element instanceof RootElement) {
			return this.getFileSystemEntries(this.repoRoot, true);
		} else if (element instanceof FolderElement) {
			return this.getFileSystemEntries(element.absPath, element.excludeTreeRoot);
		} 
		assert(false, "unsupported element type");
		return [];
	}

	private async initDiff() {
		this.diffFolderMapping.clear();
		this.diffFolderMapping.set(this.repoRoot, new Array());

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

		let hasFilesOutsideTreeRoot = false;

		const diff = await diffIndex(this.repository, this.baseRef);
		for (const entry of diff) {
			const folder = path.dirname(entry.absPath);

			if (!hasFilesOutsideTreeRoot && !folder.startsWith(this.treeRoot)) {
				hasFilesOutsideTreeRoot = true;
			}

			// add this and all parent folders to the folder map
			let currentFolder = folder
			while (currentFolder != this.repoRoot) {
				if (!this.diffFolderMapping.has(currentFolder)) {
					this.diffFolderMapping.set(currentFolder, new Array());
				}
				currentFolder = path.dirname(currentFolder)
			} 

			const entries = this.diffFolderMapping.get(folder)!;
			entries.push(entry);
		}
		this.hasFilesOutsideTreeRoot = hasFilesOutsideTreeRoot;
	}

	@debounce(2000)
	private async handleWorkspaceChange(path: Uri) {
		await this.initDiff();
		this._onDidChangeTreeData.fire()
	}

	private handleConfigChange() {
		const oldRoot = this.treeRoot;
		const oldInclude = this.includeFilesOutsideWorkspaceRoot;
		this.readConfig();
		if (oldRoot != this.treeRoot || oldInclude != this.includeFilesOutsideWorkspaceRoot) {
			this._onDidChangeTreeData.fire();
		}
	}

	private getFileSystemEntries(folder: string, excludeTreeRoot?: boolean): FileSystemElement[] {
		const entries: FileSystemElement[] = [];

		// add direct subfolders
		for (const folder2 of this.diffFolderMapping.keys()) {
			if (excludeTreeRoot && folder2 == this.treeRoot) {
				continue;
			}
			if (path.dirname(folder2) == folder) {
				entries.push(new FolderElement(folder2, excludeTreeRoot));
			}
		}

		// add files
		const files = this.diffFolderMapping.get(folder)!;
		for (const file of files) {
			entries.push(new FileElement(file.absPath, file.status));
		}

		return entries
	}

	async showDiffWithBase(fileEntry: FileElement) {
		const right = Uri.file(fileEntry.absPath);
		const left = toGitUri(right, this.baseRef);
		const status = fileEntry.status;

		if (status == 'U' || status == 'A') {
			return commands.executeCommand('vscode.open', right);
		}
		if (status == 'D') {
			return commands.executeCommand('vscode.open', left);
		}		
		
		const options: TextDocumentShowOptions = {
			preview: true
		};
		const filename = path.basename(fileEntry.absPath);
		await commands.executeCommand('vscode.diff',
			left, right, filename + " (Working Tree)", options);
	}

	async promptChangeBase() {
		const refs = await this.repository.getRefs();
		const picks = refs.filter(ref => ref.name).map(ref => new RefItem(ref));

		const placeHolder = 'Select a ref to use as comparison base';
		const choice = await window.showQuickPick<RefItem>(picks, { placeHolder });

		if (!choice) {
			return;
		}

		const baseRef = choice.ref.name!;
		if (this.baseRef == baseRef) {
			return;
		}
		this.baseRef = baseRef;
		await this.initDiff();
		this._onDidChangeTreeData.fire();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

function toTreeItem(element: Element): TreeItem {
	const iconRoot = path.join(__dirname, '..', '..', 'resources', 'icons');
	if (element instanceof FileElement) {
		const label = path.basename(element.absPath);
		const item = new TreeItem(label);
		item.contextValue = 'file';
		item.iconPath = path.join(iconRoot,	toIconName(element) + '.svg');
		if (element.status != 'D') {
			item.command = {
				command: 'vscode.open',
				arguments: [Uri.file(element.absPath)],
				title: ''
			};
		}
		return item;
	} else if (element instanceof FolderElement) {
		const label = path.basename(element.absPath);
		const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
		item.contextValue = 'folder';
		return item;
	} else if (element instanceof RootElement) {
		const label = '<ROOT>';
		const item = new TreeItem(label, TreeItemCollapsibleState.Collapsed);
		item.contextValue = 'root';

		// TODO icon
		//item.iconPath = '';
		return item;
	} else if (element instanceof RefElement) {
		const label = element.refName;
		const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
		item.contextValue = 'ref';
		item.iconPath = {
			light: path.join(iconRoot, 'light', 'git-compare.svg'),
			dark: path.join(iconRoot, 'dark', 'git-compare.svg')
		};
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
	}
}