# VCS Widget for bb

![The branch popup, the commit panel and the git log under a bb thread header](docs/screenshots/hero.png)

IntelliJ-style VCS popup, commit dialog and log, inside bb.

## Requirements

- bb 0.42 or newer
- git 2.24 or newer
- npm

## Install

```sh
bb plugin install https://github.com/CostaFot/bb-plugin-vcs-widget --yes
```

## Popup

![The branch popup open under the thread header](docs/screenshots/popup.png)

- Search, then Favourites / Recent / Local / Remote, each row with ahead/behind,
  gone and worktree badges. A star toggles a favourite, kept per machine and
  worktree rather than per thread.
- Quick actions across the top: Update Project, Commit..., Show Git Log, Fetch,
  Push..., New Branch..., Checkout Tag or Revision.
- Right-click a branch, or use its "..." button, for the IntelliJ menu:
  Checkout, New Branch from, Checkout and Rebase onto current, Checkout and
  Update, Compare with current, Show Diff with Working Tree, Rebase current
  onto, Merge into current, New Worktree from, Update, Push..., Tracked Branch,
  Rename, Delete, favourites and Copy Branch Name. A row that cannot run says
  why in its tooltip.
- Fetch, Update Project, Push, Update and remote Delete run as background jobs,
  with progress and Cancel in the status line. A job someone started in another
  pane, or before a reload, shows up too.
- A conflict banner with Abort while a merge, rebase, cherry-pick or revert is
  in progress.

## Commit panel

<img src="docs/screenshots/commit.png" alt="The commit panel with a file selected" width="420">

- The working tree as Conflicts / Changes / Unversioned files, with IntelliJ's
  status letters.
- The checkbox is the staged state: ticking runs `git add`, unticking
  `git reset`, a partly staged file shows a mixed box, and a group header
  toggles the whole group.
- The selected file renders in bb's diff viewer, both sides complete, with a
  Staged / Unstaged switch.
- Below it: the message (Ctrl+Enter commits), Amend, Sign-off, Run Git hooks,
  Commit and Commit and Push. The commit runs as a background job so hooks can
  take their time — their output streams into the panel, and Cancel stops them.
- Discard on a row, from that row's right-click menu, or on a whole group from
  its header. It always asks first, with one command per category.
- Agent Commit and Agent Commit & Push run no git. They send "LGTM - Commit" or
  "LGTM - Commit & Push" to the thread as if you had typed it, so the agent that
  wrote the code writes the message.

## Git log

<img src="docs/screenshots/log.png" alt="The git log panel with a commit selected" width="420">

- Commits over all branches, the current branch or one branch, with the refs
  each commit carries as badges and a literal message filter. Rows are
  virtualised, with Load more at the end.
- Selecting a commit opens the drawer below it: the full sha, both identities
  and dates, the message, and the files it changed. Picking one of those files
  swaps the drawer for the diff.
- Right-click a commit for Checkout Revision, New Branch from, Cherry-Pick,
  Revert Commit, Reset Current Branch to Here (Soft / Mixed / Hard), Compare
  with current and Copy Revision Number.

## More

- Two more panel tabs: "Compare branches" (the commits only on either side, the
  changed files, the patch per file) and "Diff with working tree". Compare also
  takes a revision, which is how the log compares one commit with the current
  branch.
- Eight command palette rows (`VCS Widget: ...`) on thread routes.
- Live refresh: bb's sidebar follows a checkout within a few seconds, open
  popups refetch after an action or a job, and changes made by an agent or a
  terminal reach them through bb's environment events and a watch on the git
  directory.

It does not do interactive rebase, stashes of its own (only auto-stash before
Update Project), submodules, blame, or conflict resolution: the banner offers
Abort and leaves the rest to your editor.

## Settings

![The plugin's settings page](docs/screenshots/settings.png)

Under Settings → Installed plugins → VCS Widget:

| Setting | Default |
|---|---|
| Update Project strategy | `ff-only`, or `rebase` or `merge` |
| Auto-stash before Update Project | off |
| Confirm before push | on: every push shows the exact git command first |
| Default remote | `origin`, used when a branch has no usable upstream |
| Prune on fetch | on |
| Network operation timeout | 600 s, after which a fetch, pull, push or commit job is stopped (commit is on that list because of hooks) |

Below the form, "Agent access" lists the reads an agent or a terminal can do,
and "Favourite branches" every starred branch with the machine and worktree it
belongs to, with a Clear button per repository. It is the only place that store
is visible.

## From a terminal, or an agent

`bb vcs-widget` reads the repository behind a thread, on the machine that owns
the worktree.

| Command | Prints |
|---|---|
| `bb vcs-widget status` | branch, upstream, working tree, a running fetch/pull/push |
| `bb vcs-widget branches [--remote \| --all]` | branches with ahead/behind, upstream and worktree |
| `bb vcs-widget log [--branch <name> \| --all] [--grep <text>]` | recent commits with their refs |

`--thread <id>` reads another thread, `--json` prints the data instead of the
table, and `--limit <n>` sets the rows. A usage error exits 2; a thread with no
git repository exits 1 and says which.

Agents get those same three reads as the `vcs_widget_status` tool, plus a
bundled skill telling them the plugin cannot commit or push and that git changes
are the human's to ask for.

## Safety model

- Git only ever runs as `spawn("git", argv)` on the machine that owns the
  worktree, never through a shell.
- Everything destructive shows the exact command first, and the log's actions
  name the sha the row showed rather than a name that may have moved since.
- No agent tool or CLI can mutate the repository. The RPC route behind the popup
  is a different matter, and worth reading before you install.

[The safety model](docs/SAFETY.md) has all of that in full, and
[how push decides](docs/PUSH.md) answers "will this force-push my branch".

## Development

```sh
npm install
bb plugin types              # pin the SDK to your bb
npm run check                # vitest + tsc + bb plugin build
bb plugin install . --yes
bb plugin dev                # rebuild and reload on save
```

`CLAUDE.md` has the architecture and `docs/VERIFY.md` the live click-throughs.

---

[Every command it runs](docs/COMMANDS.md) ·
[Changelog](CHANGELOG.md) ·
[Bugs](https://github.com/CostaFot/bb-plugin-vcs-widget/issues) · MIT
