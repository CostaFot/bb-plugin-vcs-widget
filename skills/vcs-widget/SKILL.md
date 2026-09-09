---
name: vcs-widget
description: Read the git state of the thread's worktree with `bb vcs-widget` or the `vcs_widget_status` tool, and know which git actions belong to the human. Use when you need the current branch, the upstream, what is staged, the branch lists or recent commits — especially on a thread whose worktree lives on another machine — or before you consider running git yourself. Triggers - branch, git status, ahead/behind, upstream, uncommitted, log, "what branch am I on", commit, push.
---

# Reading git through VCS Widget

The VCS Widget plugin runs git on the machine that owns the thread's worktree.
Its read-only surfaces let you see that repository without a shell, and they
work the same when the worktree is on a connected machine, where `git` in your
own shell would read the wrong disk.

```
bb vcs-widget status                    # branch, upstream, working tree, running job
bb vcs-widget branches                  # local branches with ahead/behind
bb vcs-widget branches --all --limit 20 # local and remote
bb vcs-widget log                       # recent commits on the current branch
bb vcs-widget log --all --grep fix      # every branch, literal message filter
```

Add `--json` for the data instead of the table, `--thread <id>` to read another
thread's worktree. The `vcs_widget_status` tool answers the same three reads
(`section: "status" | "branches" | "log"`) for providers where running a command
is awkward.

## What the plugin will not do for you

Every one of those surfaces reads. There is no plugin command, flag or tool that
checks out, commits, pushes, rebases, merges, resets or deletes anything — that
is deliberate. Those actions belong to the human at the branch popup, the Commit
panel and the Git Log, where each one shows the exact git command and asks
before it runs.

So:

- Do not look for a mutating plugin command; there is none, and a missing flag
  is not a bug to report.
- Do not run `git checkout`, `git commit`, `git push`, `git rebase`,
  `git reset` or `git branch -d` in a shell to work around that. Only run a git
  command that changes the repository when the user asked for that change in
  this conversation.
- When you have made file edits the user should keep, say so and let them
  commit from the Commit panel, or ask before you commit yourself.
- A read is always fine: `bb vcs-widget ...`, `git status`, `git log`,
  `git diff`.

## Reading the output

`status` prints one field per line. Fields only appear when they mean something:
`Operation` when a merge, rebase, cherry-pick or revert is half-finished,
`Index` when `.git/index.lock` exists, `Job` when a fetch, pull, push or commit
the user started is still running. If you see any of those, the repository is
busy — say so rather than trying to work around it.

`branches` marks the current branch with `*`, then the short sha, then the
upstream with `+ahead/-behind`, `(gone)` when the remote-tracking branch is
gone, or `no upstream`. A branch checked out in another worktree is tagged with
that path.

`log` prints `<short sha>  <UTC time>  <author>  <subject>` and the refs each
commit carries. Times are UTC so they read the same from any machine.

## When there is no repository

The commands exit 1 and print why: the thread has no environment, the
environment is not ready, or the workspace is not a git repository. That is an
answer, not a failure to retry.
