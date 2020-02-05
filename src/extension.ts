import { ExtensionContext, workspace, window, Disposable, commands, TreeView, extensions } from 'vscode';

import { NAMESPACE } from './constants'
import { GitTreeCompareProvider, Element } from './treeProvider';
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
    let treeView: TreeView<Element> | null = null;

    commands.registerCommand(NAMESPACE + '.openChanges', node => {
        if (!node) {
            window.showInformationMessage('Right-click on a file in the tree view to use this command.');
            return;
        }
        provider!.openChanges(node);
    });

    commands.registerCommand(NAMESPACE + '.openFile', node => {
        if (!node) {
            window.showInformationMessage('Right-click on a file in the tree view to use this command.');
            return;
        }
        provider!.openFile(node);
    });

    let runAfterInit = (fn: () => any) => {
        if (provider == null) {
            setTimeout(() => runAfterInit(fn), 100);
        } else {
            fn();
        }
    }

    let showCollapsedHint = () => {
        if (!treeView!.visible) {
            const config = workspace.getConfiguration(NAMESPACE);
            const location = config.get<string>('location');
            const tab = location === 'scm' ? 'Source Control' : 'Explorer';
            window.showInformationMessage('Git Tree Compare is hidden! ' +
                `Look for it in the ${tab} tab.`)
        }
    }

    commands.registerCommand(NAMESPACE + '.changeRepository', () => {
        runAfterInit(() => {
            provider!.promptChangeRepository().then(() => {
                showCollapsedHint();
            });
        });
    });
    commands.registerCommand(NAMESPACE + '.changeBase', () => {
        runAfterInit(() => {
            provider!.promptChangeBase().then(() => {
                showCollapsedHint();
            });
        });
    });
    commands.registerCommand(NAMESPACE + '.refresh', () => {
        runAfterInit(() => {
            provider!.manualRefresh().then(() => {
                showCollapsedHint();
            });
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

    createGit(outputChannel).then(async git => {
        const onOutput = (str: string) => outputChannel.append(str);
        git.onOutput.addListener('log', onOutput);
        disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

        provider = new GitTreeCompareProvider(git, gitApi, outputChannel, context.globalState, context.asAbsolutePath);

        treeView = window.createTreeView(
            NAMESPACE,
            {treeDataProvider: provider}
        );
    });
}
