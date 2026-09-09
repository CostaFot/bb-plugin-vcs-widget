# Safety model

What the plugin will and will not do to your repository.

## How git runs

Git only ever runs as `spawn("git", argv)` on the host worker, on the machine
that owns the worktree, never through a shell. Refs go after
`--end-of-options`, paths after `--literal-pathspecs ... --`, and a commit
message goes on git's stdin instead of becoming an argument.

[Every command it runs](COMMANDS.md) lists the exact argv behind every menu row,
log row and commit control. Being able to read them is the point of installing
this rather than something that hides them.

## What asks first

Push, merge, rebase, delete, worktree, detached checkout, amend, cherry-pick,
revert, reset, and Update Project on a dirty tree all show the command before
they run it. Forced deletes, remote deletes, `reset --hard` and every discard
are destructive confirms.

The log's actions name the sha the row showed, never a branch name that could
have moved since. Push works the same way, with more to say about it:
[how push decides](PUSH.md).

## What blocks a mutation

Nothing mutates while `.git/index.lock` exists, a merge, rebase, cherry-pick or
revert is in progress, or a job holds the repository. The popup says which, and
offers Abort or Cancel. One mutation at a time per repository.

Network work runs as a job rather than inside a request, so a slow remote cannot
hit bb's call deadline. Anything that does time out is killed as a process
group, ssh and credential helpers included.

## Agents and terminals

**No agent tool or CLI can mutate the repository.** `bb vcs-widget` and
`vcs_widget_status` reach exactly two of the host's reads, and there is no
argument that turns either into a write.

Agent Commit and Agent Commit & Push send one of two fixed lines to the thread
as an ordinary user message, and the caller names a variant, never the text. It
widens nothing: whatever can call it can already send the thread any message it
likes through bb's own API.

## What it does not close

The RPC endpoints behind the popup are a different matter, and worth knowing
before you install. They are bb's local-auth API, like every other plugin's, so
any local process holding the browser's rights — an agent shell included — can
call them with a thread id, and a mutation on thread T runs on T's host.

The plugin cannot close that from inside. It logs every mutation and every job
with the thread that asked for it, so misuse is at least visible.
