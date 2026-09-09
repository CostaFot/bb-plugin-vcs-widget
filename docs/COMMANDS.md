# Every command the plugin runs

Git only ever runs as `spawn("git", argv)` on the host worker, never through a
shell. Refs go after `--end-of-options`, paths after `--`, and a commit message
goes on stdin. These tables are the whole of it, so you can read what a row
will do before you click it.

The push is in [How push decides](PUSH.md) instead: that one is behaviour
rather than a list, and it is the answer to "will this force-push my branch".

## The branch menu

| Row | Command |
|---|---|
| Checkout | `git switch --no-guess --end-of-options <name>` / `git switch -c <b> --track --end-of-options refs/remotes/<r>/<b>` |
| Checkout and Rebase onto current | the checkout above, then `git rebase --end-of-options refs/heads/<current>` |
| Rebase current onto | `git rebase --end-of-options refs/heads/<name>` (or `refs/remotes/...`) |
| Merge into current | `git merge --no-edit --end-of-options refs/heads/<name>` |
| Abort | `git merge\|rebase\|cherry-pick\|revert --abort` |
| Update (not checked out) | `git fetch --no-progress --end-of-options <remote> refs/heads/<upstream>:refs/heads/<name>` (fast-forward only) |
| Tracked Branch | `git branch --set-upstream-to=<r>/<b> --end-of-options <name>` / `--unset-upstream` |
| Rename | `git branch -m --end-of-options <from> <to>` |
| Delete | `git branch -d --end-of-options <name>`, then `-D` after a destructive confirm when git says "not fully merged" |
| Delete (remote) | `git push --no-progress --delete --end-of-options <remote> refs/heads/<name>` |
| New Worktree from | `git worktree add --end-of-options <repo>-<name> <name>` (remote: `--track -b <name> ... refs/remotes/<r>/<name>`) |
| Checkout Tag or Revision | `git switch --detach --end-of-options <revision>` |
| Show Log | reads only: `git log --topo-order --decorate=full ...` |

## The git log panel

| Row | Command |
|---|---|
| The list | `git log --topo-order --decorate=full --format=... -n 101 [--skip=<n>] [--grep=<text> --fixed-strings --regexp-ignore-case] (--branches --remotes \| HEAD \| <ref>) --` |
| A commit | `git show --no-patch --decorate=full --format=... <sha> --`, then `git diff --numstat -z -M <parent> <sha> --` (first commit: `git diff-tree --root -r --numstat -z -M <sha> --`) |
| A file in a commit | `git diff --no-color -M <parent> <sha> -- <path>` (first commit: `git show --format= <sha> -- <path>`), plus `git show <rev>:<path>` for the two sides |
| Cherry-Pick | `git cherry-pick --end-of-options <sha>` |
| Revert Commit | `git revert --no-edit --end-of-options <sha>` |
| Reset Current Branch to Here | `git reset --soft\|--mixed\|--hard --end-of-options <sha> --` |

The message filter is `--fixed-strings`, so the box is a literal substring
search and never a regular expression the user did not write. Cherry-Pick and
Revert are off for a merge commit: git needs a parent number there, and picking
one is a dialog this plugin does not have.

## The commit panel

| Control | Command |
|---|---|
| Tick a file (or a group) | `git --literal-pathspecs add -A -- <paths>` |
| Untick a file (or a group) | `git --literal-pathspecs reset -q -- <paths>` (works before the first commit too) |
| Commit | `git commit -F -` with the message on stdin; `--amend`, `--signoff`, `--no-verify` as ticked |
| Commit and Push | the commit, then the push [PUSH.md](PUSH.md) describes, on the overview the commit reported |
| Discard (paths in HEAD) | `git --literal-pathspecs restore --staged --worktree --source=HEAD -- <paths>` |
| Discard (files new to git) | `git --literal-pathspecs rm -q --cached -- <paths>`; the file stays on disk as untracked |
| Discard (untracked files) | `git --literal-pathspecs clean -f -- <paths>`; the file is deleted |
| Diff preview | `git diff [--cached] -M --no-ext-diff -- <path>`, `git show HEAD:<path>` / `:<path>` for the two sides, `git diff --no-index -- /dev/null <path>` for an untracked file |
| Agent Commit | no git at all: it sends "LGTM - Commit" to this thread's agent |
| Agent Commit & Push | no git at all: it sends "LGTM - Commit & Push" to this thread's agent |

The checkbox is the staged state and Commit commits the index, never a path
list, so the list is exactly what the commit will contain. `--literal-pathspecs`
means a path from `git status` can never turn into a glob or pathspec magic.
