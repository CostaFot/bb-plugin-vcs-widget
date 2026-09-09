# How push decides

Every push names its remote and its refspec. `push.default`,
`remote.pushDefault` and `branch.*.pushRemote` are never read, so what the
dialog previews is what runs.

| Branch state | Command |
|---|---|
| tracks `<remote>/<upstream>` on a configured remote | `git push --no-progress --end-of-options <remote> HEAD:refs/heads/<upstream>` |
| no upstream, upstream gone, or an upstream that is not on a remote | `git push --no-progress -u --end-of-options <default remote> HEAD` |
| "Push..." on a branch that is not the current one | `refs/heads/<name>` takes the place of `HEAD` on the left of the refspec |
| the dialog's "Force with lease" toggle | `--force-with-lease=refs/heads/<upstream>:<the remote sha the dialog showed>` goes in before `--end-of-options` |

The default remote is the "Default remote" setting, `origin` until you change
it. Plain `--force` is not representable: the type a push travels as has no
room for it.

## What it refuses

The request carries the branch name and the sha the dialog read, and the host
checks the repository again before it runs anything. Each of these pushes
nothing and says so:

| The repository now says | Answer |
|---|---|
| the current branch is not the one the dialog named | `head_changed` |
| the branch moved since the dialog read it | `head_changed` |
| the branch tracks a different remote than the one previewed | `head_changed` |
| the lease sha no longer matches the remote-tracking ref | `head_changed`, "Fetch, look at what changed, then decide again." |
| a tracked push, but the upstream is now gone or never existed | `no_upstream` |
| the remote is not configured | `no_remote` |

The host never upgrades or redirects a push to make one of those work. It runs
the previewed argv or it answers.

## The confirm

"Confirm before push" is on by default and shows the command every time. With it
off, a push to a branch that already tracks a remote goes straight through — but
a first push still confirms, because it writes an upstream, and force with lease
is a destructive confirm whatever the setting says.

Commit and Push commits, then pushes on the overview the commit reported, and
the push half is everything above.

See also: [every command it runs](COMMANDS.md) · [safety model](SAFETY.md).
