# VCS Group for bb

IntelliJ's Git branches popup, inside bb. A branch button in every thread
header opens a searchable popup with Recent / Local / Remote branches, and
runs Checkout, New Branch, Update Project (fetch + pull) and Push on the
machine that owns the thread's worktree.

Status: milestone 1 shipped (branch popup, checkout, new branch, update,
push). `CLAUDE.md` has the architecture and the dev loop; the Linear project
`bb-plugin-vcs-group` tracks the milestones.

## Install for development

```sh
npm install
bb plugin types              # pin the SDK to your bb
npm run check                # vitest + tsc + bb plugin build
bb plugin install . --yes
bb plugin dev                # rebuild and reload on save
```

`docs/VERIFY.md` has the live click-through and the headless script that
drives it.

## What you get

- A branch button left of bb's own workspace buttons, labelled with the
  current branch (a short sha when detached, icon-only on phones).
- A popup with search, quick actions (Update Project, Fetch, Push, New
  Branch) and Recent / Local / Remote groups with ahead/behind, gone and
  worktree badges. Right-click or the "..." button opens Checkout, New Branch
  from, Copy Branch Name.
- Five command palette rows (`VCS Group: ...`) on thread routes.
- Live refresh: bb's sidebar follows a plugin checkout within a few seconds,
  every open popup for the same environment refetches after an action, and
  external checkouts (agent, terminal) reach open popups through bb's
  environment events.

## Settings

Under Settings → Installed plugins → VCS Group:

- Update Project strategy: `ff-only` (default), `rebase`, `merge`
- Auto-stash before Update Project (off)
- Confirm before push (on): every push shows the exact git command first
- Default remote (`origin`): used when a branch has no usable upstream
- Prune on fetch (on)

## How push decides

The push dialog previews the exact command, and the host runs exactly that
or refuses with a typed error. Nothing depends on `push.default`,
`remote.pushDefault` or `branch.*.pushRemote`:

| Branch state | Command |
|---|---|
| tracks `<remote>/<branch>` on a configured remote | `git push --no-progress --end-of-options <remote> HEAD:refs/heads/<branch>` |
| no upstream, upstream gone, or a local upstream | `git push --no-progress -u --end-of-options <default remote> HEAD` |

The request names the branch the dialog showed; if HEAD moved in the
meantime the host answers `head_changed` and pushes nothing.

## Safety model

- Git only ever runs as `spawn("git", argv)` on the host worker, never
  through a shell. Refs go after `--end-of-options`, paths after `--`.
  Branch names are validated in the UI, at the RPC boundary and by
  `git check-ref-format --branch` on the host.
- bb cancels a host call after 30 s. Every call runs against one 27 s budget:
  each git command gets the time that is left, git runs in its own process
  group and is killed as a group (ssh, credential helpers, pull's children
  included) on timeout or cancel, and the result is a typed `timeout` or
  `cancelled` error rather than a transport failure.
- Nothing runs while `.git/index.lock` exists or a merge, rebase, cherry-pick
  or revert is in progress; the popup tells you why. One action at a time per
  repository; a second caller is told `busy`.
- Push, and Update Project on a dirty tree, ask first and show the command.
  A pull whose autostash fails to re-apply is reported as a `conflict`.
- Command palette requests travel inside the plugin bundle's module scope,
  not in a window event payload, and obey the same enabled/busy guards as a
  click on the row.
- No agent tool or CLI can mutate the repository: the plugin registers none.
  The RPC endpoints behind the popup are bb's local-auth API, like every
  other plugin's, so any local process with the browser's rights (including
  an agent shell) can call them with a thread id, and a mutation on thread T
  runs on T's host. The plugin cannot close that from inside; it logs every
  mutation with its thread id so misuse is at least visible.

## Roadmap

Milestone 2 adds the full per-branch context menu (rebase, merge, compare,
diff with working tree, worktrees, tracked branch, rename, delete), background
push and pull, and live refresh. Milestone 3 is the plugin's own commit
dialog, milestone 4 a git log panel, milestone 5 settings UI, a read-only CLI
and release.
