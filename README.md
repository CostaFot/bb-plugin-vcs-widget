# VCS Widget for bb

IntelliJ's Git branches popup, commit dialog and log, inside bb. A branch
button in every thread header opens a searchable popup with Favorites /
Recent / Local / Remote branches, the full per-branch context menu, and
background fetch, pull and push; a Commit panel tab stages, previews and
commits, and a Git Log tab walks the history, all running on the machine
that owns the thread's worktree.

![The branch popup in a thread header](docs/screenshots/popup.png)

Status: milestone 5 shipped, so the plugin is feature complete — the branch
popup, the commit panel, the git log, a settings page, and a read-only
`bb vcs-widget` command with a matching agent tool. `CLAUDE.md` has the
architecture and the dev loop.

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
- A popup with search, quick actions (Update Project, Commit..., Fetch,
  Push, New Branch, Checkout Tag or Revision) and Favorites / Recent / Local / Remote
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
- A "Commit" panel tab (the popup's Commit... row, the palette row, or the
  panel's own Actions list): the working tree and the index as Conflicts /
  Changes / Unversioned files with IntelliJ's status letters. The checkbox
  is the staged state: ticking runs `git add`, unticking `git reset -q --`,
  a partially staged file shows a mixed box, and a group header toggles the
  whole group. The selected file renders in bb's diff viewer with both
  complete sides (expand-context) and a Staged / Unstaged switch. Below:
  the message (Ctrl+Enter commits), Amend (asks first, prefills HEAD's
  message), Sign-off, Run Git hooks, Commit, Commit and Push. Commit runs
  as a background job so hooks may take their time; their output streams
  into the panel and Cancel stops them. A per-file Discard always asks
  first with one command per category.
- A "Git Log" panel tab (the popup's Show Git Log row, the palette row, or
  Show Log on a branch): commits over all branches, the current branch or
  one branch, with the refs each commit carries as badges, a literal
  message filter, virtualised rows and Load more. Selecting a commit opens
  the drawer below: its full sha, both identities and dates, the message and
  the files it changed (against the first parent, or against nothing for the
  first commit); selecting a file swaps the drawer for bb's diff viewer with
  both complete sides. Right-click a commit for Checkout Revision, New
  Branch from, Cherry-Pick, Revert Commit, Reset Current Branch to Here
  (Soft / Mixed / Hard), Compare with the current branch and Copy Revision
  Number.
- Side panel tabs: "Compare branches" (commits only on either side, changed
  files, per-file patch) and "Diff with working tree", both rendered with
  bb's diff viewer. Compare also takes a revision, which is how the log
  compares one commit with the current branch.
- Eight command palette rows (`VCS Widget: ...`) on thread routes.
- Live refresh: bb's sidebar follows a plugin checkout within a few seconds,
  every open popup for the same repository refetches after an action or a
  job, and changes made by an agent or a terminal reach open popups through
  bb's environment events and the host worker's own watch on the git dir.

![The commit panel](docs/screenshots/commit.png)

![The git log panel](docs/screenshots/log.png)

## Settings

Under Settings → Installed plugins → VCS Widget:

- Update Project strategy: `ff-only` (default), `rebase`, `merge`
- Auto-stash before Update Project (off)
- Confirm before push (on): every push shows the exact git command first
- Default remote (`origin`): used when a branch has no usable upstream
- Prune on fetch (on)
- Network operation timeout in seconds (600): fetch, pull, push and commit
  jobs are stopped after this long (commit counts because of hooks)

Below the form, "Agent access" repeats what the plugin exposes outside the
UI, and "Favourite branches" lists every starred branch with the machine and
worktree it belongs to, with a Clear button per repository. Favourites are
kept per machine and worktree, not per thread, which is the only place that
is visible.

![The plugin's settings page](docs/screenshots/settings.png)

## From a terminal, or an agent

`bb vcs-widget` reads the repository behind a thread. It runs on the machine
that owns the worktree, so it answers for a thread whose workspace is on
another machine, where `git` in the local shell would read the wrong disk.

| Command | Prints |
|---|---|
| `bb vcs-widget status` | branch, upstream, working tree, a running fetch/pull/push |
| `bb vcs-widget branches [--remote \| --all]` | branches with ahead/behind, upstream and worktree |
| `bb vcs-widget log [--branch <name> \| --all] [--grep <text>]` | recent commits with their refs |

`--thread <id>` reads another thread, `--json` prints the data instead of the
table, `--limit <n>` sets the rows. A usage error exits 2, a thread with no
git repository exits 1 and says which.

Agents get the same three reads as the `vcs_widget_status` tool, and a
bundled skill telling them the plugin cannot commit or push and that git
changes are the human's to ask for.

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
| Show Log | reads only: `git log --topo-order --decorate=full ...` |

## Every command the log panel runs

| Row | Command |
|---|---|
| The list | `git log --topo-order --decorate=full --format=... -n 101 [--skip=<n>] [--grep=<text> --fixed-strings --regexp-ignore-case] (--branches --remotes \| HEAD \| <ref>) --` |
| A commit | `git show --no-patch --decorate=full --format=... <sha> --`, then `git diff --numstat -z -M <parent> <sha> --` (first commit: `git diff-tree --root -r --numstat -z -M <sha> --`) |
| A file in a commit | `git diff --no-color -M <parent> <sha> -- <path>` (first commit: `git show --format= <sha> -- <path>`), plus `git show <rev>:<path>` for the two sides |
| Cherry-Pick | `git cherry-pick --end-of-options <sha>` |
| Revert Commit | `git revert --no-edit --end-of-options <sha>` |
| Reset Current Branch to Here | `git reset --soft\|--mixed\|--hard --end-of-options <sha> --` |

The message filter is `--fixed-strings`, so the box is a literal substring
search and never a regular expression the user did not write. Cherry-Pick
and Revert are off for a merge commit: git needs a parent number there, and
picking one is a dialog this plugin does not have.

## Every command the commit panel runs

| Control | Command |
|---|---|
| Tick a file (or a group) | `git --literal-pathspecs add -A -- <paths>` |
| Untick a file (or a group) | `git --literal-pathspecs reset -q -- <paths>` (works before the first commit too) |
| Commit | `git commit -F -` with the message on stdin; `--amend`, `--signoff`, `--no-verify` as ticked |
| Commit and Push | the commit, then the push dialog above on the overview the commit reported |
| Discard (paths in HEAD) | `git --literal-pathspecs restore --staged --worktree --source=HEAD -- <paths>` |
| Discard (files new to git) | `git --literal-pathspecs rm -q --cached -- <paths>`; the file stays on disk as untracked |
| Discard (untracked files) | `git --literal-pathspecs clean -f -- <paths>`; the file is deleted |
| Diff preview | `git diff [--cached] -M --no-ext-diff -- <path>`, `git show HEAD:<path>` / `:<path>` for the two sides, `git diff --no-index -- /dev/null <path>` for an untracked file |

The checkbox is the staged state and Commit commits the index, never a path
list, so the list is exactly what the commit will contain. `--literal-pathspecs`
means a path from `git status` can never turn into a glob or pathspec magic.

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
- Push, merge, rebase, delete, worktree, detached checkout, amend,
  cherry-pick, revert, reset and Update Project on a dirty tree ask first and
  show the command. Forced deletes, remote deletes, `reset --hard` and every
  discard are destructive confirms; force push is only the leased form. A
  commit message never becomes an argument: it goes to git's stdin.
- The log's actions name the sha the row showed, never a branch name that
  could have moved since, and the host resolves it before it runs anything.
- Command palette requests travel inside the plugin bundle's module scope,
  not in a window event payload, and obey the same enabled/busy guards as a
  click on the row.
- No agent tool or CLI can mutate the repository. `bb vcs-widget` and
  `vcs_widget_status` reach exactly two of the host's reads, and there is no
  argument that turns either into a write. The RPC endpoints behind the popup
  are a different matter: they are bb's local-auth API, like every other
  plugin's, so any local process with the browser's rights (including an
  agent shell) can call them with a thread id, and a mutation on thread T
  runs on T's host. The plugin cannot close that from inside; it logs every
  mutation and every job with its thread id so misuse is at least visible.
