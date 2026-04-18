import * as path from 'path';
import { promises as fs } from 'fs';

import { window, ProgressLocation } from 'vscode';
import { Repository } from './git/git';
import { Repository as GitAPIRepository } from './typings/git';
import { getAbsGitCommonDir } from './gitHelper';

type LogFn = (msg: string) => void;

interface FetchTarget {
    remote: string;
    branch: string;
    estimatedDepth: number;
}

const DEPTH_FLOOR = 1024;
const DEPTH_STEPS = 4;
const DEPTH_CAP = 1_000_000;

/**
 * If a merge base could not be determined and the repository is a shallow clone,
 * offers the user the option to fetch more history (and as a last resort, unshallow)
 * to resolve the merge base.
 *
 * Returns the discovered merge base, or undefined if the repository is not shallow,
 * the user declined, the user cancelled, or all attempts failed.
 */
export async function tryDeepenForMergeBase(
    repository: Repository,
    gitApiRepo: GitAPIRepository,
    headRef: string,
    headBranchName: string | undefined,
    baseRef: string,
    log: LogFn,
): Promise<string | undefined> {
    const commonDir = await getAbsGitCommonDir(repository);
    const shallowBoundary = await readShallowBoundary(commonDir);
    if (!shallowBoundary) {
        // not a shallow clone; deepening cannot help
        return undefined;
    }
    log(`Repository is a shallow clone (${shallowBoundary.length} boundary commit(s))`);

    const baseTarget = await resolveFetchTarget(repository, baseRef, log);
    if (baseTarget) {
        log(`Base ref "${baseRef}" resolved to fetchable target: ${baseTarget.remote}/${baseTarget.branch}`);
    } else {
        log(`Base ref "${baseRef}" could not be resolved to a fetchable target`);
    }
    const headTarget = headBranchName
        ? await resolveFetchTarget(repository, headBranchName, log)
        : undefined;
    if (headBranchName) {
        if (headTarget) {
            log(`HEAD ref "${headBranchName}" resolved to fetchable target: ${headTarget.remote}/${headTarget.branch}`);
        } else {
            log(`HEAD ref "${headBranchName}" could not be resolved to a fetchable target`);
        }
    } else {
        log('HEAD is detached, skipping HEAD target resolution');
    }

    if (!baseTarget && !headTarget) {
        log('Neither base nor HEAD ref maps to a fetchable remote; cannot deepen.');
        return undefined;
    }

    const targets: FetchTarget[] = [];
    if (baseTarget) targets.push(baseTarget);
    if (headTarget && !sameTarget(headTarget, baseTarget)) targets.push(headTarget);

    const action = 'Fetch more history';
    const choice = await window.showErrorMessage(
        `No merge base could be found between "${headRef}" and "${baseRef}". ` +
        `The repository is a shallow clone — fetching more history may resolve this.`,
        action);
    if (choice !== action) {
        return undefined;
    }

    const headDepth = await estimateTargetDepths(repository, shallowBoundary, targets, log);
    // Sort shallowest first — that's the side most likely to need deepening.
    targets.sort((a, b) => a.estimatedDepth - b.estimatedDepth);
    // Schedule is based on the shallowest depth across all sides (including HEAD,
    // even if it's not a fetchable target), because the merge base can't be found
    // until the shallow side has enough history.
    const minDepth = Math.min(headDepth, ...targets.map(t => t.estimatedDepth));
    const schedule = buildSchedule(minDepth);
    log(`HEAD depth: ${headDepth}`);
    log(`Target depths: ${targets.map(t => `${t.remote}/${t.branch}=${t.estimatedDepth}`).join(', ')}`);
    log(`Min depth (for schedule): ${minDepth}`);
    log(`Deepening schedule: [${schedule.join(', ')}]`);

    const found = await window.withProgress({
        location: ProgressLocation.Notification,
        title: 'Fetching more history',
        cancellable: true,
    }, async (progress, token) => {
        for (const depth of schedule) {
            if (token.isCancellationRequested) return undefined;
            for (const target of targets) {
                if (token.isCancellationRequested) return undefined;
                if (target.estimatedDepth >= depth) {
                    log(`Skipping ${target.remote}/${target.branch} (estimated depth ${target.estimatedDepth} >= ${depth})`);
                    continue;
                }
                progress.report({ message: `Fetching ${target.remote}/${target.branch} at depth ${depth}...` });
                try {
                    log(`Fetching ${target.remote} ${target.branch} --depth=${depth}`);
                    await gitApiRepo.fetch(target.remote, target.branch, depth);
                } catch (e: any) {
                    log(`Fetch failed: ${e.message || e}`);
                    // continue with the next target / depth
                }
            }
            if (token.isCancellationRequested) return undefined;
            const mb = await tryGetMergeBase(repository, headRef, baseRef, log);
            if (mb) return mb;
        }
        return undefined;
    });

    if (found) return found;

    // Last resort: offer to unshallow.
    const unshallow = 'Unshallow';
    const finalChoice = await window.showErrorMessage(
        `Still no merge base found between "${headRef}" and "${baseRef}". ` +
        `Fetch the full repository history?`,
        unshallow);
    if (finalChoice !== unshallow) {
        return undefined;
    }

    return await window.withProgress({
        location: ProgressLocation.Notification,
        title: 'Unshallowing repository',
        cancellable: true,
    }, async (progress, token) => {
        progress.report({ message: 'Fetching full history...' });
        try {
            log('Unshallowing repository (git pull --unshallow)');
            await gitApiRepo.pull(true);
        } catch (e: any) {
            log(`Unshallow failed: ${e.message || e}`);
            return undefined;
        }
        if (token.isCancellationRequested) return undefined;
        return await tryGetMergeBase(repository, headRef, baseRef, log);
    });
}

