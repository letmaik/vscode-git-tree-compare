import * as path from 'path';
import { promises as fs } from 'fs';

import { workspace, OutputChannel, WorkspaceFolder } from 'vscode';
import { Git, Repository } from './git/git';
import { Ref, Branch } from './git/api/git';
import { normalizePath } from './fsUtils';
import { API as GitAPI } from './typings/git';

export async function createGit(gitApi: GitAPI, outputChannel: OutputChannel): Promise<Git> {
    outputChannel.appendLine(`Using git from ${gitApi.git.path}`);
    return new Git({
        gitPath: gitApi.git.path,
        userAgent: '',
        version: '',
    });
}

export function getWorkspaceFolders(repositoryFolder: string): WorkspaceFolder[] {
    const normRepoFolder = normalizePath(repositoryFolder);
    const allWorkspaceFolders = workspace.workspaceFolders || [];
    const workspaceFolders = allWorkspaceFolders.filter(ws => {
        const normWsFolder = normalizePath(ws.uri.fsPath);
        return normWsFolder === normRepoFolder ||
            // workspace folder is subfolder of repository (or equal)
            normWsFolder.startsWith(normRepoFolder + path.sep) ||
            // repository is subfolder of workspace folder
            normRepoFolder.startsWith(normWsFolder + path.sep);
    });
    return workspaceFolders;
}

export function getGitRepositoryFolders(git: GitAPI, selectedFirst=false): string[] {
    let repos = git.repositories;
    if (selectedFirst) {
        repos = [...repos];
        repos.sort((r1, r2) => (r2.ui.selected as any) - (r1.ui.selected as any));
    }
    const rootPaths = repos.map(r => r.rootUri.fsPath).filter(p => getWorkspaceFolders(p).length > 0);
    return rootPaths;
}

export async function getAbsGitDir(repo: Repository): Promise<string> {
    // We don't use --absolute-git-dir here as that requires git >= 2.13.
    let res = await repo.exec(['rev-parse', '--git-dir']);
    let dir = res.stdout.trim();
    if (!path.isAbsolute(dir)) {
        dir = path.join(repo.root, dir);
    }
    return dir;
}

export async function getAbsGitCommonDir(repo: Repository): Promise<string> {
    let res = await repo.exec(['rev-parse', '--git-common-dir']);
    let dir = res.stdout.trim();
    if (!path.isAbsolute(dir)) {
        dir = path.join(repo.root, dir);
    }
    return dir;
}

export async function getDefaultBranch(repo: Repository, head: Ref): Promise<string | undefined> {
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
    const remoteHead = `refs/remotes/${remote}/HEAD`;
    try {
        const result = await repo.exec(['symbolic-ref', '--short', remoteHead]);
        const remoteHeadBranch = result.stdout.trim();
        return remoteHeadBranch;
    } catch (e) {
        return;
    }
}

export async function getBranchCommit(branchName: string, repo: Repository): Promise<string> {
    // a cheaper alternative to repo.getBranch()
    // Uses git rev-parse which works with all ref storage formats (traditional, packed-refs, reftable)
    try {
        const result = await repo.exec(['rev-parse', `refs/heads/${branchName}`]);
        const commit = result.stdout.trim();
        if (commit) {
            return commit;
        }
    } catch (e) {
        // Branch doesn't exist or other error
    }
    throw new Error(`Could not determine commit for "${branchName}"`);
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
     * R Renaming of a file
     * C File has merge conflicts
     * U Untracked file
     * T Type change (regular/symlink etc.)
     */
    status: StatusCode

    /** absolute path to src file on disk */
    srcAbsPath: string

    /** absolute path to dst file on disk */
    dstAbsPath: string

    /** True if this was or is a submodule */
    isSubmodule: boolean
}

const MODE_REGULAR_FILE = '100644';
const MODE_EMPTY = '000000';
const MODE_SUBMODULE = '160000';

class DiffStatus implements IDiffStatus {
    readonly srcAbsPath: string;
    readonly dstAbsPath: string;
    readonly isSubmodule: boolean;

