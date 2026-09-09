# bb-plugin-vcs-widget

A bb plugin (id `vcs-widget`, display name "VCS Widget") that recreates the
IntelliJ / Android Studio Git branches popup inside bb: a branch button in the
thread header, a searchable popup with Recent / Local / Remote branches, and
git actions that run on the machine owning the thread's worktree.

## Work board

Linear project `bb-plugin-vcs-group` (named before the rename), label `lab`,
team `COS`. The plan lives in the issue descriptions, progress in issue
comments (`claude: step N done, <what>`), never in files here.

- COS-121 Milestone 1: branch popup + checkout, new branch, update, push (full architecture, contracts, steps, verification) — shipped 2026-09-09
- COS-122 Milestone 2: full context menu, background push/pull jobs, live refresh, favourites — shipped 2026-09-09
- COS-123 Milestone 3: own commit dialog (panel tab, staging, diff preview, commit as a job, amend, discard) — shipped 2026-09-09
- COS-124 Milestone 4: own git log panel — shipped 2026-09-09
- COS-125 Milestone 5: settings sections, read-only CLI and agent tool, skill,
  compact pass, README screenshots — shipped 2026-09-09
- COS-131 to COS-133 commit panel: discard a whole group from its header,
  a right-click menu on the file rows (Copy Path, Discard), and an
  "LGTM - Commit" button that hands the commit to the thread's agent —
  shipped 2026-09-09
- COS-130 marketplace submission — submitted 2026-09-10 as
  get-bb/marketplace#231, off the tag `v0.7.0`. COS-148 watches it through
  review; the clone the branch was pushed from is `~/Work/_marketplace/`
- COS-142 hand-check the clipboard copies in a real browser (headless
  Chromium denies the write, so no script can) — done 2026-09-09, all three
  pass
- COS-143 Agent Commit and Agent Commit & Push, one AGENT_ACTIONS table and a
  variant on the wire — shipped 2026-09-09
- COS-144 hand-check those two buttons: the Sent glyph, the tooltip, and the
  push wording end to end (the live check reads that button, never clicks it)
  — done 2026-09-09, all three pass
- COS-145 README pass: requirements and a real install line, the argv tables
  split into `docs/COMMANDS.md`, the favourites spelling settled British
  across the popup and its menu, LICENSE and the listing metadata —
  shipped 2026-09-09
- COS-146 Costa reads `README.md` and `PLUGIN_OVERVIEW.md` himself, rendered,
  before the plugin goes public — done 2026-09-09; the overview's opening line
  now matches the README's, nothing came out of the README pass
- COS-128 a confirmed action's outcome survives the popup closing for a
  minute, dated past five seconds with the repository summary under it, and
  COS-129 the watch ignore syntax verified against bb's watcher (plain names,
  root-relative, measured) with the absolute-path bug in `relevant()` fixed —
  shipped 2026-09-09. COS-127 stays open: the popup that once did not reopen
  has not recurred, but `openPopup` now prints the DOM state when it happens

To resume: `bb status`, read this file, `linear issue view COS-125 --json`
(and its comments; COS-121 to COS-124 hold the architecture and the M2 to M4
designs), load the `bb-plugin-authoring` skill with the Skill tool.

## Architecture (three runtimes, one contract file)

```
app.tsx (browser) --useRpc(rpcContract, keyed by threadId)--> server.ts (bb server)
     ^                                                            | bb.sdk.threads.get({include:"environment"})
     | useRealtime("changed", {environmentId})                    |   -> { environmentId, hostId, path }
     +---- bb.realtime.publish <---- server.ts --host.call(m, {repoPath,...}, {hostId})--> host.ts (daemon worker)
                                                                                    execFile("git", argv); never a shell
```

- `contracts.ts` holds zod schemas, `rpcContract` (inputs carry `threadId`) and
  `hostContract` (inputs carry an absolute `repoPath`). Runtime import in
  server and host, type-only in the app. Never import private `@bb/*`.
