# Live verification

`npm run check` covers the pure modules, the host against a temp repository
with a bare origin (including jobs, deadline, cancel and process-group kill,
the file watch through the harness), the server against bb's fake plugin
host, and the app under jsdom. This document is the click-through against a
running bb: `scripts/live-check.mjs` for milestone 1, `scripts/live-check-m2.mjs`
for milestone 2, `scripts/live-check-m3.mjs` for milestone 3 and
`scripts/live-check-m4.mjs` for milestone 4, all on `scripts/live-lib.mjs`.

## Setup

```sh
bb plugin install . --yes      # once
bb plugin dev                  # terminal 1: rebuild + reload on save
bb plugin logs vcs-widget -f    # terminal 2
```

A scratch repository with a bare origin and a second clone, then a bb thread
whose environment is the scratch repository:

```sh
node scripts/live-check.mjs setup /tmp/vcs-scratch
# prints the git commands it ran; then create a thread on /tmp/vcs-scratch
# (a hidden thread keeps it out of the sidebar).
```

## Headless run

The script drives the bb web UI with system Chromium through puppeteer-core
and prints one PASS/FAIL line per scenario:

```sh
npm install --no-save puppeteer-core     # once; not a dependency of the plugin
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check.mjs run /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m2.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m3.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m4.mjs /tmp/vcs-scratch
```

Environment: `BB_SERVER_URL` (default `http://127.0.0.1:38886`), `CHROMIUM`
(default `/usr/bin/chromium`). Screenshots land in `/tmp/vcs-e2e/`.

## Scenarios (manual or scripted)

1. Header: branch button left of bb's workspace buttons, label `main`;
   nothing renders on a thread without an environment; icon-only at phone
   width.
2. Open: search focused; Actions, Recent, Local (`main` current), Remote
   (`origin/feat/click-test`, `origin/feature`, `origin/main`); typing a
   remote-only name hides the empty Local heading; Esc closes; reopening
   starts unfiltered.
3. Checkout `origin/feat/click-test`: label follows, popup closes, tracking
   branch created, bb's sidebar follows within ~4 s.
4. New Branch: `bad name` disables Create with a hint; Escape in the form
   returns to the list; create with checkout switches; create without
   checkout keeps the popup open with "Created ...".
5. Update Project on a branch without upstream: `no_upstream` with hint; the
   status line is clean again on the next open.
6. Push on a new branch: dialog previews `git push --no-progress -u
   --end-of-options origin HEAD`; Cancel runs nothing; Confirm pushes and
   sets the upstream. A commit later, Push previews `git push --no-progress
   --end-of-options origin HEAD:refs/heads/<branch>` and the bare remote
   matches HEAD. Delete the remote branch from the second clone, Fetch: the
   "upstream is gone" banner shows and Push offers `-u` again.
7. `touch .git/index.lock`: opening the popup shows the lock banner at once,
   a checkout answers `index_locked` without running git; after removing the
   lock, reopening shows neither the banner nor the old error.
8. `git checkout --detach` in a terminal: label is a short sha, popup shows
   the Detached HEAD banner; `git switch main`: an open popup refreshes.
9. Update Project after a commit pushed from the second clone: "Update
   Project: Fast-forward."
10. Mod+Shift+P lists the seven `VCS Widget:` rows (bb adds a settings row);
    "Open branches" opens the popup; "Push..." shows the confirm dialog with
    the tracked refspec; a `vcs-widget:open` CustomEvent dispatched from the
    console with a `detail` opens nothing.
11. A second browser on the same environment refetches after a checkout in
    the first.
12. Compact viewport: icon-only button with an aria-label.
13. If an enrolled remote machine exists: repeat 3 to 9 on a thread there;
    the plugin log shows the host calls with that host id.

## Milestone 2 scenarios (`live-check-m2.mjs`)

1. Right-click `feature`: the sixteen IntelliJ rows in order, Rename with
   the F2 hint, Tracked Branch as a submenu.
2. The star on a row adds a Favorites group above Recent; it survives a
   reopen (server kv); unstarring removes the group.
3. Rename... opens the inline step prefilled; Enter renames.
4. Delete on an unmerged branch: dialog `git branch -d`, then a destructive
   second dialog `git branch -D` naming the lost commits; the branch is gone.
