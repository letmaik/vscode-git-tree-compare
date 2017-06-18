/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { ExtensionContext, workspace, window, Disposable, commands, Uri } from 'vscode';
import { findGit, Git, Repository } from './git/git';
import { Askpass } from './git/askpass';
import { toDisposable } from './git/util';


export async function createGit(): Promise<Git> {
	const config = workspace.getConfiguration('git');
	const enabled = config.get<boolean>('enabled') === true;
	const workspaceRootPath = workspace.rootPath;

	const pathHint = workspace.getConfiguration('git').get<string>('path');
	const info = await findGit(pathHint);
	const askpass = new Askpass();
	const env = await askpass.getEnv();
	return new Git({ gitPath: info.path, version: info.version, env });
}

/**
 * @see https://stackoverflow.com/a/17843908
 */
export async function getParentBranch(repo: Repository): Promise<string | undefined> {
	const head = await repo.getHEAD();
	if (!head.name) {
		return;
	}
	const result = await repo.run(['show-branch']);
	const matches = result.stdout.split('\n')
		.filter(line => line.startsWith('*'))
		.map(line => line
			.replace(/^[*+ ]+\[(.+?)\].+/, '$1')
			.replace(/(~|\^)\d*$/, ''))
		.filter(ref => ref != head.name);
	if (matches.length == 0) {
		return;
	}
	return matches[0];
}

export interface IDiffStatus {
	/**
	 * A Addition of a file
	 * D Deletion of a file
	 * M Modification of file contents
	 * T Change in type of the file (i.e. regular file, symlink, submodule, ...​) 
	 * C File has merge conflicts
	 * U Untracked file
	 */
	status: string
	path: string
}

export async function diffIndex(repo: Repository, ref: string) {
	const diffIndexResult = await repo.run(['diff-index',  '--no-renames', '--name-status', ref]);
	const untrackedResult = await repo.run(['ls-files',  '--others', '--exclude-standard']);
	
	const diffIndexStatuses: IDiffStatus[] = diffIndexResult.stdout.trim().split('\n')
		.filter(line => !!line)
		.map(line => ({
			status: line[0] == 'U' ? 'C' : line[0],
			path: line.substr(1).trim()
		}));
	
	const untrackedStatuses: IDiffStatus[] = untrackedResult.stdout.trim().split('\n')
		.filter(line => !!line)
		.map(line => ({
			status: 'U',
			path: line
		}));

	const statuses = diffIndexStatuses.concat(untrackedStatuses);
	statuses.sort((s1, s2) => s1.path.localeCompare(s2.path))
	return statuses;
}
