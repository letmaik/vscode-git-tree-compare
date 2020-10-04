## 1.10.0

* Add experimental option to automatically change repository when SCM selection changes [#70](https://github.com/letmaik/vscode-git-tree-compare/issues/70)
* Disable automatic refreshes when extension view is not visible [#71](https://github.com/letmaik/vscode-git-tree-compare/issues/71)

## 1.9.2

* Include git index changes in automatic tree refresh triggers
* Log ignored file change events

## 1.9.1

* Removed confusing notification message if extension view is hidden [#65](https://github.com/letmaik/vscode-git-tree-compare/issues/65)
* Always show refresh icon [#66](https://github.com/letmaik/vscode-git-tree-compare/issues/66)

## 1.9.0

* Removed `location` setting as VS Code 1.43 now allows moving views freely
* Fixed "Bad progress location" error [#51](https://github.com/letmaik/vscode-git-tree-compare/issues/51)

## 1.8.1

* Use [built-in VS Code icons](https://github.com/microsoft/vscode-codicons) instead of bundling copies

## 1.8.0

* Updated icons
* Show repository name in view title [#54](https://github.com/letmaik/vscode-git-tree-compare/issues/54)
* Use git extension API to list available repositories [#58](https://github.com/letmaik/vscode-git-tree-compare/issues/58)
* Avoid some unnecessary automatic refreshes
* Fixed initialisation/timing issue [#57](https://github.com/letmaik/vscode-git-tree-compare/issues/57)

## 1.7.3

* Fixed path normalisation issue on Windows [#57](https://github.com/letmaik/vscode-git-tree-compare/issues/57)

## 1.7.2

* Fixed issue opening diff view starting with VS Code 1.42.0 [#56](https://github.com/letmaik/vscode-git-tree-compare/issues/56)

## 1.7.1

* Fixed issue opening diff view starting with VS Code 1.41.0 [#55](https://github.com/letmaik/vscode-git-tree-compare/issues/55)

## 1.7.0

* Added Open All Changes & Open Changed Files at folder level [#49](https://github.com/letmaik/vscode-git-tree-compare/issues/49)
* Fixed custom commit as base not working [#50](https://github.com/letmaik/vscode-git-tree-compare/issues/50)

## 1.6.1

* Fixed icons not displaying

## 1.6.0

* Added buttons for Open File, Open Changes, Change Base, Change Repository (if more than one workspace folder open), and Refresh (if auto refresh is disabled) [#46](https://github.com/letmaik/vscode-git-tree-compare/issues/46)
* Scan for repositories in direct subfolders of workspace folders [#48](https://github.com/letmaik/vscode-git-tree-compare/issues/48)
* Refresh the index to avoid superfluous diff entries if file content is unchanged but modification date has changed [#37](https://github.com/letmaik/vscode-git-tree-compare/issues/37)
* Added `refreshIndex` configuration option (default is enabled) to optionally disable the extra git invocation needed to refresh the index
* Show full paths in tree item tooltips
* Sort subfolders to match the explorer [#45](https://github.com/letmaik/vscode-git-tree-compare/issues/45)
* Fixed various issues when adding/removing workspace folders

## 1.5.0

* Added support for multi-root workspaces [#22](https://github.com/letmaik/vscode-git-tree-compare/issues/22)
* Added support for "full" diff mode (next to the existing merge-based mode) [#44](https://github.com/letmaik/vscode-git-tree-compare/issues/44)
* Fixed issue when base had been removed
* Fixed files outside tree root not being opened when using Open Changed Files / Open All Files commands

## 1.4.0

* Added configuration option to choose location of tree view [#43](https://github.com/letmaik/vscode-git-tree-compare/issues/43)
* Allow to enter custom commit as comparison base [#42](https://github.com/letmaik/vscode-git-tree-compare/issues/42)
* Fixed invoking commands via command palette if extension wasn't activated yet [#40](https://github.com/letmaik/vscode-git-tree-compare/issues/40)

## 1.3.0

* Moved tree view into source control container [#39](https://github.com/letmaik/vscode-git-tree-compare/issues/39)
* Fixed files not appearing if a file was removed and reintroduced without being committed yet [#41](https://github.com/letmaik/vscode-git-tree-compare/issues/41)

## 1.2.1

* Separated heads, tags, remote heads in base selector.
* Disabled "Open File" / "Open Changes" for submodule changes [#33](https://github.com/letmaik/vscode-git-tree-compare/issues/33).
* Added more logging to better diagnose issues.

## 1.2.0

* Added commands to open all changed files / all changes [#29](https://github.com/letmaik/vscode-git-tree-compare/issues/29).
* Added icon for folders which also avoids wrong node alignment [#17](https://github.com/letmaik/vscode-git-tree-compare/issues/17).
* Added `iconsMinimal` config option which allows to switch to a compact icon layout, comparable to the Seti file icon theme.
* Delay auto-refresh if VS Code is out of focus to minimize chances of disrupting a rebase operation or other git commands that need to acquire a lock to work [#24](https://github.com/letmaik/vscode-git-tree-compare/issues/24).
* Fixed extension not working on bigger repositories where git switched to packed refs [#30](https://github.com/letmaik/vscode-git-tree-compare/issues/30).

## 1.1.4

* Fixed extension only working on git >= 2.13, now works on older version again.
  This was caused by changes in the 1.1.3 extension release.

## 1.1.3

* Added support for type change (T) git status
* Fixed extension not working when using `git worktree` [#28](https://github.com/letmaik/vscode-git-tree-compare/issues/28)

## 1.1.2

* Restore original extension activation behaviour (only enable if a git repo is in the workspace)

## 1.1.1

* Fixed extension activation not working on VS Code 1.16.0.
Note that this is a temporary work-around which now always enables the extension, even if the workspace has no git repository (previously the extension would be disabled then). The work-around is necessary due to a [breaking change in VS Code](https://github.com/Microsoft/vscode/issues/33618) and makes sure that the extension keeps working for users with versions older than 1.16.0 as well as for newer versions.
Once VS Code 1.16.0 is rolled out to all users the final fix will be applied and the original behaviour can be restored. 
For details see [#23](https://github.com/letmaik/vscode-git-tree-compare/issues/23).

## 1.1.0

* Added support for detached HEAD, for example when checking out a tag, a remote branch, or a specific commit
* Fixed merge base not being updated if the checked out branch stays the same but points to a different commit, for example after pulling in upstream changes
* Fixed manual refresh not updating the merge base

## 1.0.0

* Initial release