import { ExtensionContext, workspace, window, Disposable, commands } from 'vscode';

import { GitTreeCompareProvider } from './treeProvider';
import { createGit, getDefaultBranch } from './gitHelper';
import { RefType } from './git/git'
import { toDisposable } from './git/util';

// TODO if possible, only display the view if inside a git repo

export function activate(context: ExtensionContext) {
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	const rootPath = workspace.rootPath;
	if (!rootPath) {
		return;
	}

	const outputChannel = window.createOutputChannel('Git Tree Compare');
	disposables.push(outputChannel);

	createGit().then(async git => {
		const onOutput = str => outputChannel.append(str);
		git.onOutput.addListener('log', onOutput);
		disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

		const repositoryRoot = await git.getRepositoryRoot(rootPath);
		const repository = git.open(repositoryRoot);
		const provider = new GitTreeCompareProvider(repository);
		window.registerTreeDataProvider('gitTreeCompare', provider);

		commands.registerCommand('gitTreeCompare.diffWithBase', node => {
			if (!node) {
				return;
			}
			provider.showDiffWithBase(node);
		});
		commands.registerCommand('gitTreeCompare.changeBase', () => {
			provider.promptChangeBase();
		});
	})
}