- `host.ts` is the only place git runs (`spawn` in its own process group,
  env hygiene). bb cancels a host call at a fixed 30 s, so every handler
  creates one `Budget` (`host/budget.ts`, 27 s) and each git command gets the
  time that is left; the overview read after a mutation is skipped
  (`overview: null`) when fewer than 2.5 s remain. Mutations return typed
  `{ ok, error: { code, message, hint, stderr } }`, they do not throw.
  Network work (fetch, pull, push, updateBranch, deleteRemoteBranch) is a
  **job** (`host/jobs.ts`): pre-flight under the repo lock, worker lease,
  `{ ok, jobId }` at once, `jobEvent` signals, `jobGet` / `jobCancel`. The
  first overview per repo registers a watch (`host/watch.ts`) that emits the
  `changed` signal. Reads for the panels live in `host/compare.ts`; the
  commit panel's reads and index mutations in `host/changes.ts` (commit is
  a job too: hooks; the message goes on stdin through `runGit`'s `stdin`);
  the log panel's reads in `host/log.ts`, with cherry-pick, revert and reset
  among the ordinary mutations in `host/actions.ts`. Patch caps, the binary
  check and the both-sides read they share are in `host/diff-text.ts`.
- `server.ts` resolves thread to environment, forwards to the host, then nudges
  `bb.sdk.environments.status` (0 s and 3.2 s) and publishes `changed`. It
  maps `hostId + repoRoot` to environment ids (from overviews) to route
  `jobEvent` (realtime `job`) and `changed` signals, and keeps favourites in
  kv (`fav:<hostId>:<repoRoot>`; the settings page lists and clears them
  through `favouriteRepos` / `clearFavourites`, which rebuild the key from
  `hostId` and `repoRoot` so a caller never names a storage key).
  `sendToAgent` is the one method that runs no git: it hands the commit to
  the thread's agent through `bb.sdk.threads.send` (`queue-if-active`). Its
  input names a variant, never the text; the label and message for each live
  in `AGENT_ACTIONS` (`shared/constants.ts`) and the server does the lookup,
  so the two lines there are the whole of what the plugin can say to an
  agent. It is logged like a mutation.
- `server/cli.ts` is the whole read-only surface: argv parsing, the text and
  `--json` shapes, and a `CliReader` with exactly two methods (overview,
  log). `bb.cli.register` and `bb.agents.registerTool("vcs_widget_status")`
  both go through it, which is what keeps them read-only — the module names
  no mutating host method. `skills/vcs-widget/SKILL.md` tells agents the same.
