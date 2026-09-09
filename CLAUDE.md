# bb-plugin-vcs-group

A bb plugin (id `vcs-group`, display name "VCS Group") that recreates the
IntelliJ / Android Studio Git branches popup inside bb: a branch button in the
thread header, a searchable popup with Recent / Local / Remote branches, and
git actions that run on the machine owning the thread's worktree.

## Work board

Linear project `bb-plugin-vcs-group`, label `lab`, team `COS`. The plan lives
in the issue descriptions, progress in issue comments (`claude: step N done,
<what>`), never in files here.

- COS-121 Milestone 1: branch popup + checkout, new branch, update, push (full architecture, contracts, steps, verification) — shipped 2026-09-09
- COS-122 Milestone 2: full context menu, background push/pull jobs, live refresh, favourites
- COS-123 Milestone 3: own commit dialog
- COS-124 Milestone 4: own git log panel
- COS-125 Milestone 5: settings, read-only CLI and agent tool, release

To resume: `bb status`, read this file, `linear issue view COS-121 --json`
(and its comments), load the `bb-plugin-authoring` skill with the Skill tool,
continue from the last completed step.

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
- `server.ts` resolves thread to environment, forwards to the host, then nudges
  `bb.sdk.environments.status` (0 s and 3.2 s) and publishes `changed`.
- `app.tsx` registers `experimental_threadHeaderAction` plus
  `commandPaletteAction` rows; the popup is a portalled Popover + cmdk Command
  with plugin-owned ranking (`shared/model.ts`). Palette rows hand their
  request to the button through `lib/events.ts` module scope, never through
  an event `detail`.
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
bb plugin logs vcs-group -f  # plugin log
bb plugin reload vcs-group   # after `bb plugin build` without `dev`
```

Live click-through: `docs/VERIFY.md`, driven by `scripts/live-check.mjs`
(system Chromium + puppeteer-core against `$BB_SERVER_URL`).

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
  worktree, force-with-lease. Plain `--force` is not representable. A push
  always names remote and refspec (`PushPlan` in `shared/model.ts`) and the
  host runs exactly the previewed argv or answers `no_upstream` /
  `head_changed`; it never upgrades or redirects a push.
- No agent-callable mutation: the CLI and agent tool (milestone 5) are
  read-only. The RPC route itself is bb's local-auth API and reachable by any
  local process with a thread id; the plugin cannot enforce more than logging
  each mutation with its thread id (README, "Safety model").

## References

- bb source checkout: `/home/costa/Work/bb` (SDK declarations in
  `packages/plugin-sdk/src/{app-contract,backend-contract,host-contract}.ts`).
- Reference plugin with the same shape (server -> host running git):
  `/home/costa/.bb/plugins/cache/git/github.com/yusuf8834/bb-git-history/<commit>/`.
- UI patterns: `plugins/tasks/views/detail/rail.tsx` (Popover + Command),
  `plugins/tasks/views/list/property-menus.tsx` (ContextMenu with submenus),
  `apps/app/src/components/pickers/BranchPicker.tsx` (bb's branch picker).
