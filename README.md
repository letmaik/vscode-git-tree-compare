# Git Tree Compare

This [Visual Studio Code](https://code.visualstudio.com/) extension helps you compare your working tree against a branch or tag in a natural **folder tree structure**.

It is perfect for keeping an eye on what your pull request will look like, a **pull request preview** one could say. You don't have to leave your editor at all anymore!

In bigger projects with many files it also provides **context**, it gives you a quick way to figure out which of those files you have been working on in your feature branch. This comes in handy when you work on several branches in parallel, or simply when you forgot where you left off the following day.

![Screenshot of Git Tree Compare view](screenshots/main.png)

## Features

- Working tree comparison against any branch or tag

- Open Changes or Open File

- Automatic refresh on file changes

- Remembers the comparison branch or tag per workspace

- Log output of all git commands run

## Settings

`gitTreeCompare.autoRefresh` Option to turn off automatic refresh. This can be useful for huge repositories when diff operations take a long time. As a temporary work-around (until it is possible to detect when VS Code is out of focus) disabling auto refresh also prevents issues when doing `git rebase` from the command line (see the related issue [Microsoft/vscode#11918](https://github.com/Microsoft/vscode/issues/11918) in VS Code's native git extension). A manual refresh can be triggered via the tree menu. Note that automatic refreshs are not triggered by changes to files outside the workspace folder (which can happen when opening a subdirectory of the repository root as workspace folder).

`gitTreeCompare.openChanges` Option which decides what should happen when clicking on a file in the tree - either open the changes, or the file itself. Default is to open the changes. The other action can always be accessed via the file's context menu.

`gitTreeCompare.root` Determines what the tree root should be when the workspace folder is not the same as the repository root. Default is to make the workspace folder the tree root. Any changes outside the workspace folder are then displayed in a special `/` node.

`gitTreeCompare.includeFilesOutsideWorkspaceRoot` Determines whether to display the special `/` node when the tree root is not the repository root and there are changes outside the workspace folder. Default is to display the `/` node.