- `app.tsx` registers `experimental_threadHeaderAction`, four
  `threadPanelAction` tabs (`compare`, `diff` in `views/panels.tsx`; `commit`
  in `views/CommitPanel.tsx`; `log` in `views/LogPanel.tsx`, the last two
  opened by their popup quick action and by a palette row without the popup;
  the ids live in `shared/panel-params.ts`), two `settingsSection` blocks
  (`views/SettingsSections.tsx`) and `commandPaletteAction` rows;
  the popup is a portalled Popover + cmdk Command
  with plugin-owned ranking (`shared/model.ts`, `menuFor` for the branch
  context menu, `commitMenuFor` for the log's, `fileMenuFor` for the commit
  panel's file rows). Palette rows hand their
  request to the button through
  `lib/events.ts` module scope, never through an event `detail`. Jobs are
  awaited in `hooks/use-jobs.ts` (realtime `job` channel, `jobGet` polling
  fallback); a confirmed action closes the popup and reports by toast. The
  log list is windowed by `shared/virtual.ts` (fixed row height, two
  spacers), not by a dependency. `components/ui/context-menu.tsx` ignores
  the pointerup that opened a menu: Radix clicks an item it saw no
  pointerdown on, so a menu shifted over the pointer would run that row.
- Pure, DOM-free logic in `shared/` with fixture tests. `shared/constants.ts`
  holds the values the app needs (pull strategies, realtime channel) so
  `contracts.ts` (zod) and `server/*` stay out of `dist/app.js`; a
  non-type import of either from app code is a regression.

## Dev loop

```sh
bb plugin types              # repin @get-bb/plugin-sdk to the running bb
npm run check                # vitest + tsc --noEmit + bb plugin build
bb plugin install . --yes    # once
bb plugin dev                # rebuild + reload on save (needs a running bb)
bb plugin logs vcs-widget -f  # plugin log
bb plugin reload vcs-widget   # after `bb plugin build` without `dev`
```

Live click-through: `docs/VERIFY.md`, driven by `scripts/live-check.mjs`
(M1), `scripts/live-check-m2.mjs` (M2), `scripts/live-check-m3.mjs` (M3),
`scripts/live-check-m4.mjs` (M4), `scripts/live-check-m5.mjs` (M5: the
CLI, the settings sections, a 390 px pass) and `scripts/live-check-m6.mjs`
(the commit panel's file menu, group discard and LGTM - Commit, which sends
a real message to the thread) on `scripts/live-lib.mjs` (system
Chromium + puppeteer-core against `$BB_SERVER_URL`; fixture content must be
unique per run, the scratch repo is reused). `scripts/screenshots.mjs`
regenerates `docs/screenshots/popup.png`, the only shot it still takes; with
no repository argument it touches no git. `commit.png`, `log.png`,
`log-menu.png`, `branch-menu.png`, `new-branch.png`, `checkout-revision.png`
and `settings.png` are hand-taken and the script leaves them alone: the commit
shot is worth having with a diff open and headless Chromium photographs the
diff viewer as an empty pane, the log shot over a real history, which the
scratch repo has not got, and the rest are menus and dialogs it cannot open. `scripts/hero.mjs` composes the README's header
image (`docs/screenshots/hero.png`) from those shots and `docs/hero/`
(the background and the thread-header crop) by photographing a local HTML
page, so it needs Chromium but no running bb. `scripts/combos.mjs`
composes the two section images the same way: `popup-combo.png` from
`popup.png`, `branch-menu.png`, `new-branch.png` and `checkout-revision.png`,
and `log-combo.png` from `log.png` and `log-menu.png`. Those six hand-taken
shots stay in `docs/screenshots/`, but the README shows only the two sheets.

Vendor UI with `npx shadcn add @bb/<name>` (registry pinned in
`components.json`); components live in `components/ui/` and are ours to edit.
Styling is Tailwind against host theme tokens only.

## Rules

- Never commit or push in this repo unless Costa asks. The plugin's own Push
  button is for the human clicking it.
- No shell strings: `execFile("git", argv)`; branch names validated with
  `isValidGitBranchName` client-side and `git check-ref-format --branch` on the
  host; refs after `--end-of-options`, paths after `--`.
- Pre-flight before any mutation (index.lock, merge/rebase markers, detached
  HEAD, missing upstream) and typed error codes instead of thrown errors.
- Confirm dialogs show the exact git command for push, delete, rebase, merge,
  abort, worktree, detached checkout, force-with-lease, amend, discard,
  cherry-pick, revert and reset (`--hard` is destructive).
  Plain `--force` is not representable. The commit panel's checkbox is the
  staged state and Commit commits the index, never a path list; paths run
  under `--literal-pathspecs` after `--`; the message goes on stdin. A push always names remote and refspec (`PushPlan` in
  `shared/model.ts`, HEAD or `refs/heads/<branch>`) and the host runs exactly
  the previewed argv or answers `no_upstream` / `head_changed`; it never
  upgrades or redirects a push. The lease is only ever the sha the dialog
  showed.
- No agent-callable mutation: `bb vcs-widget` and `vcs_widget_status` are
  read-only, and stay that way by construction — `server/cli.ts` is their only
  path to the host and it knows two reads. The RPC route itself is bb's
  local-auth API and reachable by any local process with a thread id; the
  plugin cannot enforce more than logging each mutation with its thread id
  (`docs/SAFETY.md`).
- `docs/COMMANDS.md` tables every argv the branch menu, the log panel and the
  commit panel run; `docs/PUSH.md` holds the push, because that one is
  behaviour rather than a list. Changing a command means changing the table.
  Being able to read them is why someone installs this rather than a wrapper
  that hides them, so a stale table costs more than no table.
- `README.md` and `PLUGIN_OVERVIEW.md` are the two files a human reads, and
  Costa's `costa-writing-style` skill governs both. The overview is not a
  short README and must never point at one: the marketplace copies it verbatim
  as the listing's overview file, so it stands alone. Keep the two in
  agreement, and in agreement with what the UI actually says — the popup once
  headed a group "Favorites" while the settings section said "Favourite
  branches", and the README faithfully reproduced both.
- `docs/SAFETY.md` ("Safety model") is load-bearing: `CHANGELOG.md`, this
  file, `README.md`, `server.ts` and `views/SettingsSections.tsx` all name it,
  the last of those in text the user reads. Moving or renaming it means
  changing those. The README keeps a short version of it and links the file.

## References

- bb source checkout: `/home/costa/Work/bb` (SDK declarations in
  `packages/plugin-sdk/src/{app-contract,backend-contract,host-contract}.ts`).
- Reference plugin with the same shape (server -> host running git):
  `/home/costa/.bb/plugins/cache/git/github.com/yusuf8834/bb-git-history/<commit>/`.
- UI patterns: `plugins/tasks/views/detail/rail.tsx` (Popover + Command),
  `plugins/tasks/views/list/property-menus.tsx` (ContextMenu with submenus),
  `apps/app/src/components/pickers/BranchPicker.tsx` (bb's branch picker).
