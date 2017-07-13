import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState,
	     Uri, Command, Disposable, EventEmitter, Event, TextDocumentShowOptions,
		 QuickPickItem, ProgressLocation, Memento,
	     workspace, commands, window } from 'vscode'
import { NAMESPACE } from './constants'
import { Repository, Ref, RefType } from './git/git'
import { anyEvent, filterEvent } from './git/util'
import { toGitUri } from './git/uri'
import { getDefaultBranch, getMergeBase, getHeadModificationDate,
	     diffIndex, IDiffStatus, StatusCode } from './gitHelper'
import { debounce } from './git/decorators'

class FileElement implements IDiffStatus {
	constructor(public absPath: string, public status: StatusCode) {}
}

class FolderElement {
	constructor(public absPath: string, public useFilesOutsideTreeRoot?: boolean, public collapsed?: boolean) {}
}

class RootElement {
	// TODO without a member the type checker throws up otherwise further down
	foo;
}

class RefElement {
	constructor(public refName: string, public hasChildren: boolean) {}
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

export class GitTreeCompareProvider implements TreeDataProvider<Element>, Disposable {

	private _onDidChangeTreeData: EventEmitter<Element | undefined> = new EventEmitter<Element | undefined>();
	readonly onDidChangeTreeData: Event<Element | undefined> = this._onDidChangeTreeData.event;

	private treeRoot: string;
	private readonly repoRoot: string;

	private filesInsideTreeRoot: Map<string, IDiffStatus[]>;
	private filesOutsideTreeRoot: Map<string, IDiffStatus[]>;
	private includeFilesOutsideWorkspaceRoot: boolean;

	private headLastChecked: Date;
	private baseRef: string;
	private mergeBase: string;

	private readonly disposables: Disposable[] = [];

