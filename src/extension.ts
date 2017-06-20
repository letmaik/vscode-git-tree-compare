'use strict';

import { ExtensionContext, workspace, window, Disposable, commands } from 'vscode';

import { GitContextProvider } from './GitContextProvider'
import { createGit, getDefaultBranch } from './git_helper'
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

	const outputChannel = window.createOutputChannel('Git Context');
	disposables.push(outputChannel);

	createGit().then(async git => {
		const onOutput = str => outputChannel.append(str);
		git.onOutput.addListener('log', onOutput);
		disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

		const repositoryRoot = await git.getRepositoryRoot(rootPath);
		const repository = git.open(repositoryRoot);
		const provider = new GitContextProvider(repository);
		window.registerTreeDataProvider('gitContext', provider);

		commands.registerCommand('gitContext.diffWithBase', node => {
			if (!node) {
				return;
			}
			provider.showDiffWithBase(node)
		});
	})
}