    constructor(repoRoot: string, public status: StatusCode, srcRelPath: string, dstRelPath: string | undefined, srcMode: string, dstMode: string) {
        this.srcAbsPath = path.join(repoRoot, srcRelPath);
        this.dstAbsPath = dstRelPath ? path.join(repoRoot, dstRelPath) : this.srcAbsPath;
        this.isSubmodule = srcMode == MODE_SUBMODULE || dstMode == MODE_SUBMODULE;
    }
}

export type StatusCode = 'A' | 'D' | 'M' | 'C' | 'U' | 'T' | 'R';

function sanitizeStatus(status: string): StatusCode {
    if (status == 'U') {
        return 'C';
    }
    if (status.length != 1 || 'ADMTR'.indexOf(status) == -1) {
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

function parseDiffIndexOutput(repoRoot: string, out: string): IDiffStatus[] {
    const entries: IDiffStatus[] = [];
    while (out) {
        const srcMode = out.substr(SRC_MODE_OFFSET, MODE_LEN);
        const dstMode = out.substr(DST_MODE_OFFSET, MODE_LEN);
        const status = out[STATUS_OFFSET];
        out = out.substr(STATUS_OFFSET + 1);
        let srcPathStart = out.indexOf('\0') + 1;
        out = out.substr(srcPathStart);
        let nextNul = out.indexOf('\0');
        const srcPath = out.substring(0, nextNul);
        out = out.substr(nextNul + 1);
        let dstPath: string | undefined;
        if (status === 'C' || status === 'R') {
            nextNul = out.indexOf('\0');
            dstPath = out.substring(0, nextNul);
            out = out.substr(nextNul + 1);
        }
        entries.push(new DiffStatus(
            repoRoot,
            sanitizeStatus(status),
            srcPath, dstPath,
            srcMode, dstMode));
    }
    return entries;
}

export async function diffIndex(repo: Repository, ref: string, refreshIndex: boolean, findRenames: boolean, renameThreshold: number): Promise<IDiffStatus[]> {
    if (refreshIndex) {
        // avoid superfluous diff entries if files only got touched
        // (see https://github.com/letmaik/vscode-git-tree-compare/issues/37)
        try {
            await repo.exec(['update-index', '--refresh', '-q']);
        } catch (e) {
            // ignore errors as this is a bonus anyway
        }
    }

    // exceptions can happen with newly initialized repos without commits, or when git is busy
    const renamesFlag = findRenames ? `--find-renames=${renameThreshold}%`  : '--no-renames';
    let diffIndexResult = await repo.exec(['diff-index', '-z', renamesFlag, ref, '--']);
    let untrackedResult = await repo.exec(['ls-files', '-z', '--others', '--exclude-standard']);

    const repoRoot = normalizePath(repo.root);
    const diffIndexStatuses = parseDiffIndexOutput(repoRoot, diffIndexResult.stdout);

    const untrackedStatuses: IDiffStatus[] = untrackedResult.stdout.split('\0')
        .slice(0, -1)
        .map(line => new DiffStatus(repoRoot, 'U' as 'U', line, undefined, MODE_EMPTY, MODE_REGULAR_FILE));

    const untrackedAbsPaths = new Set(untrackedStatuses.map(status => status.dstAbsPath))

    // If a file was removed (D in diff-index) but was then re-introduced and not committed yet,
    // then that file also appears as untracked (in ls-files). We need to decide which status to keep.
    // Since the untracked status is newer it gets precedence.
    const filteredDiffIndexStatuses = diffIndexStatuses.filter(status => !untrackedAbsPaths.has(status.srcAbsPath));

    const statuses = filteredDiffIndexStatuses.concat(untrackedStatuses);
    statuses.sort((s1, s2) => s1.dstAbsPath.localeCompare(s2.dstAbsPath))
    return statuses;
}

export async function hasUncommittedChanges(repo: Repository, path: string): Promise<boolean> {
    const result = await repo.exec(['status', '-z', path]);
    return result.stdout.trim() !== '';
}

export async function rmFile(repo: Repository, absPath: string): Promise<void> {
    await repo.exec(['rm', '-f', absPath]);
}
