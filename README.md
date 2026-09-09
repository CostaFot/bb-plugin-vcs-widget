# VCS Group for bb

IntelliJ's Git branches popup, inside bb. A branch button in every thread
header opens a searchable popup with Favorites / Recent / Local / Remote
branches, the full per-branch context menu, and background fetch, pull and
push, all running on the machine that owns the thread's worktree.

Status: milestone 2 shipped (full context menu, background jobs, live
refresh from the host, favourites, compare and diff panels). `CLAUDE.md` has
the architecture and the dev loop; the Linear project `bb-plugin-vcs-group`
tracks the milestones.

## Install for development

```sh
npm install
bb plugin types              # pin the SDK to your bb
npm run check                # vitest + tsc + bb plugin build
bb plugin install . --yes
bb plugin dev                # rebuild and reload on save
```

`docs/VERIFY.md` has the live click-throughs and the headless scripts that
drive them.

## What you get

- A branch button left of bb's own workspace buttons, labelled with the
  current branch (a short sha when detached, icon-only on phones).
- A popup with search, quick actions (Update Project, Fetch, Push, New
  Branch, Checkout Tag or Revision) and Favorites / Recent / Local / Remote
  groups with ahead/behind, gone and worktree badges. A star on each row
  toggles a favourite; favourites are kept per host and repository.
- Right-click or the "..." button opens the IntelliJ menu: Checkout, New
  Branch from, Checkout and Rebase onto the current branch, Checkout and
  Update, Compare with the current branch, Show Diff with Working Tree,
  Rebase current onto, Merge into current, New Worktree from, Update, Push...,
  Tracked Branch (submenu), Rename (F2), Delete, favourites, Copy Branch
  Name. Rows that cannot run say why in their tooltip.
- Fetch, Update Project, Push, Update and remote Delete run as background
  jobs on the host: the status line shows progress and a Cancel button, and
  a job started in another pane (or before a reload) is shown too.
- A conflict banner with Abort while a merge, rebase, cherry-pick or revert
  is in progress.
- Side panel tabs: "Compare branches" (commits only on either side, changed
  files, per-file patch) and "Diff with working tree", both rendered with
  bb's diff viewer.
- Six command palette rows (`VCS Group: ...`) on thread routes.
- Live refresh: bb's sidebar follows a plugin checkout within a few seconds,
  every open popup for the same repository refetches after an action or a
  job, and changes made by an agent or a terminal reach open popups through
  bb's environment events and the host worker's own watch on the git dir.

## Settings

Under Settings → Installed plugins → VCS Group:

- Update Project strategy: `ff-only` (default), `rebase`, `merge`
- Auto-stash before Update Project (off)
- Confirm before push (on): every push shows the exact git command first
- Default remote (`origin`): used when a branch has no usable upstream
- Prune on fetch (on)
- Network operation timeout in seconds (600): fetch, pull and push jobs are
  stopped after this long

## How push decides

The push dialog previews the exact command, and the host runs exactly that
or refuses with a typed error. Nothing depends on `push.default`,
`remote.pushDefault` or `branch.*.pushRemote`:

| Branch state | Command |
|---|---|
| tracks `<remote>/<branch>` on a configured remote | `git push --no-progress --end-of-options <remote> HEAD:refs/heads/<branch>` |
| no upstream, upstream gone, or a local upstream | `git push --no-progress -u --end-of-options <default remote> HEAD` |
| "Push..." on a branch that is not checked out | the same, with `refs/heads/<name>` in place of `HEAD` |
| the dialog's "force with lease" switch | adds `--force-with-lease=refs/heads/<branch>:<remote sha the dialog saw>` |

The request names the branch and the sha the dialog showed; if either moved
in the meantime the host answers `head_changed` and pushes nothing. Plain
`--force` does not exist.

## Every command the menu runs

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
- Network operations do not run inside that call. The handler pre-flights,
  takes the repository lock and a worker lease, spawns git and returns a job
  id; the job reports through host signals and stays readable for ten
  minutes. Cancel sends SIGTERM to the process group, then SIGKILL.
- Nothing mutates while `.git/index.lock` exists, a merge, rebase,
  cherry-pick or revert is in progress, or a job holds the repository; the
  popup tells you why and offers Abort or Cancel. One mutation at a time per
  repository; a second caller is told `busy`.
- Push, merge, rebase, delete, worktree, detached checkout and Update Project
  on a dirty tree ask first and show the command. Forced deletes and remote
  deletes are destructive confirms; force push is only the leased form.
- Command palette requests travel inside the plugin bundle's module scope,
  not in a window event payload, and obey the same enabled/busy guards as a
  click on the row.
- No agent tool or CLI can mutate the repository: the plugin registers none.
  The RPC endpoints behind the popup are bb's local-auth API, like every
  other plugin's, so any local process with the browser's rights (including
  an agent shell) can call them with a thread id, and a mutation on thread T
  runs on T's host. The plugin cannot close that from inside; it logs every
  mutation and every job with its thread id so misuse is at least visible.

## Roadmap

Milestone 3 is the plugin's own commit dialog, milestone 4 a git log panel,
milestone 5 settings UI, a read-only CLI and agent tool, and the release.
