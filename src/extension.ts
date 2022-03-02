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

    commands.registerCommand(NAMESPACE + '.openFile', node => {
        runAfterInit(() => {
            provider!.openFile(node);
        });
    });

    commands.registerCommand(NAMESPACE + '.changeRepository', () => {
        runAfterInit(() => {
            provider!.promptChangeRepository();
        });
    });
    commands.registerCommand(NAMESPACE + '.changeBase', () => {
        runAfterInit(() => {
            provider!.promptChangeBase();
        });
    });
    commands.registerCommand(NAMESPACE + '.refresh', () => {
        runAfterInit(() => {
            provider!.manualRefresh();
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
    commands.registerCommand(NAMESPACE + '.viewAsList', () => {
        runAfterInit(() => provider!.viewAsTree(false));
    });
    commands.registerCommand(NAMESPACE + '.viewAsTree', () => {
        runAfterInit(() => provider!.viewAsTree(true));
    });

    createGit(gitApi, outputChannel).then(async git => {
        const onOutput = (str: string) => outputChannel.append(str);
        git.onOutput.addListener('log', onOutput);
        disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

        provider = new GitTreeCompareProvider(git, gitApi, outputChannel, context.globalState, context.asAbsolutePath);

        const treeView = window.createTreeView(
            NAMESPACE,
            {treeDataProvider: provider}
        );

        provider.init(treeView);
    });
}
