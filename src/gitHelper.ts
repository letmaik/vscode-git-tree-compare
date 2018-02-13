import * as path from 'path';
import * as fs from 'fs';

import { ExtensionContext, workspace, window, Disposable, commands, Uri, OutputChannel } from 'vscode';
import { findGit, Git, Repository, Ref, Branch, IExecutionResult } from './git/git';
import { Askpass } from './git/askpass';
import { toDisposable, denodeify } from './git/util';

const readFile = denodeify<string>(fs.readFile);
const stat = denodeify<fs.Stats>(fs.stat);

export async function createGit(outputChannel: OutputChannel): Promise<Git> {
    const workspaceRootPath = workspace.rootPath;

    const pathHint = workspace.getConfiguration('git').get<string>('path');
    const info = await findGit(pathHint, path => outputChannel.appendLine("Looking for git in: " + path));
    const askpass = new Askpass();
    const env = await askpass.getEnv();
    return new Git({ gitPath: info.path, version: info.version, env });
}

export async function getAbsGitDir(repo: Repository): Promise<string> {
    // We don't use --absolute-git-dir here as that requires git >= 2.13.
    let res = await repo.run(['rev-parse', '--git-dir']);
    let dir = res.stdout.trim();
    if (!path.isAbsolute(dir)) {
        dir = path.join(repo.root, dir);
    }
    return dir;
}

export async function getAbsGitCommonDir(repo: Repository): Promise<string> {
    let res = await repo.run(['rev-parse', '--git-common-dir']);
    let dir = res.stdout.trim();
    if (!path.isAbsolute(dir)) {
        dir = path.join(repo.root, dir);
    }
    return dir;
}

export async function getDefaultBranch(repo: Repository, absGitCommonDir: string, head: Ref): Promise<string | undefined> {
    // determine which remote HEAD is tracking
    let remote: string
    if (head.name) {
        let headBranch: Branch;
        try {
            headBranch = await repo.getBranch(head.name);
        } catch (e) {
            // this can happen on a newly initialized repo without commits
            return;
        }
        if (!headBranch.upstream) {
            return;
        }
        remote = headBranch.upstream.split('/')[0];
    } else {
        // detached HEAD, fall-back and try 'origin'
        remote = 'origin';
    }
    // determine default branch for the remote
    const remoteHead = remote + "/HEAD";
    const refs = await repo.getRefs();
    if (refs.find(ref => ref.name == remoteHead) === undefined) {
        return;
    }
    // there is no git command equivalent to "git remote set-head" for reading the default branch
    // however, the branch name is in the file .git/refs/remotes/$remote/HEAD
    // the file format is:
    // ref: refs/remotes/origin/master
    const symRefPath = path.join(absGitCommonDir, 'refs', 'remotes', remote, 'HEAD');
    let symRef: string;
    try {
        symRef = await readFile(symRefPath, 'utf8');
    } catch (e) {
        return;
    }
    const remoteHeadBranch = symRef.trim().replace('ref: refs/remotes/', '');
    return remoteHeadBranch;
}

export async function getBranchCommit(absGitCommonDir: string, branchName: string): Promise<string> {
    // a cheaper alternative to repo.getBranch()
    const refPathUnpacked = path.join(absGitCommonDir, 'refs', 'heads', branchName);
    try {
        const commit = (await readFile(refPathUnpacked, 'utf8')).trim();
        return commit;
    } catch (e) {
        const refs = await readPackedRefs(absGitCommonDir);
        const ref = `refs/heads/${branchName}`;
        const commit = refs.get(ref);
        if (commit === undefined) {
            throw new Error(`Could not determine commit for "${branchName}"`);
        }
        return commit;
    }
}

async function readPackedRefs(absGitCommonDir: string): Promise<Map<string,string>> {
    // see https://git-scm.com/docs/git-pack-refs
    const packedRefsPath = path.join(absGitCommonDir, 'packed-refs');
    const content = await readFile(packedRefsPath, 'utf8');
    const regex = /^([0-9a-f]+) (.+)$/;
    return new Map(content.split('\n')
        .map(line => regex.exec(line))
        .filter(g => !!g)
        .map((groups: RegExpExecArray) => [groups[2], groups[1]] as [string, string]));
}

export async function getMergeBase(repo: Repository, headRef: string, baseRef: string): Promise<string> {
    const result = await repo.run(['merge-base', baseRef, headRef]);
    const mergeBase = result.stdout.trim();
    return mergeBase;
}

export async function getHeadModificationDate(absGitDir: string): Promise<Date> {
    const headPath = path.join(absGitDir, 'HEAD');
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
     * T Type change (regular/symlink etc.)
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

export type StatusCode = 'A' | 'D' | 'M' | 'C' | 'U' | 'T'

function sanitizeStatus(status: string): StatusCode {
    if (status == 'U') {
        return 'C';
    }
    if (status.length != 1 || 'ADMT'.indexOf(status) == -1) {
        throw new Error('unsupported git status: ' + status);
    }
    return status as StatusCode;
}

export async function diffIndex(repo: Repository, ref: string): Promise<IDiffStatus[]> {
    // exceptions can happen with newly initialized repos without commits, or when git is busy
    let diffIndexResult = await repo.run(['diff-index',  '--no-renames', '--name-status', ref, '--']);
    let untrackedResult = await repo.run(['ls-files',  '--others', '--exclude-standard']);

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