async function tryGetMergeBase(repository: Repository, ref1: string, ref2: string, log: LogFn): Promise<string | undefined> {
    try {
        const mb = await repository.getMergeBase(ref1, ref2);
        if (mb) {
            log(`Merge base found after deepening: ${mb}`);
            return mb;
        }
    } catch (e: any) {
        log(`getMergeBase still failing: ${e.message || e}`);
    }
    return undefined;
}

/**
 * Reads .git/shallow (in the common gitdir) and returns the boundary commit hashes,
 * or undefined if the repository is not shallow.
 */
async function readShallowBoundary(commonDir: string): Promise<string[] | undefined> {
    const shallowPath = path.join(commonDir, 'shallow');
    let content: string;
    try {
        content = await fs.readFile(shallowPath, 'utf8');
    } catch (e: any) {
        if (e.code === 'ENOENT') return undefined;
        throw e;
    }
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return undefined;
    return lines;
}

/**
 * Resolves a ref to a (remote, branch) pair suitable for `git fetch <remote> <branch>`.
 * Handles:
 *   - remote-tracking refs like "origin/main" or "origin/feature/foo"
 *   - local branches with a configured upstream
 * Returns undefined for detached HEAD, local branches without upstream, or unknown refs.
 */
async function resolveFetchTarget(repository: Repository, ref: string, log: LogFn): Promise<FetchTarget | undefined> {
    let remotes: { name: string }[];
    try {
        remotes = await repository.getRemotes();
    } catch (e: any) {
        log(`Could not list remotes: ${e.message || e}`);
        return undefined;
    }
    if (remotes.length === 0) return undefined;

    // Match against remote-tracking ref pattern: <remote>/<branch...>
    // Sort by name length descending so a remote named "origin/foo" would be matched
    // before "origin", although such names are unusual.
    const sorted = [...remotes].sort((a, b) => b.name.length - a.name.length);
    for (const r of sorted) {
        const prefix = r.name + '/';
        if (ref.startsWith(prefix)) {
            const branch = ref.substring(prefix.length);
            if (branch.length > 0) {
                return { remote: r.name, branch, estimatedDepth: 0 };
            }
        }
    }

    // Try as local branch with upstream
    try {
        const branch = await repository.getBranch(ref);
        if (branch.upstream && branch.upstream.remote && branch.upstream.name) {
            return { remote: branch.upstream.remote, branch: branch.upstream.name, estimatedDepth: 0 };
        }
    } catch (e: any) {
        // not a branch, or no upstream; ignore
    }

    // Last resort: speculatively assume the branch exists on a remote.
    // A failed fetch is handled gracefully (caught and logged).
    if (sorted.length > 0) {
        return { remote: sorted[sorted.length - 1].name, branch: ref, estimatedDepth: 0 };
    }
    return undefined;
}

function sameTarget(a: FetchTarget, b: FetchTarget | undefined): boolean {
    return !!b && a.remote === b.remote && a.branch === b.branch;
}

/**
 * Estimates the current shallow depth for each fetch target and stores it
 * on the target's `estimatedDepth` field. Also probes HEAD.
 * Best-effort: targets default to 0 on failure.
 * Returns the estimated HEAD depth.
 */
async function estimateTargetDepths(
    repository: Repository,
    boundary: string[],
    targets: FetchTarget[],
    log: LogFn,
): Promise<number> {
    // Also probe HEAD to get the best estimate for the head-side target.
    const headDepth = await countCommitsToBoundary(repository, 'HEAD', boundary, log) ?? 0;
    for (const t of targets) {
        const refDepth = await countCommitsToBoundary(
            repository, `refs/remotes/${t.remote}/${t.branch}`, boundary, log) ?? 0;
        // For the head-side target, the remote-tracking ref may not exist yet
        // (e.g. local branch). Use HEAD depth as a better proxy in that case.
        t.estimatedDepth = Math.max(refDepth, refDepth === 0 ? headDepth : 0);
    }
    return headDepth;
}

async function countCommitsToBoundary(repository: Repository, ref: string, boundary: string[], log: LogFn): Promise<number | undefined> {
    const args = ['rev-list', '--count', '--first-parent', ref, ...boundary.map(s => '^' + s)];
    try {
        const result = await repository.exec(args);
        const n = parseInt(result.stdout.trim(), 10);
        if (!isNaN(n)) return n;
    } catch (e: any) {
        log(`Could not count commits for ${ref}: ${e.message || e}`);
    }
    return undefined;
}

function buildSchedule(startDepth: number): number[] {
    const schedule: number[] = [];
    let depth = Math.max(DEPTH_FLOOR, startDepth * 2);
    for (let i = 0; i < DEPTH_STEPS; i++) {
        depth = Math.min(depth, DEPTH_CAP);
        schedule.push(depth);
        if (depth >= DEPTH_CAP) break;
        depth *= 2;
    }
    return schedule;
}
