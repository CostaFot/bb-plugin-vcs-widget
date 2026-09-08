# VCS Group for bb

IntelliJ's Git branches popup, inside bb. A branch button in every thread
header opens a searchable popup with Recent / Local / Remote branches, and
runs Checkout, New Branch, Update Project (fetch + pull) and Push on the
machine that owns the thread's worktree.

Status: milestone 1 in progress. See `CLAUDE.md` for the architecture, the
dev loop and the Linear project that tracks the work.

## Install for development

```sh
npm install
bb plugin types              # pin the SDK to your bb
npm run check                # vitest + tsc + bb plugin build
bb plugin install . --yes
bb plugin dev                # rebuild and reload on save
```

## Settings

Under Settings → Installed plugins → VCS Group:

- Update Project strategy: `ff-only` (default), `rebase`, `merge`
- Auto-stash before Update Project (off)
- Confirm before push (on): every push shows the exact git command first
- Default remote (`origin`)
- Prune on fetch (on)

## Safety model

- Git only ever runs as `execFile("git", argv)` on the host worker, never
  through a shell. Branch names are validated in the UI, at the RPC boundary
  and by `git check-ref-format --branch` on the host.
- Nothing runs while `.git/index.lock` exists or a merge, rebase, cherry-pick
  or revert is in progress; the popup tells you why.
- Push, and Update Project on a dirty tree, ask first and show the command.
- No agent tool or CLI can mutate the repository. Only a human click reaches
  a mutating action.

## Roadmap

Milestone 2 adds the full per-branch context menu (rebase, merge, compare,
diff with working tree, worktrees, tracked branch, rename, delete), background
push and pull, and live refresh. Milestone 3 is the plugin's own commit
dialog, milestone 4 a git log panel, milestone 5 settings UI, a read-only CLI
and release.
