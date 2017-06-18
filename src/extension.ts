'use strict';

import { ExtensionContext, workspace, window, Disposable } from 'vscode';

import { GitContextProvider } from './GitContextProvider'
import { createGit } from './git_helper'
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
		const HEAD = await repository.getHEAD();
		if (!HEAD.name) {
			return;
		}
		const headBranch = await repository.getBranch(HEAD.name);
		// TODO don't use default branch of upstream remote, may not exist
		//   -> instead determine most likely parent branch + option to change
		// see https://stackoverflow.com/a/17843908/60982 
		if (!headBranch.upstream) {
			return;
		}
		const remote = headBranch.upstream.split('/')[0]
		const baseRef = remote + "/HEAD";
		const provider = new GitContextProvider(baseRef, repository);
		window.registerTreeDataProvider('gitContext', provider);
	})
}
