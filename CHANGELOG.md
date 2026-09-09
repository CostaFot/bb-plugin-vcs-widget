# Changelog

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