5. Tracked Branch ▸ `origin/feature` sets the upstream ("feature now tracks
   origin/feature").
6. Compare with 'main' opens a side panel tab titled `main ⇄ feature` with
   commit counts, two commit lists and the changed files.
7. Show Diff with Working Tree (after editing `a.txt`) opens a tab listing
   `a.txt`; clicking it renders the patch in bb's diff viewer.
8. Merge into main: dialog `git merge --no-edit --end-of-options
   refs/heads/<b>`, toast "Merged ... Fast-forward".
9. A conflicting merge: toast `Merge failed: CONFLICT (content): ...`; the
   reopened popup shows "A merge is in progress." with Abort, the menu's
   Checkout is disabled; Abort previews `git merge --abort`; afterwards the
   banner is gone and the tree clean.
10. Rebase current onto: dialog `git rebase --end-of-options refs/heads/<b>`.
11. Checkout Tag or Revision: the step lists tags; picking one previews
    `git switch --detach --end-of-options <tag>`; the label becomes a short
    sha; a detached banner shows.
12. New Worktree from `feature`: dialog `git worktree add --end-of-options
    <repo>-feature feature`; the directory exists on that branch; the row
    shows the worktree badge.
13. Fetch runs as a job: the plugin log has `fetch job <id> started` and
    `finished`.
14. Update on a branch that is not checked out fast-forwards it from its
    upstream.
15. Push... on another local branch previews `-u ... refs/heads/<b>:refs/heads/<b>`
    and creates it on the remote.
16. After a divergent commit on both sides, Push previews the tracked
    refspec; the "force with lease" switch changes it to
    `--force-with-lease=refs/heads/main:<sha>`; the remote ends at HEAD.
17. Delete on `origin/<b>` runs `push --delete` as a job.
18. Seven palette rows including Checkout Tag or Revision.
19. With an unreachable extra remote, Fetch hangs; Cancel in the status line
    ends the job with "Fetch was cancelled."

## Milestone 3 scenarios (`live-check-m3.mjs`)

1. The popup's Actions group has `Commit...` with the Ctrl+K hint; clicking
   it closes the popup and opens a "Commit" panel tab.
2. A clean tree says "Nothing to commit: the working tree is clean."
3. After an edit to `a.txt`, a staged edit plus a second edit to `b.txt`
   and a new untracked file (from a terminal), the panel lists Changes (2)
   and Unversioned files (1) with the status letters; the checkbox is the
   staged state: `a.txt` unchecked, `b.txt` mixed, the new file unchecked.
4. Ticking `a.txt` runs `git add` (status `M.`), unticking runs
   `git reset -q --` (status `.M`).
5. Selecting `b.txt` renders its patch in bb's diff viewer; the partially
   staged file offers Staged / Unstaged and the switch reloads the diff.
6. A message with a body and Commit: the toast names the sha and subject,
   `git log -1 --format=%B` holds the message exactly (it travelled on
   stdin), the box is cleared, `b.txt`'s unstaged part is still there.
7. With nothing staged the Commit button is disabled and the status line
   says "Nothing is staged: tick the files to include."
8. Amend prefills HEAD's message; Amend previews `git commit -F - --amend`;
   after confirming, HEAD's subject changed and its parent did not.
9. Discard on the untracked file previews
   `git --literal-pathspecs clean -f -- <file>`, the dialog says "delete 1
   file", Cancel keeps the file, Discard deletes it.
10. Discard on `b.txt` previews
    `git --literal-pathspecs restore --staged --worktree --source=HEAD -- b.txt`
    and reverts it; discarding `a.txt` too leaves the list empty.
11. With `core.hooksPath` pointing at a pre-commit hook that prints, sleeps
    3 s, prints again and exits 1: Commit shows "Committing…" with the
    hook's output line while the job runs, then "Commit failed: hook says
    no" (the hook's last line) and HEAD is unchanged. With Run Git hooks
    unticked the commit passes (`--no-verify`).
12. An edit and a `git add` from a terminal reach the panel without a
    click (the host watch on the git dir, bb's environment events).
13. Commit and Push commits, then the push dialog previews
    `git push --no-progress --end-of-options origin HEAD:refs/heads/main`;
    after Push the bare remote's `main` equals HEAD.
14. The palette lists eight `VCS Widget:` rows; "Commit..." opens the panel
    without opening the popup.

## Milestone 4 scenarios (`live-check-m4.mjs`)

1. The popup's Actions group has "Show Git Log" (Alt+9 hint); clicking it
   closes the popup and opens a "Git Log" panel tab.
2. The list shows the history newest first, and the tip carries its refs as
   badges: HEAD, the local branch, the remote-tracking branch.
3. The branch filter changes which refs are walked: a commit on another
   branch is in "All branches" and gone under "Current branch".
4. The message filter finds the commit by its subject; adding a regex
   character (`.`) finds nothing, because the filter is `--fixed-strings`.
5. Selecting a commit shows its full sha, message and changed files;
   selecting a file renders its diff in bb's viewer and Back returns to the
   commit.
6. The commit's context menu lists the seven rows; Cherry-Pick previews
   `git cherry-pick --end-of-options <sha>` and, after confirming, HEAD
   carries the picked subject.
7. Revert Commit previews `git revert --no-edit --end-of-options <sha>`;
   after confirming, HEAD is the revert and the file is gone again.
8. Reset Current Branch to Here → Hard is a destructive confirm previewing
   `git reset --hard --end-of-options <sha> --`; after confirming, the
   branch is back at that commit.
9. New Branch from a commit opens the branch form and creates the branch at
   that sha, checked out.
10. Compare with the current branch opens the compare tab with the commit as
    the target revision.
11. The palette row "VCS Widget: Show Git Log" opens the panel without the
    popup, and a commit made in a terminal appears in the open log without
    a click.
12. The palette lists eight `VCS Widget:` rows.

## Last run

2026-09-09, bb 0.42.1, git 2.55, one local machine: milestone 1 scenarios
1 to 12 (27 steps), milestone 2 scenarios 1 to 19 (21 steps), milestone 3
scenarios 1 to 14 (16 steps) and milestone 4 scenarios 1 to 12 (12 steps)
pass headlessly (see the COS-121 to COS-124 comments). Scenario 13 of
milestone 1 waits for a remote machine (COS-126). The milestone 1 push step
once failed to reopen the popup after a cancelled dialog and passed on the
rerun (COS-127).

Milestone 4 first ran with milestone 2 stopping at scenario 10: the log row
made the branch context menu one row taller, so it no longer fitted below
the pointer, an item ended up under it, and the release of the right-click
that opened the menu ran that item (Radix clicks an item on a pointerup it
saw no pointerdown for). `components/ui/context-menu.tsx` now ignores that
release; the whole suite passes again.
