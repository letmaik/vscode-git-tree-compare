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

export interface IWorktreeInfo {
    path: string;
    head: string;
    branch: string | undefined;
}

export async function listWorktrees(repo: Repository): Promise<IWorktreeInfo[]> {
    const result = await repo.exec(['worktree', 'list', '--porcelain']);
    const worktrees: IWorktreeInfo[] = [];
    let currentPath: string | undefined;
    let currentHead: string | undefined;
    let currentBranch: string | undefined;

    const flush = () => {
        if (currentPath && currentHead) {
            worktrees.push({ path: normalizePath(currentPath), head: currentHead, branch: currentBranch });
        }
        currentPath = currentHead = currentBranch = undefined;
    };

    for (const line of result.stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
            flush();
            currentPath = line.slice('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
            currentHead = line.slice('HEAD '.length);
        } else if (line.startsWith('branch refs/heads/')) {
            currentBranch = line.slice('branch refs/heads/'.length);
        }
    }
    flush(); // flush the last entry
    return worktrees;
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

export interface IDiffStats {
    insertions: number | undefined;
    deletions: number | undefined;
    isBinary: boolean;
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

    /** Per-file insertion/deletion counts (undefined when stats are disabled or unavailable) */
    stats: IDiffStats | undefined;
}

const MODE_REGULAR_FILE = '100644';
const MODE_EMPTY = '000000';
const MODE_SUBMODULE = '160000';

class DiffStatus implements IDiffStatus {
    readonly srcAbsPath: string;
    readonly dstAbsPath: string;
    readonly isSubmodule: boolean;
    stats: IDiffStats | undefined;

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

// https://git-scm.com/docs/git-diff#_raw_output_format
const MODE_LEN = 6;
const SHA1_LEN = 40;
const SRC_MODE_OFFSET = 1;
const DST_MODE_OFFSET = 2 + MODE_LEN;
const STATUS_OFFSET = 2 * MODE_LEN + 2 * SHA1_LEN + 5;

function parseDiffRawOutput(repoRoot: string, out: string): IDiffStatus[] {
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

function parseDiffNumstat(repoRoot: string, out: string): Map<string, IDiffStats> {
    const stats = new Map<string, IDiffStats>();
    const lines = out.split('\n').filter(line => line.length > 0);
    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 3) {
            continue;
        }
        const [ins, del, ...pathParts] = parts;
        const relPath = pathParts.join('\t');
        const absPath = path.join(repoRoot, relPath);
        if (ins === '-' && del === '-') {
            stats.set(absPath, { insertions: undefined, deletions: undefined, isBinary: true });
        } else {
            stats.set(absPath, { insertions: parseInt(ins, 10), deletions: parseInt(del, 10), isBinary: false });
        }
    }
    return stats;
}

const BINARY_CHECK_BYTES = 8192;

async function computeUntrackedStats(entries: IDiffStatus[]): Promise<void> {
    await Promise.all(entries.map(async (entry) => {
        try {
            const buf = Buffer.alloc(BINARY_CHECK_BYTES);
            const handle = await fs.open(entry.dstAbsPath, 'r');
            try {
                const { bytesRead } = await handle.read(buf, 0, BINARY_CHECK_BYTES, 0);
                if (buf.subarray(0, bytesRead).includes(0)) {
                    entry.stats = { insertions: undefined, deletions: undefined, isBinary: true };
                    return;
                }
            } finally {
                await handle.close();
            }
            const content = await fs.readFile(entry.dstAbsPath, 'utf-8');
            const lines = content.split('\n');
            const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
            entry.stats = { insertions: lineCount, deletions: 0, isBinary: false };
        } catch {
            // File may be inaccessible
        }
    }));
}

export async function getDiffStatuses(repo: Repository, ref: string, refreshIndex: boolean, findRenames: boolean, renameThreshold: number, omitUntrackedFiles: boolean, omitUnstagedChanges: boolean, showDiffStats: boolean = false): Promise<IDiffStatus[]> {
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
    const repoRoot = normalizePath(repo.root);
    const renamesFlag = findRenames ? `--find-renames=${renameThreshold}%`  : '--no-renames';
    // Use `git diff` rather than `git diff-index` here so that the result is
    // based on the final working tree contents. `diff-index` may report a
    // stat-dirty file with an all-zero destination object ID without checking
    // whether its contents actually match the comparison ref.
    //
    // Raw `git diff` output abbreviates object IDs by default, while the parser
    // below expects the 40-character format previously emitted by diff-index.
    const diffArgs = ['diff', '--raw', '--abbrev=40', '-z', renamesFlag];
    if (omitUnstagedChanges) {
        diffArgs.push('--cached');
    }
    diffArgs.push(ref, '--');
    const diffResult = await repo.exec(diffArgs);
    
    let untrackedStatuses: IDiffStatus[] = [];
    if (!omitUntrackedFiles) {
        let untrackedResult = await repo.exec(['ls-files', '-z', '--others', '--exclude-standard']);
        untrackedStatuses = untrackedResult.stdout.split('\0')
            .slice(0, -1)
            .map(line => new DiffStatus(repoRoot, 'U' as 'U', line, undefined, MODE_EMPTY, MODE_REGULAR_FILE));
    }

    const diffStatuses = parseDiffRawOutput(repoRoot, diffResult.stdout);

    const untrackedAbsPaths = new Set(untrackedStatuses.map(status => status.dstAbsPath))

    // If a file was removed (D in diff) but was then re-introduced and not committed yet,
    // then that file also appears as untracked (in ls-files). We need to decide which status to keep.
    // Since the untracked status is newer it gets precedence.
    const filteredDiffStatuses = diffStatuses.filter(status => !untrackedAbsPaths.has(status.srcAbsPath));

    const statuses = filteredDiffStatuses.concat(untrackedStatuses);

    if (showDiffStats) {
        const numstatArgs = ['diff', '--numstat', renamesFlag];
        if (omitUnstagedChanges) {
            numstatArgs.push('--cached');
        }
        numstatArgs.push(ref, '--');
        const numstatResult = await repo.exec(numstatArgs);
        const numstatMap = parseDiffNumstat(repoRoot, numstatResult.stdout);
        for (const entry of statuses) {
            const fileStats = numstatMap.get(entry.dstAbsPath) || numstatMap.get(entry.srcAbsPath);
            if (fileStats) {
                entry.stats = fileStats;
            }
        }

        if (untrackedStatuses.length > 0) {
            await computeUntrackedStats(untrackedStatuses);
        }
    }

    statuses.sort((s1, s2) => s1.dstAbsPath.localeCompare(s2.dstAbsPath))
    return statuses;
}

export async function hasUncommittedChanges(repo: Repository, path: string, ignoreUntracked: boolean = false): Promise<boolean> {
    const args = ['status', '-z'];
    if (ignoreUntracked) {
        args.push('-uno');
    }
    args.push(path);
    const result = await repo.exec(args);
    return result.stdout.trim() !== '';
}

export async function rmFile(repo: Repository, absPath: string): Promise<void> {
    await repo.exec(['rm', '-f', absPath]);
}
