import * as path from 'path';
import * as fs from 'fs';

import { ExtensionContext, workspace, window, Disposable, commands, Uri } from 'vscode';
import { findGit, Git, Repository, Ref } from './git/git';
import { Askpass } from './git/askpass';
import { toDisposable, denodeify } from './git/util';

const readFile = denodeify<string>(fs.readFile);
const stat = denodeify<fs.Stats>(fs.stat);

export function denodeify2<R>(fn: Function): (...args) => Promise<R> {
	return (...args) => new Promise<R>(c => fn(...args, r => c(r)));
}
const exists = denodeify2<boolean>(fs.exists);

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

export async function getDefaultBranch(repo: Repository, head: Ref): Promise<string | undefined> {
	if (!head.name) {
		return;
	}
	const headBranch = await repo.getBranch(head.name);
	if (!headBranch.upstream) {
		return;
	}
	const refs = await repo.getRefs();
	const remote = headBranch.upstream.split('/')[0]
	const remoteHead = remote + "/HEAD";
	if (refs.find(ref => ref.name == remoteHead) === undefined) {
		return;
	}
	// there is no git command equivalent to "git remote set-head" for reading the default branch
	// however, the branch name is in the file .git/refs/remotes/$remote/HEAD
	// the file format is: 
	// ref: refs/remotes/origin/master
	const symRefPath = path.join(repo.root, '.git', 'refs', 'remotes', remote, 'HEAD');
	const symRefExists = exists(symRefPath);
	if (!symRefExists) {
		return;
	}
	const symRef = await readFile(symRefPath, 'utf8');
	const remoteHeadBranch = symRef.trim().replace('ref: refs/remotes/', '');
	return remoteHeadBranch;
}

export async function getMergeBase(repo: Repository, headRef: string, baseRef: string): Promise<string> {
	const result = await repo.run(['merge-base', baseRef, headRef]);
	const mergeBase = result.stdout.trim();
	return mergeBase;
}

export async function getHeadModificationDate(repo: Repository): Promise<Date> {
	const headPath = path.join(repo.root, '.git', 'HEAD');
	const stats = await stat(headPath);
	return stats.mtime;
}

export interface IDiffStatus {
	/**
	 * A Addition of a file
	 * D Deletion of a file
	 * M Modification of file contents 
	 * C File has merge conflicts
	 * U Untracked file
	 */
	status: StatusCode

	/** absolute path to file on disk */
	absPath: string
}

class DiffStatus implements IDiffStatus {
	readonly absPath: string;

	constructor(repo: Repository, public status: StatusCode, relPath: string) {
		this.absPath = path.join(repo.root, relPath);
	}
}

export type StatusCode = 'A' | 'D' | 'M' | 'C' | 'U'

function sanitizeStatus(status: string): StatusCode {
	if (status == 'U') {
		return 'C';
	}
	if (status.length != 1 || 'ADM'.indexOf(status) == -1) {
		throw new Error('unsupported git status: ' + status);
	}
	return status as StatusCode;
}

export async function diffIndex(repo: Repository, ref: string) {
	const diffIndexResult = await repo.run(['diff-index',  '--no-renames', '--name-status', ref, '--']);
	const untrackedResult = await repo.run(['ls-files',  '--others', '--exclude-standard']);
	
	const diffIndexStatuses: IDiffStatus[] = diffIndexResult.stdout.trim().split('\n')
		.filter(line => !!line)
		.map(line =>
			new DiffStatus(repo, sanitizeStatus(line[0]), line.substr(1).trim())
		);
	
	const untrackedStatuses: IDiffStatus[] = untrackedResult.stdout.trim().split('\n')
		.filter(line => !!line)
		.map(line => new DiffStatus(repo, 'U' as 'U', line));

	const statuses = diffIndexStatuses.concat(untrackedStatuses);
	statuses.sort((s1, s2) => s1.absPath.localeCompare(s2.absPath))
	return statuses;
}
