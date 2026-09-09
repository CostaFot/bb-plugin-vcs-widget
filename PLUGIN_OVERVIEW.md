The Git branches popup, commit dialog and log from IntelliJ and Android
Studio, in bb's thread header.

## What you get

- A **branch button** in every thread header showing the current branch.
- A **searchable popup** with Favorites, Recent, Local and Remote branches,
  ahead/behind, gone and worktree badges, and the quick actions Update
  Project, Commit, Show Git Log, Fetch, Push, New Branch and Checkout Tag or
  Revision.
- The **full per-branch context menu**: Checkout, New Branch from, Checkout
  and Rebase onto the current branch, Checkout and Update, Compare with,
  Show Diff with Working Tree, Rebase, Merge, New Worktree from, Update,
  Push, Tracked Branch, Rename, Delete, favourites, copy.
- **Background fetch, pull and push** with progress and Cancel, so a slow
  remote never hits bb's host-call deadline.
- **A commit dialog** as a panel tab: the working tree as a checklist whose
  checkbox is the staged state, a diff preview with expand-context, message,
  Amend, Sign-off, Run Git hooks, Commit and Commit and Push, and a
  per-file Discard that always asks first.
- **A git log** as a panel tab: virtualised rows with the refs each commit
  carries as badges, a branch and a message filter, a details drawer with
  the files a commit changed and their diffs, and a context menu with
  Checkout Revision, New Branch from, Cherry-Pick, Revert, Reset and Compare.
- **Side panel tabs** that compare two branches or a revision, or diff the
  working tree against a branch, rendered with bb's own diff viewer.
- **Command palette rows** for the quick actions on thread routes.
- **Live refresh**: bb's sidebar follows a checkout, open popups refetch
  after actions, and changes made by an agent or a terminal reach the popup
  through bb's environment events and the host's own file watch.

## How it works

Git runs only as an argv on the plugin's host worker on the machine that
owns the worktree, never through a shell. Every push, merge, rebase, delete,
worktree, detached checkout, amend, cherry-pick, revert, reset and discard
shows the exact command first and runs exactly that or refuses with a typed
reason; force push exists only as `--force-with-lease` against the sha the
dialog showed. Commit messages travel on git's stdin, and paths only ever
reach git after `--literal-pathspecs ... --`. Nothing mutates while the
index is locked or a merge or rebase is in progress; the popup offers Abort
instead.

## For agents

The plugin registers no agent tool and no CLI mutation. Agents keep using git
in their own worktree; the popup is for the human.
