# Changelog

## 0.4.0 (2026-09-09) — milestone 4

The plugin's own git log, as a thread panel tab.

- "Git Log" panel tab, opened from the popup's new "Show Git Log" quick
  action, the palette row "VCS Group: Show Git Log" (which opens it without
  the popup), or "Show Log" on a branch's context menu (which preselects
  that branch). A list, not a graph: `git log --topo-order` so children
  always come before parents whatever the clock says.
- Rows are virtualised by hand (fixed height, two spacers, `shared/virtual.ts`),
  so a long history renders a screenful of nodes. Each row carries the refs
  that point at it as badges, read from `%D` with `--decorate=full` so
  branches, remote-tracking branches and tags are told apart rather than
  guessed at.
- Filters: all branches, the current branch, or one branch; plus a message
  filter that runs as `--grep=<text> --fixed-strings --regexp-ignore-case`,
  so the box is a literal substring search and never a regular expression
  the user did not write. "Load more" reads the next page with `--skip` and
  dedupes by sha.
- Selecting a commit opens the drawer: full sha, author and committer with
  their dates, the message, and the files the commit changed against its
  first parent (against nothing for the first commit). Selecting a file
  swaps the drawer for bb's diff viewer with both complete sides, so
  expand-context works.
- Per-commit context menu: Checkout Revision, New Branch from (the popup's
  form, with the commit as the start point), Cherry-Pick, Revert Commit,
  Reset Current Branch to Here (Soft / Mixed / Hard), Compare with the
  current branch, Copy Revision Number. Cherry-Pick and Revert are off for a
  merge commit, which git can only apply with a parent number.
- Cherry-pick, revert and reset ask first with the exact command and name
  the sha the row showed; `reset --hard` is a destructive confirm. A
  conflict leaves the cherry-pick or revert in progress, which the popup's
  existing Abort concludes.
- Compare now takes a revision as well as a branch, which is how the log
  compares one commit with the current branch.
- Fixed: a right-click could run the menu item that ended up under the
  pointer. Radix clicks an item on a pointerup it saw no pointerdown for
  (the press-drag-release gesture), so when a context menu did not fit below
  the pointer and was shifted over it, releasing the button that opened the
  menu ran that item — Checkout, on a branch row. `ContextMenuItem` now
  ignores that release.
- Internals: `host/log.ts` for the reads, the three mutations in
  `host/actions.ts` with the usual pre-flight, and `host/diff-text.ts` for
  the patch caps, the binary check and the both-sides read that the compare,
  commit and log panels had each copied.

## 0.3.0 (2026-09-09) — milestone 3

The plugin's own commit dialog, as a thread panel tab.

- "Commit" panel tab (also from the popup's new "Commit..." quick action
  with its Ctrl+K hint, and the palette row "VCS Group: Commit..." which
  opens it without the popup): the working tree and the index in Conflicts /
  Changes / Unversioned files groups, IntelliJ's status letters, and a
  checkbox per file whose state is the staged state (ticking runs `git add`,
  unticking `git reset -q --`, a partially staged file shows a mixed box and
  each group header toggles the whole group).
- Diff preview of the selected file in bb's diff viewer with both complete
  sides handed over (expand-context works), and a Staged / Unstaged switch
  for a file changed on both sides; untracked files diff against /dev/null.
- Commit runs as a background job so hooks can take as long as they need:
  the message travels on git's stdin (`commit -F -`), hook output streams
  into the panel, Cancel kills the process group. Options: Amend (asks first
  with the exact command, prefills HEAD's message), Sign-off, Run Git hooks
  (off adds `--no-verify`). Ctrl+Enter commits.
- Commit and Push: the commit job, then the existing push dialog on the
  overview the commit reported, so the push names the new sha.
- Discard per file, always a destructive confirm listing one command per
  category: `restore --staged --worktree --source=HEAD` for paths in HEAD,
  `rm -q --cached` for files new to git (kept on disk), `clean -f` for
  untracked files (deleted). Conflicted files cannot be discarded.
- Every path command runs as `git --literal-pathspecs <cmd> -- <paths>`:
  no globbing, no pathspec magic. Paths are validated at the RPC boundary
  (relative, no `..`, at most 500 per call).
- New typed error `nothing_to_commit`; the panel refuses to commit while the
  index is locked, a job runs or conflicts remain, and explains why.
- Live refresh: the panel follows `git add` and edits made from a terminal
  or by an agent through bb's environment events and the host watch.


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
