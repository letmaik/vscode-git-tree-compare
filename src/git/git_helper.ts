/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { ExtensionContext, workspace, window, Disposable, commands, Uri } from 'vscode';
import { findGit, Git, Repository } from './git';
import { Askpass } from './askpass';
import { toDisposable } from './util';


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

export interface IDiffStatus {
	status: string
	path: string
}

export async function diffIndex(repo: Repository, ref: string) {
	const result = await repo.run(['diff-index', '--name-status', ref]);
	const diffStatuses: IDiffStatus[] = result.stdout.trim().split('\n')
		.filter(line => !!line)
		.map(line => {
			return {
				status: line[0],
				path: line.substr(1).trim()
			};
		});
	return diffStatuses;
}