	constructor(private repository: Repository, private workspaceState: Memento) {		
		this.repoRoot = path.normalize(repository.root);
		this.readConfig();

		this.disposables.push(workspace.onDidChangeConfiguration(this.handleConfigChange, this));

		const fsWatcher = workspace.createFileSystemWatcher('**');
		this.disposables.push(fsWatcher);

		const onWorkspaceChange = anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
		const onNonGitChange = filterEvent(onWorkspaceChange, uri => !/\/\.git\//.test(uri.path) && !/\/\.git$/.test(uri.path));

		this.disposables.push(onNonGitChange(this.handleWorkspaceChange, this));
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

	private getStoredBaseRef(): string | undefined {
		return this.workspaceState.get<string>('baseRef');
	}

	private updateStoredBaseRef(baseRef: string) {
		this.workspaceState.update('baseRef', baseRef);
	}

	getTreeItem(element: Element): TreeItem {
		return toTreeItem(element);
	}

	async getChildren(element?: Element): Promise<Element[]> {
		if (!element) {
			if (!this.filesInsideTreeRoot) {
				await this.initDiff();
			}
			const hasFiles =
				this.filesInsideTreeRoot.size > 0 || 
				(this.includeFilesOutsideWorkspaceRoot && this.filesOutsideTreeRoot.size > 0);

			return [new RefElement(this.baseRef, hasFiles)];
		} else if (element instanceof RefElement) {
			const entries: Element[] = [];
			if (this.includeFilesOutsideWorkspaceRoot && this.filesOutsideTreeRoot.size > 0) {
				entries.push(new RootElement());
			}
			return entries.concat(this.getFileSystemEntries(this.treeRoot));
		} else if (element instanceof RootElement) {
			return this.getFileSystemEntries(this.repoRoot, true /*, true*/);
		} else if (element instanceof FolderElement) {
			return this.getFileSystemEntries(element.absPath, element.useFilesOutsideTreeRoot, element.collapsed);
		} 
		assert(false, "unsupported element type");
		return [];
	}

	private async updateRefs(baseRef?: string): Promise<boolean>
	{
		const HEAD = await this.repository.getHEAD();
		this.headLastChecked = new Date();
		if (!HEAD.name) {
			return false;
		}
		if (!baseRef) {
			// TODO check that the ref still exists and ignore otherwise
			baseRef = this.getStoredBaseRef();
		}
		if (!baseRef) {
			baseRef = await getDefaultBranch(this.repository, HEAD);
		}
		if (!baseRef) {
			baseRef = HEAD.name;
		}
		let mergeBase = baseRef;
		if (baseRef != HEAD.name) {
			// determine merge base to create more sensible/compact diff
			try {
				mergeBase = await getMergeBase(this.repository, HEAD.name, baseRef);
			} catch (e) {
				// sometimes the merge base cannot be determined
				// this can be the case with shallow clones but may have other reasons
			}				
		}
		this.baseRef = baseRef;
		this.mergeBase = mergeBase;
		this.updateStoredBaseRef(baseRef);
		return true;
	} 

	private async initDiff() {
		if (!this.baseRef) {
			if (!await this.updateRefs()) {
				return;
			}
		}

		const diff = await diffIndex(this.repository, this.mergeBase);

		const filesInsideTreeRoot = new Map<string, IDiffStatus[]>();
		const filesOutsideTreeRoot = new Map<string, IDiffStatus[]>();

		for (const entry of diff) {
			const folder = path.dirname(entry.absPath);

			const isInsideTreeRoot = folder.startsWith(this.treeRoot);
			const files = isInsideTreeRoot ? filesInsideTreeRoot : filesOutsideTreeRoot;

			if (files.size == 0) {
				files.set(this.repoRoot, new Array());
			}

			// add this and all parent folders to the folder map
			let currentFolder = folder
			while (currentFolder != this.repoRoot) {
				if (!files.has(currentFolder)) {
					files.set(currentFolder, new Array());
				}
				currentFolder = path.dirname(currentFolder)
			} 

			const entries = files.get(folder)!;
			entries.push(entry);
		}
		this.filesInsideTreeRoot = filesInsideTreeRoot;
		this.filesOutsideTreeRoot = filesOutsideTreeRoot;
	}

	private async isHeadChanged() {
		const mtime = await getHeadModificationDate(this.repository);
		return mtime > this.headLastChecked;
	}

	@debounce(2000)
	private async handleWorkspaceChange(path: Uri) {
		if (await this.isHeadChanged()) {
			// make sure merge base is updated when switching branches
			await this.updateRefs(this.baseRef);
		}
		await this.initDiff();
		this._onDidChangeTreeData.fire();
	}

	private handleConfigChange() {
		const oldRoot = this.treeRoot;
		const oldInclude = this.includeFilesOutsideWorkspaceRoot;
		this.readConfig();
		if (oldRoot != this.treeRoot || oldInclude != this.includeFilesOutsideWorkspaceRoot) {
			this._onDidChangeTreeData.fire();
		}
	}

	private getFileSystemEntries(folder: string, useFilesOutsideTreeRoot?: boolean, collapsed?: boolean): FileSystemElement[] {
		const entries: FileSystemElement[] = [];
		const files = useFilesOutsideTreeRoot ? this.filesOutsideTreeRoot : this.filesInsideTreeRoot;

		// add direct subfolders
		for (const folder2 of files.keys()) {
			if (path.dirname(folder2) == folder) {
				entries.push(new FolderElement(folder2, useFilesOutsideTreeRoot, collapsed));
			}
		}

		// add files
		const fileEntries = files.get(folder);
		// there is no mapping entry if treeRoot!=repoRoot and
		// there are no files within treeRoot, therefore, this is guarded
		if (fileEntries) {
			for (const file of fileEntries) {
				entries.push(new FileElement(file.absPath, file.status));
			}
		}

		return entries
	}

	async showDiffWithBase(fileEntry: FileElement) {
		const right = Uri.file(fileEntry.absPath);
		const left = toGitUri(right, this.mergeBase);
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
		window.withProgress({ location: ProgressLocation.Window, title: 'Updating Tree Base' }, async p => {	
			await this.updateRefs(baseRef);
			await this.initDiff();
			this._onDidChangeTreeData.fire();
		});
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
		const label = '/';
		const item = new TreeItem(label, TreeItemCollapsibleState.Collapsed);
		item.contextValue = 'root';
		return item;
	} else if (element instanceof RefElement) {
		const label = element.refName;
		const state = element.hasChildren ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None;
		const item = new TreeItem(label, state);
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