import { ExtensionContext, window, Disposable, commands, extensions } from 'vscode';

import { NAMESPACE } from './constants'
import { GitTreeCompareProvider } from './treeProvider';
import { createGit } from './gitHelper';
import { toDisposable } from './git/util';
import { GitExtension } from './typings/git';

export function activate(context: ExtensionContext) {
    const disposables: Disposable[] = [];
    context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

    const outputChannel = window.createOutputChannel('Git Tree Compare');
    disposables.push(outputChannel);

    const gitExt = extensions.getExtension<GitExtension>('vscode.git')!.exports;
    const gitApi = gitExt.getAPI(1);

    let provider: GitTreeCompareProvider | null = null;

    let runAfterInit = (fn: () => any) => {
        if (provider == null) {
            setTimeout(() => runAfterInit(fn), 100);
        } else {
            fn();
        }
    }

    commands.registerCommand(NAMESPACE + '.openChanges', node => {
        runAfterInit(() => {
            provider!.openChanges(node);
        });
    });

    commands.registerCommand(NAMESPACE + '.openFile', (node, nodes) => {
        runAfterInit(() => {
            provider!.openFile(nodes || [node]);
        });
    });

    commands.registerCommand(NAMESPACE + '.discardChanges', (node, nodes) => {
        runAfterInit(() => {
            provider!.discardChanges(nodes || [node]);
        });
    });

    commands.registerCommand(NAMESPACE + '.discardAllChanges', node => {
        runAfterInit(() => {
            provider!.discardAllChanges(node);
        });
    });

    commands.registerCommand(NAMESPACE + '.changeRepository', () => {
        runAfterInit(() => {
            provider!.promptChangeRepository();
        });
    });
    commands.registerCommand(NAMESPACE + '.changeBase', node => {
        runAfterInit(() => {
            provider!.promptChangeBase(node);
        });
    });
    commands.registerCommand(NAMESPACE + '.compareGitHubPullRequest', node => {
        runAfterInit(() => {
            provider!.compareGitHubPullRequest(node);
        });
    });
    commands.registerCommand(NAMESPACE + '.refresh', node => {
        runAfterInit(() => {
            provider!.manualRefresh(node);
        });
    });
    commands.registerCommand(NAMESPACE + '.refreshAll', () => {
        runAfterInit(() => {
            provider!.manualRefreshAll();
        });
    });
    commands.registerCommand(NAMESPACE + '.openAllChanges', node => {
        runAfterInit(() => provider!.openAllChanges(node));
    });
    commands.registerCommand(NAMESPACE + '.openChangedFiles', node => {
        runAfterInit(() => provider!.openChangedFiles(node));
    });
    commands.registerCommand(NAMESPACE + '.switchToFullDiff', () => {
        runAfterInit(() => provider!.switchToFullDiff());
    });
    commands.registerCommand(NAMESPACE + '.switchToMergeDiff', () => {
        runAfterInit(() => provider!.switchToMergeDiff());
    });
    commands.registerCommand(NAMESPACE + '.showCheckboxes', () => {
        runAfterInit(() => provider!.hideCheckboxes(false));
    });
    commands.registerCommand(NAMESPACE + '.hideCheckboxes', () => {
        runAfterInit(() => provider!.hideCheckboxes(true));
    });
    commands.registerCommand(NAMESPACE + '.viewAsList', () => {
        runAfterInit(() => provider!.viewAsTree(false));
    });
    commands.registerCommand(NAMESPACE + '.viewAsTree', () => {
        runAfterInit(() => provider!.viewAsTree(true));
    });
    commands.registerCommand(NAMESPACE + '.hideCheckedInTree', () => {
        runAfterInit(() => provider!.setHideCheckedFiles(true));
    });
    commands.registerCommand(NAMESPACE + '.showCheckedInTree', () => {
        runAfterInit(() => provider!.setHideCheckedFiles(false));
    });
    commands.registerCommand(NAMESPACE + '.searchChanges', node => {
        runAfterInit(() => provider!.searchChanges(node));
    });
    commands.registerCommand(NAMESPACE + '.collapseAll', () => {
        runAfterInit(() => provider!.collapseAll());
    });
    commands.registerCommand(NAMESPACE + '.filterFiles', node => {
        runAfterInit(() => provider!.filterFiles(node));
    });
    commands.registerCommand(NAMESPACE + '.clearFilter', node => {
        runAfterInit(() => provider!.clearFilter(node));
    });
    commands.registerCommand(NAMESPACE + '.copyPath', node => {
        runAfterInit(() => provider!.copyPath(node));
    });
    commands.registerCommand(NAMESPACE + '.copyRelativePath', node => {
        runAfterInit(() => provider!.copyRelativePath(node));
    });
    commands.registerCommand(NAMESPACE + '.sortByName', () => {
        runAfterInit(() => provider!.sortByName());
    });
    commands.registerCommand(NAMESPACE + '.sortByPath', () => {
        runAfterInit(() => provider!.sortByPath());
    });
    commands.registerCommand(NAMESPACE + '.sortByStatus', () => {
        runAfterInit(() => provider!.sortByStatus());
    });
    commands.registerCommand(NAMESPACE + '.sortByRecentlyModified', () => {
        runAfterInit(() => provider!.sortByRecentlyModified());
    });

    commands.registerCommand(NAMESPACE + '.openChangesWithDifftool', node => {
        runAfterInit(() => provider!.openChangesWithDifftool(node));
    });

    createGit(gitApi, outputChannel).then(async git => {
        const onOutput = (str: string) => outputChannel.append(str);
        git.onOutput.addListener('log', onOutput);
        disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

        // Set initial context for menu enablement (starts in tree view mode)
        commands.executeCommand('setContext', NAMESPACE + '.viewAsList', false);
        commands.executeCommand('setContext', NAMESPACE + '.hideCheckedFiles', false);
        commands.executeCommand('setContext', NAMESPACE + '.isFiltered', false);
        commands.executeCommand('setContext', NAMESPACE + '.showRepositoryNodes', false);

        provider = new GitTreeCompareProvider(git, gitApi, outputChannel, context.globalState, context.asAbsolutePath);

        const treeView = window.createTreeView(
            NAMESPACE,
            {
                treeDataProvider: provider,
                canSelectMany: true,
            }
        );

        disposables.push(provider, treeView);
        void provider.init(treeView).catch(error => {
            outputChannel.appendLine(`Initializing Git Tree Compare failed: ${error.message}`);
            window.showErrorMessage(`Initializing Git Tree Compare failed: ${error.message}`);
        });
    });
}
