const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Only the editor boundary is stubbed; comparisons use real Git repositories,
// symlinks, worktrees and the compiled extension code.
const vscode = {
    EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
    },
    Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    commands: { executeCommand: async (...args) => args },
};
const originalLoad = Module._load;
let Git, GitTreeCompareProvider, getDiffStatuses;
try {
    Module._load = function (request, ...args) {
        return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
    };
    ({ Git } = require('../out/git/git'));
    ({ GitTreeCompareProvider } = require('../out/treeProvider'));
    ({ getDiffStatuses } = require('../out/gitHelper'));
} finally {
    Module._load = originalLoad;
}

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(t) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-compare-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const directory = fs.realpathSync(temporary);
    const root = path.join(directory, 'repository with spaces');
    fs.mkdirSync(root);
    git(root, 'init', '-q');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n');
    git(root, 'add', 'tracked.txt');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
        'commit', '-qm', 'Initial commit');
    return { directory, root };
}

function provider(workspaceRoot, openRoots) {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot) }];
    const gitApi = {
        repositories: openRoots.map(root => ({ rootUri: vscode.Uri.file(root) })),
        toGitUri: (uri, ref) => ({ ...uri, scheme: 'git', ref }),
    };
    const result = new GitTreeCompareProvider(
        new Git({ gitPath: 'git', version: '', userAgent: '' }), gitApi,
        { appendLine() {} }, { get: (_key, fallback) => fallback }, value => value);
    // File watching is an editor concern, not part of repository discovery.
    result.addExtraRepositoryWatcher = () => {};
    return result;
}

test('preserves the registered symlink path in both diff endpoints', async t => {
    const { directory, root } = fixture(t);
    const alias = path.join(directory, 'workspace link');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.notEqual(git(alias, 'rev-parse', '--show-toplevel'), alias);
    fs.writeFileSync(path.join(alias, 'tracked.txt'), 'after\n');

    const tree = provider(alias, [alias]);
    const comparison = await tree.createComparison(alias, 0);
    assert.equal(comparison.repoRoot, alias);
    assert.equal(comparison.workspaceFolder, alias);
    assert.equal(comparison.isOutsideWorkspace, false);

    const [change] = await getDiffStatuses(comparison.repository, 'HEAD', false, 50, false, false, false);
    comparison.mergeBase = 'HEAD';
    const [command, left, right] = await tree.doOpenChanges(
        comparison, change.srcAbsPath, change.dstAbsPath, change.status);
    assert.equal(command, 'vscode.diff');
    assert.equal(left.fsPath, path.join(alias, 'tracked.txt'));
    assert.equal(right.fsPath, left.fsPath);
    assert.equal(git(alias, 'show', `${left.ref}:${path.relative(alias, left.fsPath)}`), 'before');
    assert.equal(fs.readFileSync(right.fsPath, 'utf8'), 'after\n');
});

test('keeps a registered canonical repository root', async t => {
    const { root } = fixture(t);
    const tree = provider(root, [root]);
    const comparison = await tree.createComparison(root, 0);
    assert.equal(comparison.repoRoot, root);
    assert.equal(comparison.isOutsideWorkspace, false);
});

test('resolves an unregistered subdirectory to its repository root', async t => {
    const { root } = fixture(t);
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    const tree = provider(nested, []);
    const comparison = await tree.createComparison(nested, 0);
    assert.equal(comparison.repoRoot, root);
    assert.equal(comparison.workspaceFolder, nested);
});

test('does not select the parent repository for an unopened nested worktree', async t => {
    const { root } = fixture(t);
    const worktree = path.join(root, 'nested worktree');
    git(root, 'worktree', 'add', '-q', '-b', 'other', worktree);
    const tree = provider(root, [root]);
    const comparison = await tree.createComparison(worktree, 0);
    assert.equal(comparison.repoRoot, worktree);
    assert.equal(await comparison.repository.exec(['branch', '--show-current']).then(r => r.stdout.trim()), 'other');
});

test('can still open a linked worktree outside the workspace', async t => {
    const { directory, root } = fixture(t);
    const worktree = path.join(directory, 'linked worktree');
    git(root, 'worktree', 'add', '-q', '-b', 'other', worktree);
    const tree = provider(root, [root]);
    const comparison = await tree.createComparison(worktree, 0);
    assert.equal(comparison.repoRoot, worktree);
    assert.equal(comparison.isOutsideWorkspace, true);
});
