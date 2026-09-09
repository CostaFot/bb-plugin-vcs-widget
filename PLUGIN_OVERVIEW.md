The Git branches popup from IntelliJ and Android Studio, in bb's thread
header.

## What you get

- A **branch button** in every thread header showing the current branch.
- A **searchable popup** with Recent, Local and Remote branches, ahead/behind
  and gone badges, and the quick actions Update Project, Fetch, Push and New
  Branch.
- **Checkout, New Branch, Update Project and Push** that run on the machine
  owning the thread's worktree, so remote environments work too.
- **Command palette rows** for the same actions on thread routes.
- **Live refresh**: bb's sidebar follows a checkout, open popups refetch
  after actions, and checkouts made by an agent or a terminal reach the
  popup.

## How it works

Git runs only as an argv on the plugin's host worker, never through a shell.
Every push shows the exact command first and pushes exactly that or refuses
with a typed reason. Nothing runs while the index is locked or a merge or
rebase is in progress. Actions finish inside bb's host-call deadline or
report a typed timeout, leaving no orphaned git processes behind.

## For agents

The plugin registers no agent tool and no CLI mutation. Agents keep using git
in their own worktree; the popup is for the human.
