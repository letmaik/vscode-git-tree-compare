import * as path from 'path';
import { promises as fs } from 'fs';

import { workspace, OutputChannel, WorkspaceFolder } from 'vscode';
import { findGit, Git, Repository } from './git/git';
import { Ref, Branch } from './git/api/git';

async function filterAsync<T>(array: T[], filter: (entry: T) => Promise<boolean>) {
    const bits = await Promise.all(array.map(filter));
    return array.filter(_ => bits.shift());
}

async function mapAsync<I,O>(array: I[], map: (entry: I) => Promise<O>) {
    return await Promise.all(array.map(map));
}

export async function createGit(outputChannel: OutputChannel): Promise<Git> {
    const pathHint = workspace.getConfiguration('git').get<string>('path');
    const info = await findGit(pathHint, path => outputChannel.appendLine("Looking for git in: " + path));
    outputChannel.appendLine(`Using git ${info.version} from ${info.path}`);
    return new Git({ gitPath: info.path, version: info.version });
}

export function getWorkspaceFolders(repositoryFolder: string): WorkspaceFolder[] {
    const normRepoFolder = path.normalize(repositoryFolder);
    const allWorkspaceFolders = workspace.workspaceFolders || [];
    const workspaceFolders = allWorkspaceFolders.filter(ws =>
        ws.uri.fsPath === normRepoFolder ||
        // workspace folder is subfolder of repository (or equal)
        ws.uri.fsPath.startsWith(normRepoFolder + path.sep) ||
        // repository is subfolder of workspace folder
        normRepoFolder.startsWith(ws.uri.fsPath + path.sep));
    if (workspaceFolders.length == 0) {
        throw new Error(`Could not find any workspace folder for ${normRepoFolder} ` +
            `in ${allWorkspaceFolders.map(f => f.uri.fsPath)}`);
    }
    return workspaceFolders;
}

export async function getGitRepositoryFolders(git: Git): Promise<string[]> {
    const workspaceFolders = workspace.workspaceFolders || [];
    let localFolders = workspaceFolders.filter(w => w.uri.scheme === 'file').map(w => w.uri.fsPath);

    const config = workspace.getConfiguration('git');
    const autoRepositoryDetection = config.get<boolean | 'subFolders' | 'openEditors'>('autoRepositoryDetection');

    if (autoRepositoryDetection === true || autoRepositoryDetection === 'subFolders') {
        let subfolders: string[] = [];
        for (const localFolder of localFolders) {
			try {
                let children = await fs.readdir(localFolder);
                children = children.filter(child => child !== '.git');
                children = children.map(child => path.join(localFolder, child));
                children = await filterAsync(children, async child => (await fs.stat(child)).isDirectory());
                subfolders = subfolders.concat(children);
            } catch {
                // ignore
            }
        }
        localFolders = localFolders.concat(subfolders);
    }

    const localPossibleGitFolders = await mapAsync(localFolders, async folder => {
        try {
            return await git.getRepositoryRoot(folder);
        } catch {
            return undefined;
        }
    });
    const localGitFolders = localPossibleGitFolders.filter(f => f) as string[];
    const localUniqueGitFolders = [...new Set(localGitFolders)];
    return localUniqueGitFolders;
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
        remote = headBranch.upstream.remote;
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
        symRef = await fs.readFile(symRefPath, 'utf8');
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
        const commit = (await fs.readFile(refPathUnpacked, 'utf8')).trim();
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
    const content = await fs.readFile(packedRefsPath, 'utf8');
    const regex = /^([0-9a-f]+) (.+)$/;
    return new Map((content.split('\n')
        .map(line => regex.exec(line))
        .filter(g => !!g) as RegExpExecArray[])
        .map((groups: RegExpExecArray) => [groups[2], groups[1]] as [string, string]));
}

export async function getMergeBase(repo: Repository, headRef: string, baseRef: string): Promise<string> {
    const result = await repo.run(['merge-base', baseRef, headRef]);
    const mergeBase = result.stdout.trim();
    return mergeBase;
}

export async function getHeadModificationDate(absGitDir: string): Promise<Date> {
    const headPath = path.join(absGitDir, 'HEAD');
    const stats = await fs.stat(headPath);
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

    /** True if this was or is a submodule */
    isSubmodule: boolean
}

const MODE_REGULAR_FILE = '100644';
const MODE_EMPTY = '000000';
const MODE_SUBMODULE = '160000';

class DiffStatus implements IDiffStatus {
    readonly absPath: string;
    readonly isSubmodule: boolean;

    constructor(repo: Repository, public status: StatusCode, relPath: string, srcMode: string, dstMode: string) {
        this.absPath = path.join(repo.root, relPath);
        this.isSubmodule = srcMode == MODE_SUBMODULE || dstMode == MODE_SUBMODULE;
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

// https://git-scm.com/docs/git-diff-index#_raw_output_format
const MODE_LEN = 6;
const SHA1_LEN = 40;
const SRC_MODE_OFFSET = 1;
const DST_MODE_OFFSET = 2 + MODE_LEN;
const STATUS_OFFSET = 2 * MODE_LEN + 2 * SHA1_LEN + 5;
const PATH_OFFSET = STATUS_OFFSET + 2;

export async function diffIndex(repo: Repository, ref: string, refreshIndex: boolean): Promise<IDiffStatus[]> {
    if (refreshIndex) {
        // avoid superfluous diff entries if files only got touched
        // (see https://github.com/letmaik/vscode-git-tree-compare/issues/37)
        try {
            await repo.run(['update-index', '--refresh', '-q']);
        } catch (e) {
            // ignore errors as this is a bonus anyway
        }
    }

    // exceptions can happen with newly initialized repos without commits, or when git is busy
    let diffIndexResult = await repo.run(['diff-index', '--no-renames', ref, '--']);
    let untrackedResult = await repo.run(['ls-files',  '--others', '--exclude-standard']);

    const diffIndexStatuses: IDiffStatus[] = diffIndexResult.stdout.trim().split('\n')
        .filter(line => !!line)
        .map(line =>
            new DiffStatus(repo,
                sanitizeStatus(line[STATUS_OFFSET]),
                line.substr(PATH_OFFSET).trim(),
                line.substr(SRC_MODE_OFFSET, MODE_LEN),
                line.substr(DST_MODE_OFFSET, MODE_LEN)
            )
        );

    const untrackedStatuses: IDiffStatus[] = untrackedResult.stdout.trim().split('\n')
        .filter(line => !!line)
        .map(line => new DiffStatus(repo, 'U' as 'U', line, MODE_EMPTY, MODE_REGULAR_FILE));
    
    const untrackedAbsPaths = new Set(untrackedStatuses.map(status => status.absPath))

    // If a file was removed (D in diff-index) but was then re-introduced and not committed yet,
    // then that file also appears as untracked (in ls-files). We need to decide which status to keep.
    // Since the untracked status is newer it gets precedence.
    const filteredDiffIndexStatuses = diffIndexStatuses.filter(status => !untrackedAbsPaths.has(status.absPath));
        
    const statuses = filteredDiffIndexStatuses.concat(untrackedStatuses);
    statuses.sort((s1, s2) => s1.absPath.localeCompare(s2.absPath))
    return statuses;
}
