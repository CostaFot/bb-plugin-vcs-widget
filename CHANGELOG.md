# Changelog

## 0.2.0 (2026-09-09) — milestone 2

The full IntelliJ branch context menu, background network operations, live
refresh from the host, and favourites.

- Context menu on every branch row (also from the "..." button): Checkout,
  New Branch from, Checkout and Rebase onto the current branch, Checkout and
  Update, Compare with the current branch, Show Diff with Working Tree,
  Rebase current onto, Merge into current, New Worktree from (sibling
  directory), Update (fast-forward a branch that is not checked out), Push...
  (any local branch, by its own ref), Tracked Branch submenu (set or unset
  the upstream), Rename (F2, inline), Delete (`-d`, then `-D` after a second
  destructive confirm; remote branches through `push --delete`), Add to /
  Remove from Favorites, Copy Branch Name.
- Every history- or remote-changing row shows the exact git command first;
  force push exists only as `--force-with-lease=<upstream>:<sha the dialog
  saw>` behind a switch in the push dialog.
- Fetch, Update Project, Push, Update and remote Delete run as background
  jobs on the host worker: the popup shows progress and a Cancel button, the
  job survives the 30 s host-call cap, and the result arrives through host
  signals with polling as a fallback. Setting `jobTimeoutSeconds` (default
  600). Other panes and reloads see a running job in the overview and can
  cancel it; a second mutation is told `busy`.
- Conflict banner with Abort for a merge, rebase, cherry-pick or revert in
  progress; the rows explain instead of running while an operation blocks
  the repository.
- Live refresh from the host: the worker watches the git dir (and the common
  dir of a linked worktree) and signals changes to every popup on that
  repository, in addition to bb's own environment events.
- Favourites, kept per host and repository, listed first and ranked higher.
- Checkout Tag or Revision (quick action and palette row) with a tag list;
  detached checkouts confirm first.
- Side panel tabs: "Compare branches" (commits on either side, changed
  files, per-file patch in bb's diff viewer) and "Diff with working tree".
- Git older than 2.24 is reported in the status line and blocks mutations.
- Error headlines now quote the line that decided the error code
  (`CONFLICT (content): ...` instead of `Auto-merging ...`).

## 0.1.0 (2026-09-09) — milestone 1

First release: an IntelliJ-style Git branches popup in bb's thread header.

- Branch button in the thread header (label from bb's sidebar, no RPC until
  the popup opens; icon-only on compact viewports; hidden threads read the
  overview for their label).
- Popup with search and plugin-owned ranking, Actions (Update Project,
  Fetch, Push, New Branch), Recent / Local / Remote groups, per-branch menu
  (Checkout, New Branch from, Copy Branch Name), status line with repository
  banners and the last action's outcome.
- Actions run on the host worker of the machine that owns the worktree:
  checkout (local, or remote with tracking), create branch (with or without
  checkout, from HEAD or a start point passed as a full ref), fetch, pull
  (`ff-only` / `rebase` / `merge`, optional autostash), push.
- Push always names its remote and refspec and names the branch the dialog
  showed; the host refuses (`no_upstream`, `head_changed`) instead of
  improvising. The overview reports the upstream's remote, branch and gone
  state.
- One 27 s budget per host call with remaining-time deadlines; git runs in
  its own process group and is killed as a group on timeout or cancel.
- Typed errors (`index_locked`, `operation_in_progress`, `dirty_worktree`,
  `conflict`, `non_fast_forward`, `no_upstream`, `auth_required`, `network`,
  `timeout`, `cancelled`, `busy`, ...) with hints; host transport failures
  become typed results and still trigger a refresh.
- Refresh without polling: status nudges, a realtime `changed` channel, bb's
  `environment:changed` events, reconnect and worker-exit refetches.
- Five command palette rows; requests travel in module scope and obey the
  row guards.
- Settings: update strategy, auto-stash, confirm before push, default
  remote, prune on fetch.
