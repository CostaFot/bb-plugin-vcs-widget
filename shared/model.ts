// DOM-free popup logic: grouping, ranking, IntelliJ labels, confirm tiers and
// the exact git argv each action runs. The host builds its argv through
// `gitArgvFor`, and the confirm dialog previews the same argv, so the two can
// never drift.
import type {
  BranchRef,
  ChangeEntry,
  ChangesResult,
  CompareRef,
  LocalBranch,
  LogCommit,
  Operation,
  Overview,
  PullStrategy,
  RemoteBranch,
  ResetMode,
} from "../contracts";
import { isValidRemoteName } from "./branch-name";
import { MIN_GIT_VERSION } from "./constants";
import { gitVersionAtLeast, splitRemoteRef } from "./parse";

// ---------------------------------------------------------------------------
// Git plans: what the host is about to run.
// ---------------------------------------------------------------------------

/**
 * A push always names its remote and refspec, so the user's push.default,
 * remote.pushDefault and branch.*.pushRemote cannot change what it does.
 * `branch` null pushes HEAD (the current branch); a name pushes that local
 * branch wherever HEAD is. A tracked push needs the upstream branch name; the
 * type makes a bare `git push` unrepresentable. `lease` is the remote sha the
 * dialog saw: `--force-with-lease=<upstream>:<lease>` is the only force.
 */
export type PushPlan =
  | { op: "push"; remote: string; branch: string | null; setUpstream: true }
  | { op: "push"; remote: string; branch: string | null; setUpstream: false; upstreamBranch: string; lease: string | null };

export type GitPlan =
  | { op: "switch"; name: string }
  | { op: "switch-track"; remote: string; branch: string }
  | { op: "switch-detach"; revision: string }
  | { op: "create"; name: string; startPoint: string | null; checkout: boolean }
  | { op: "fetch"; remote: string | null; prune: boolean }
  | { op: "fetch-branch"; remote: string; upstreamBranch: string; branch: string }
  | { op: "pull"; strategy: PullStrategy; autoStash: boolean }
  | { op: "delete-local"; name: string; force: boolean }
  | { op: "delete-remote"; remote: string; branch: string }
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; ref: string }
  | { op: "rebase"; onto: string }
  | { op: "abort"; operation: Exclude<Operation, "none"> }
  | { op: "set-upstream"; branch: string; upstream: string | null }
  | { op: "worktree-add"; path: string; branch: string }
  | { op: "worktree-add-track"; path: string; remote: string; branch: string }
  // Path commands run under --literal-pathspecs: no globbing, no magic.
  | { op: "stage"; paths: readonly string[] }
  | { op: "unstage"; paths: readonly string[] }
  | { op: "restore-head"; paths: readonly string[] }
  | { op: "rm-cached"; paths: readonly string[] }
  | { op: "clean"; paths: readonly string[] }
  /** The message goes on stdin (`-F -`); it is never an argument. */
  | { op: "commit"; amend: boolean; signoff: boolean; noVerify: boolean }
  // Log actions. The sha is the one the row showed, never a name that could
  // have moved between reading the log and running the command.
  | { op: "cherry-pick"; sha: string }
  | { op: "revert"; sha: string }
  | { op: "reset"; mode: ResetMode; sha: string }
  | PushPlan;

/** The full ref a popup entry stands for; tags cannot shadow it. */
export function fullRef(ref: BranchRef): string {
  return ref.kind === "local" ? `refs/heads/${ref.name}` : `refs/remotes/${ref.remote}/${ref.branch}`;
}

/** The name the popup shows for a ref; a log revision stands for itself. */
export function refLabel(ref: CompareRef): string {
  if (ref.kind === "revision") return ref.revision.length > 12 ? ref.revision.slice(0, 12) : ref.revision;
  return ref.kind === "local" ? ref.name : `${ref.remote}/${ref.branch}`;
}

export function gitArgvFor(plan: GitPlan): string[] {
  switch (plan.op) {
    case "switch":
      return ["switch", "--no-guess", "--end-of-options", plan.name];
    case "switch-track":
      // The full ref: a tag named like the branch would make the short name
      // ambiguous.
      return [
        "switch",
        "-c",
        plan.branch,
        "--track",
        "--end-of-options",
        `refs/remotes/${plan.remote}/${plan.branch}`,
      ];
    case "switch-detach":
      return ["switch", "--detach", "--end-of-options", plan.revision];
    case "create": {
      const start = plan.startPoint === null ? [] : [plan.startPoint];
      return plan.checkout
        ? ["switch", "-c", plan.name, "--end-of-options", ...start]
        : ["branch", "--end-of-options", plan.name, ...start];
    }
    case "fetch":
      return [
        "fetch",
        "--no-progress",
        ...(plan.prune ? ["--prune"] : []),
        ...(plan.remote === null ? ["--all"] : ["--end-of-options", plan.remote]),
      ];
    case "fetch-branch":
      // Without a leading "+" git only fast-forwards the local branch.
      return ["fetch", "--no-progress", "--end-of-options", plan.remote, `refs/heads/${plan.upstreamBranch}:refs/heads/${plan.branch}`];
    case "pull": {
      const strategy =
        plan.strategy === "ff-only"
          ? "--ff-only"
          : plan.strategy === "rebase"
            ? "--rebase"
            : "--no-rebase";
      return ["pull", "--no-progress", "--no-edit", strategy, ...(plan.autoStash ? ["--autostash"] : [])];
    }
    case "delete-local":
      return ["branch", plan.force ? "-D" : "-d", "--end-of-options", plan.name];
    case "delete-remote":
      return ["push", "--no-progress", "--delete", "--end-of-options", plan.remote, `refs/heads/${plan.branch}`];
    case "rename":
      return ["branch", "-m", "--end-of-options", plan.from, plan.to];
    case "merge":
      return ["merge", "--no-edit", "--end-of-options", plan.ref];
    case "rebase":
      return ["rebase", "--end-of-options", plan.onto];
    case "abort":
      return [plan.operation, "--abort"];
    case "set-upstream":
      return plan.upstream === null
        ? ["branch", "--unset-upstream", "--end-of-options", plan.branch]
        : ["branch", `--set-upstream-to=${plan.upstream}`, "--end-of-options", plan.branch];
    case "worktree-add":
      // The short name on purpose: a full ref would check out a detached HEAD.
      return ["worktree", "add", "--end-of-options", plan.path, plan.branch];
    case "worktree-add-track":
      return ["worktree", "add", "--track", "-b", plan.branch, "--end-of-options", plan.path, `refs/remotes/${plan.remote}/${plan.branch}`];
    case "stage":
      return ["--literal-pathspecs", "add", "-A", "--", ...plan.paths];
    case "unstage":
      // `reset` rather than `restore --staged`: it also works before the first commit.
      return ["--literal-pathspecs", "reset", "-q", "--", ...plan.paths];
    case "restore-head":
      return ["--literal-pathspecs", "restore", "--staged", "--worktree", "--source=HEAD", "--", ...plan.paths];
    case "rm-cached":
      return ["--literal-pathspecs", "rm", "-q", "--cached", "--", ...plan.paths];
    case "clean":
      return ["--literal-pathspecs", "clean", "-f", "--", ...plan.paths];
    case "commit":
      return [
        "commit",
        "-F",
        "-",
        ...(plan.amend ? ["--amend"] : []),
        ...(plan.signoff ? ["--signoff"] : []),
        ...(plan.noVerify ? ["--no-verify"] : []),
      ];
    case "cherry-pick":
      return ["cherry-pick", "--end-of-options", plan.sha];
    case "revert":
      return ["revert", "--no-edit", "--end-of-options", plan.sha];
    case "reset":
      // The trailing `--` keeps a file named like the sha from being taken
      // as a pathspec, which would reset that path instead of the branch.
      return ["reset", `--${plan.mode}`, "--end-of-options", plan.sha, "--"];
    case "push": {
      const source = plan.branch === null ? "HEAD" : `refs/heads/${plan.branch}`;
      if (plan.setUpstream) {
        return [
          "push",
          "--no-progress",
          "-u",
          "--end-of-options",
          plan.remote,
          plan.branch === null ? "HEAD" : `${source}:refs/heads/${plan.branch}`,
        ];
      }
      return [
        "push",
        "--no-progress",
        ...(plan.lease === null ? [] : [`--force-with-lease=refs/heads/${plan.upstreamBranch}:${plan.lease}`]),
        "--end-of-options",
        plan.remote,
        `${source}:refs/heads/${plan.upstreamBranch}`,
      ];
    }
  }
}

export interface PushIntent {
  plan: PushPlan;
  /** The branch being pushed; the host refuses if it moved. */
  branch: string;
  /** Short sha of the branch when the intent was built. */
  sha: string;
  /** `<remote>/<branch>` the push will update or create. */
  target: string;
  /** Short sha of the remote-tracking ref, for a lease; null when unknown. */
  remoteSha: string | null;
  /** Why the plan sets an upstream, for the dialog copy. */
  reason: "tracked" | "no-upstream" | "gone" | "local-upstream";
  /** The upstream name the branch tracks, when it has one. */
  upstreamName: string | null;
}

/**
 * Decides what a push does from the overview the dialog shows: push to the
 * tracked branch when it exists on a configured remote, otherwise create
 * `<defaultRemote>/<branch>` and track it. Without `branch` the current
 * branch is pushed as HEAD; null when there is no such branch.
 */
export function pushIntentFor(overview: Overview, defaultRemote: string, branch?: LocalBranch): PushIntent | null {
  let name: string;
  let sha: string;
  let upstream: { name: string; remote: string | null; branch: string | null; gone: boolean } | null;
  let source: string | null;
  if (branch === undefined) {
    if (overview.head?.kind !== "branch") return null;
    name = overview.head.name;
    sha = overview.head.sha;
    upstream = overview.upstream;
    source = null;
  } else {
    name = branch.name;
    sha = branch.sha;
    source = branch.isCurrent ? null : branch.name;
    upstream = branch.upstream === null ? null : { name: branch.upstream, ...upstreamPartsOf(branch.upstream, overview.remotes), gone: branch.gone };
  }
  const create = (reason: PushIntent["reason"]): PushIntent => ({
    plan: { op: "push", remote: defaultRemote, branch: source, setUpstream: true },
    branch: name,
    sha,
    target: `${defaultRemote}/${name}`,
    remoteSha: null,
    reason,
    upstreamName: upstream?.name ?? null,
  });
  if (upstream === null) return create("no-upstream");
  if (upstream.gone) return create("gone");
  if (upstream.remote === null || upstream.branch === null || !isValidRemoteName(upstream.remote)) {
    return create("local-upstream");
  }
  const target = `${upstream.remote}/${upstream.branch}`;
  return {
    plan: { op: "push", remote: upstream.remote, branch: source, setUpstream: false, upstreamBranch: upstream.branch, lease: null },
    branch: name,
    sha,
    target,
    remoteSha: overview.remote.find((candidate) => candidate.name === target)?.sha ?? null,
    reason: "tracked",
    upstreamName: upstream.name,
  };
}

/** The same push with `--force-with-lease` against the remote sha the dialog saw. */
export function withLease(plan: PushPlan, remoteSha: string | null): PushPlan {
  if (plan.setUpstream || remoteSha === null) return plan;
  return { ...plan, lease: remoteSha };
}

function upstreamPartsOf(name: string, remotes: readonly string[]): { remote: string | null; branch: string | null } {
  const split = splitRemoteRef(name, remotes);
  if (split === null || !remotes.includes(split.remote)) return { remote: null, branch: null };
  return split;
}

/** Human-readable preview of the command, for confirm dialogs and logs. */
export function gitCommandPreview(plan: GitPlan): string {
  return ["git", ...gitArgvFor(plan).map(quoteForDisplay)].join(" ");
}

/** Several commands run in sequence, one per line. */
export function gitCommandsPreview(plans: readonly GitPlan[]): string {
  return plans.map(gitCommandPreview).join("\n");
}

function quoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replace(/'/gu, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Commit panel: what a status entry means and how to discard it
// ---------------------------------------------------------------------------

/** True when the index holds a version of the file that differs from HEAD. */
export function isStaged(entry: ChangeEntry): boolean {
  return entry.kind !== "untracked" && entry.index !== ".";
}

/** True when the working tree differs from the index (or the file is untracked). */
export function hasUnstagedChange(entry: ChangeEntry): boolean {
  return entry.kind === "untracked" || entry.worktree !== ".";
}

/** Checkbox state for a row: staged, unstaged, or a bit of both. */
export function stageState(entry: ChangeEntry): "staged" | "unstaged" | "partial" {
  const staged = isStaged(entry);
  const unstaged = hasUnstagedChange(entry);
  return staged && unstaged ? "partial" : staged ? "staged" : "unstaged";
}

/** Which sides of a change a diff can show, staged first. */
export function diffSidesFor(entry: ChangeEntry): ("index" | "worktree")[] {
  if (entry.kind === "untracked") return ["worktree"];
  if (entry.kind === "conflicted") return ["worktree"];
  const sides: ("index" | "worktree")[] = [];
  if (entry.index !== ".") sides.push("index");
  if (entry.worktree !== ".") sides.push("worktree");
  return sides.length === 0 ? ["worktree"] : sides;
}

export interface DiscardPlan {
  /** Tracked in HEAD: restored in the index and the working tree. */
  restore: string[];
  /** New to the index (added, copied, the new side of a rename): unstaged and kept on disk. */
  remove: string[];
  /** Untracked: deleted. */
  clean: string[];
  /** Conflicted entries cannot be discarded; listed so the dialog can say so. */
  skipped: string[];
}

/**
 * Sorts the selected entries into the three discard commands. Only the
 * status letters decide: a path in HEAD is restored, a path that exists only
 * in the index is unstaged (the file stays), an untracked file is deleted.
 */
export function discardPlanFor(entries: readonly ChangeEntry[]): DiscardPlan {
  const plan: DiscardPlan = { restore: [], remove: [], clean: [], skipped: [] };
  for (const entry of entries) {
    if (entry.kind === "conflicted") {
      plan.skipped.push(entry.path);
    } else if (entry.kind === "untracked") {
      plan.clean.push(entry.path);
    } else if (entry.index === "R") {
      if (entry.oldPath !== null) plan.restore.push(entry.oldPath);
      plan.remove.push(entry.path);
    } else if (entry.index === "A" || entry.index === "C" || (entry.index === "." && entry.worktree === "A")) {
      plan.remove.push(entry.path);
    } else {
      plan.restore.push(entry.path);
    }
  }
  return plan;
}

/** The git commands a discard plan runs, in order; empty categories are skipped. */
export function discardPlans(plan: { restore: readonly string[]; remove: readonly string[]; clean: readonly string[] }): GitPlan[] {
  const plans: GitPlan[] = [];
  if (plan.restore.length > 0) plans.push({ op: "restore-head", paths: plan.restore });
  if (plan.remove.length > 0) plans.push({ op: "rm-cached", paths: plan.remove });
  if (plan.clean.length > 0) plans.push({ op: "clean", paths: plan.clean });
  return plans;
}

/**
 * Why the commit panel cannot commit right now; null when it can. An
 * operation in progress does not block: committing is how a merge or a
 * cherry-pick concludes once its conflicts are staged.
 */
export function commitBlockedReason(overview: Overview | null, changes: ChangesResult | null): string | null {
  if (overview !== null) {
    if (overview.unavailableReason !== null) return overview.unavailableReason;
    if (gitTooOld(overview)) return `git ${overview.gitVersion ?? "?"} is too old; the plugin needs ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}.`;
    if (overview.activeJob !== null) return `${JOB_VERB[overview.activeJob.kind] ?? "A job"} is running.`;
  }
  if (changes !== null && !changes.ok) return changes.error.message;
  if (changes?.ok && changes.indexLocked) return "Another git process holds the index lock.";
  if (changes?.ok) {
    const conflicts = changes.files.filter((entry) => entry.kind === "conflicted").length;
    if (conflicts > 0) return `${conflicts} conflicted file${conflicts === 1 ? "" : "s"}; resolve and stage them first.`;
  }
  return null;
}

/** IntelliJ's status colours: the letter shown next to a commit panel row. */
export function statusLetter(entry: ChangeEntry): string {
  if (entry.kind === "untracked") return "?";
  if (entry.kind === "conflicted") return "U";
  return entry.index !== "." ? entry.index : entry.worktree;
}

/**
 * IntelliJ's default: a sibling directory named after the repository and the
 * branch. `repoRoot` is a POSIX path from git; a Windows host prints forward
 * slashes there too.
 */
export function worktreePathFor(repoRoot: string, branch: string): string {
  const trimmed = repoRoot.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");
  const parent = slash <= 0 ? "" : trimmed.slice(0, slash);
  const base = trimmed.slice(slash + 1);
  const suffix = branch.replace(/[\\/]+/gu, "-").replace(/[^A-Za-z0-9._-]+/gu, "-");
  return `${parent}/${base}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Grouping and ranking
// ---------------------------------------------------------------------------

export type BranchEntry =
  | { kind: "local"; branch: LocalBranch }
  | { kind: "remote"; branch: RemoteBranch };

/** The stable key a favourite is stored under. */
export function entryKey(entry: BranchEntry): string {
  return `${entry.kind}:${entry.branch.name}`;
}

/**
 * The reverse, for the settings page, which lists stored keys without an
 * overview to match them against. A key from an older version that fits
 * neither prefix is shown as it was stored rather than dropped.
 */
export function favouriteLabel(key: string): { name: string; kind: "local" | "remote" | "unknown" } {
  if (key.startsWith("local:")) return { name: key.slice("local:".length), kind: "local" };
  if (key.startsWith("remote:")) return { name: key.slice("remote:".length), kind: "remote" };
  return { name: key, kind: "unknown" };
}

export interface BranchGroups {
  favourites: BranchEntry[];
  recent: LocalBranch[];
  local: LocalBranch[];
  remote: RemoteBranch[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export function groupBranches(overview: Overview, favourites: ReadonlySet<string> = new Set()): BranchGroups {
  const localByName = new Map(overview.local.map((branch) => [branch.name, branch]));
  const recent = overview.recent
    .map((name) => localByName.get(name))
    .filter((branch): branch is LocalBranch => branch !== undefined);
  const local = [...overview.local].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return byName(a, b);
  });
  const remote = [...overview.remote].sort(byName);
  const entries: BranchEntry[] = [
    ...local.map((branch): BranchEntry => ({ kind: "local", branch })),
    ...remote.map((branch): BranchEntry => ({ kind: "remote", branch })),
  ];
  return { favourites: entries.filter((entry) => favourites.has(entryKey(entry))), recent, local, remote };
}

export type RankedItem<T> = { item: T; score: number };

/**
 * Scores a name against a query: exact > prefix > path-component prefix >
 * substring > in-order subsequence. 0 means no match.
 */
export function matchScore(name: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === "") return 1;
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split("/").some((component) => component.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  let cursor = 0;
  for (const char of q) {
    cursor = n.indexOf(char, cursor);
    if (cursor === -1) return 0;
    cursor += 1;
  }
  return 20;
}

/** Filters and stably ranks items by `matchScore` of their name; empty query keeps the order. */
export function filterAndRank<T extends { name: string }>(
  items: readonly T[],
  query: string,
  bonus: (item: T) => number = () => 0,
): T[] {
  if (query.trim() === "") return [...items];
  return items
    .map((item, index) => ({ item, index, score: matchScore(item.name, query) }))
    .filter((entry) => entry.score > 0)
    .map((entry) => ({ ...entry, score: entry.score + bonus(entry.item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** Ranking bonus for a favourite branch. */
export const FAVOURITE_BONUS = 15;

// ---------------------------------------------------------------------------
// Blocking states
// ---------------------------------------------------------------------------

export function gitTooOld(overview: Overview): boolean {
  return !gitVersionAtLeast(overview.gitVersion, MIN_GIT_VERSION.major, MIN_GIT_VERSION.minor);
}

const JOB_VERB: Record<string, string> = {
  fetch: "A fetch",
  pull: "An update",
  push: "A push",
  updateBranch: "An update",
  deleteRemoteBranch: "A remote delete",
  commit: "A commit",
};

/** Why nothing may mutate the repository right now; null when it may. */
export function blockingReason(overview: Overview): string | null {
  if (overview.unavailableReason !== null) return overview.unavailableReason;
  if (gitTooOld(overview)) return `git ${overview.gitVersion ?? "?"} is too old; the plugin needs ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}.`;
  if (overview.activeJob !== null) return `${JOB_VERB[overview.activeJob.kind] ?? "A job"} is running.`;
  if (overview.operation !== "none") return `A ${overview.operation} is in progress.`;
  if (overview.indexLocked) return "Another git process holds the index lock.";
  return null;
}

// ---------------------------------------------------------------------------
// Labels (the IntelliJ strings) and quick actions
// ---------------------------------------------------------------------------

export type QuickActionId = "update" | "commit" | "log" | "fetch" | "push" | "new-branch" | "checkout-revision";

export interface QuickAction {
  id: QuickActionId;
  label: string;
  /** IntelliJ chord, shown as a hint only (bb owns the global bindings). */
  hint: string | null;
  disabled: boolean;
  reason: string | null;
}

export function quickActionsFor(overview: Overview): QuickAction[] {
  const unavailable = overview.unavailableReason !== null;
  const detached = overview.head?.kind === "detached";
  const unborn = overview.head?.kind === "unborn";
  const noRemote = overview.remotes.length === 0;
  const busyReason = blockingReason(overview);
  const disable = (reason: string | null): { disabled: boolean; reason: string | null } => ({
    disabled: reason !== null,
    reason,
  });
  const networkReason = unavailable
    ? overview.unavailableReason
    : noRemote
      ? "No remote configured."
      : detached
        ? "Check out a branch first."
        : unborn
          ? "Make a first commit first."
          : busyReason;
  return [
    { id: "update", label: "Update Project", hint: "Ctrl+T", ...disable(networkReason) },
    // A commit is legal on a detached HEAD and as the first commit; only a
    // blocked repository stops it.
    { id: "commit", label: "Commit...", hint: "Ctrl+K", ...disable(unavailable ? overview.unavailableReason : busyReason) },
    // A read: it works during a job and on a branch with no commits yet.
    { id: "log", label: "Show Git Log", hint: "Alt+9", ...disable(unavailable ? overview.unavailableReason : null) },
    {
      id: "fetch",
      label: "Fetch",
      hint: null,
      ...disable(unavailable ? overview.unavailableReason : noRemote ? "No remote configured." : busyReason),
    },
    { id: "push", label: "Push...", hint: "Ctrl+Shift+K", ...disable(networkReason) },
    {
      id: "new-branch",
      label: "New Branch...",
      hint: "Ctrl+Alt+N",
      ...disable(unavailable ? overview.unavailableReason : unborn ? "Make a first commit first." : busyReason),
    },
    {
      id: "checkout-revision",
      label: "Checkout Tag or Revision...",
      hint: null,
      ...disable(unavailable ? overview.unavailableReason : unborn ? "Make a first commit first." : busyReason),
    },
  ];
}

export type BranchMenuItemId =
  | "checkout"
  | "new-branch-from"
  | "checkout-rebase"
  | "checkout-update"
  | "compare"
  | "diff-working-tree"
  | "show-log"
  | "rebase"
  | "merge"
  | "new-worktree"
  | "update"
  | "push"
  | "tracked-branch"
  | "rename"
  | "delete"
  | "favourite"
  | "copy-name";

/** One row of the Tracked Branch submenu. */
export interface TrackedOption {
  /** `<remote>/<branch>`, or null for "None". */
  upstream: { remote: string; branch: string } | null;
  label: string;
  checked: boolean;
}

export interface BranchMenuItem {
  id: BranchMenuItemId;
  label: string;
  disabled: boolean;
  reason: string | null;
  separatorBefore: boolean;
  /** IntelliJ chord, shown as a hint only. */
  hint: string | null;
  /** Only for `tracked-branch`. */
  children?: TrackedOption[];
}

const quote = (name: string) => `'${name}'`;

export function labelFor(id: BranchMenuItemId, branchName: string, current: string | null, favourite = false): string {
  const cur = current === null ? "current" : quote(current);
  switch (id) {
    case "checkout":
      return "Checkout";
    case "new-branch-from":
      return `New Branch from ${quote(branchName)}...`;
    case "checkout-rebase":
      return `Checkout and Rebase onto ${cur}`;
    case "checkout-update":
      return "Checkout and Update";
    case "compare":
      return `Compare with ${cur}`;
    case "diff-working-tree":
      return "Show Diff with Working Tree";
    case "show-log":
      return "Show Log";
    case "rebase":
      return `Rebase ${cur} onto ${quote(branchName)}`;
    case "merge":
      return `Merge ${quote(branchName)} into ${cur}`;
    case "new-worktree":
      return `New Worktree from ${quote(branchName)}...`;
    case "update":
      return "Update";
    case "push":
      return "Push...";
    case "tracked-branch":
      return "Tracked Branch";
    case "rename":
      return "Rename...";
    case "delete":
      return "Delete";
    case "favourite":
      return favourite ? "Remove from Favorites" : "Add to Favorites";
    case "copy-name":
      return "Copy Branch Name";
  }
}

/** The tracked-branch choices for a local branch: same-named remotes first. */
export function trackedOptionsFor(branch: LocalBranch, overview: Overview): TrackedOption[] {
  const current = branch.upstream;
  const sorted = [...overview.remote].sort((a, b) => {
    const aSame = a.branch === branch.name ? 0 : 1;
    const bSame = b.branch === branch.name ? 0 : 1;
    return aSame - bSame || byName(a, b);
  });
  return [
    ...sorted.map((remote) => ({
      upstream: { remote: remote.remote, branch: remote.branch },
      label: remote.name,
      checked: current === remote.name,
    })),
    { upstream: null, label: "None", checked: current === null },
  ];
}

/** The IntelliJ context menu for one popup entry. */
export function menuFor(
  entry: BranchEntry,
  overview: Overview,
  options: { favourite?: boolean } = {},
): BranchMenuItem[] {
  const isCurrent = entry.kind === "local" && entry.branch.isCurrent;
  const name = entry.branch.name;
  const current = overview.head?.kind === "branch" ? overview.head.name : null;
  const onBranch = current !== null;
  const busy = blockingReason(overview);
  const noBranch = onBranch ? null : overview.head?.kind === "unborn" ? "Make a first commit first." : "Check out a branch first.";
  const otherWorktree =
    entry.kind === "local" && entry.branch.worktreePath !== null
      ? `Checked out in another worktree (${entry.branch.worktreePath}).`
      : null;
  const first = (...reasons: (string | null)[]) => reasons.find((reason) => reason !== null) ?? null;
  const item = (
    id: BranchMenuItemId,
    reason: string | null,
    extra: Partial<Pick<BranchMenuItem, "separatorBefore" | "hint" | "children">> = {},
  ): BranchMenuItem => ({
    id,
    label: labelFor(id, name, current, options.favourite),
    disabled: reason !== null,
    reason,
    separatorBefore: extra.separatorBefore ?? false,
    hint: extra.hint ?? null,
    ...(extra.children === undefined ? {} : { children: extra.children }),
  });

  const items: BranchMenuItem[] = [];
  const checkoutReason = first(isCurrent ? "Already checked out." : null, otherWorktree, busy);
  items.push(item("checkout", checkoutReason));
  items.push(item("new-branch-from", busy));
  items.push(item("checkout-rebase", first(isCurrent ? "Already checked out." : null, otherWorktree, noBranch, busy)));
  if (entry.kind === "local") {
    const upstreamReason =
      entry.branch.upstream === null
        ? "No upstream branch."
        : entry.branch.gone
          ? "The upstream branch is gone."
          : upstreamPartsOf(entry.branch.upstream, overview.remotes).remote === null
            ? "The upstream is not on a remote."
            : null;
    items.push(item("checkout-update", first(isCurrent ? "Already checked out." : null, otherWorktree, upstreamReason, busy)));
    items.push(item("compare", first(isCurrent ? "Nothing to compare with itself." : null, noBranch), { separatorBefore: true }));
    items.push(item("diff-working-tree", null));
    items.push(item("show-log", null));
    items.push(item("rebase", first(isCurrent ? "Already checked out." : null, noBranch, busy), { separatorBefore: true }));
    items.push(item("merge", first(isCurrent ? "Already checked out." : null, noBranch, busy)));
    items.push(item("new-worktree", first(otherWorktree, isCurrent ? "Already checked out here." : null, busy), { separatorBefore: true }));
    items.push(item("update", first(upstreamReason, busy), { separatorBefore: true }));
    items.push(item("push", first(overview.remotes.length === 0 ? "No remote configured." : null, busy)));
    items.push(
      item("tracked-branch", first(overview.remote.length === 0 && entry.branch.upstream === null ? "No remote branches." : null, busy), {
        children: trackedOptionsFor(entry.branch, overview),
      }),
    );
    items.push(item("rename", busy, { separatorBefore: true, hint: "F2" }));
    items.push(item("delete", first(isCurrent ? "Cannot delete the current branch." : null, otherWorktree, busy)));
  } else {
    items.push(item("compare", noBranch, { separatorBefore: true }));
    items.push(item("diff-working-tree", null));
    items.push(item("show-log", null));
    items.push(item("rebase", first(noBranch, busy), { separatorBefore: true }));
    items.push(item("merge", first(noBranch, busy)));
    items.push(item("new-worktree", first(entry.branch.hasLocal ? `A local branch '${entry.branch.branch}' already exists.` : null, busy), { separatorBefore: true }));
    items.push(item("delete", busy, { separatorBefore: true }));
  }
  items.push(item("favourite", null, { separatorBefore: true }));
  items.push(item("copy-name", null));
  return items;
}

// ---------------------------------------------------------------------------
// The log's per-commit context menu
// ---------------------------------------------------------------------------

export type CommitMenuItemId =
  | "checkout-revision"
  | "new-branch-from"
  | "cherry-pick"
  | "revert"
  | "reset"
  | "compare"
  | "copy-hash";

export interface ResetOption {
  mode: ResetMode;
  label: string;
  description: string;
}

export interface CommitMenuItem {
  id: CommitMenuItemId;
  label: string;
  disabled: boolean;
  reason: string | null;
  separatorBefore: boolean;
  /** Only for `reset`. */
  children?: readonly ResetOption[];
}

export const RESET_OPTIONS: readonly ResetOption[] = [
  { mode: "soft", label: "Soft", description: "Move the branch only; the index and the files stay as they are." },
  { mode: "mixed", label: "Mixed", description: "Move the branch and reset the index; the files stay as they are." },
  { mode: "hard", label: "Hard", description: "Move the branch and throw away every change in the index and the files." },
];

export function labelForCommitItem(id: CommitMenuItemId, shortSha: string, current: string | null): string {
  switch (id) {
    case "checkout-revision":
      return "Checkout Revision";
    case "new-branch-from":
      return `New Branch from ${quote(shortSha)}...`;
    case "cherry-pick":
      return "Cherry-Pick";
    case "revert":
      return "Revert Commit";
    case "reset":
      return "Reset Current Branch to Here...";
    case "compare":
      return `Compare with ${current === null ? "current" : quote(current)}`;
    case "copy-hash":
      return "Copy Revision Number";
  }
}

/** The context menu for one log row. */
export function commitMenuFor(commit: LogCommit, overview: Overview): CommitMenuItem[] {
  const current = overview.head?.kind === "branch" ? overview.head.name : null;
  const busy = blockingReason(overview);
  const noBranch = current !== null ? null : overview.head?.kind === "unborn" ? "Make a first commit first." : "Check out a branch first.";
  // `cherry-pick` and `revert` need `-m <parent>` for a merge, and picking
  // that parent is a dialog this plugin does not have.
  const isMerge = commit.parents.length > 1;
  const mergeReason = isMerge ? "This is a merge commit; pick a parent with git on the command line." : null;
  const first = (...reasons: (string | null)[]) => reasons.find((reason) => reason !== null) ?? null;
  const item = (id: CommitMenuItemId, reason: string | null, extra: Partial<Pick<CommitMenuItem, "separatorBefore" | "children">> = {}): CommitMenuItem => ({
    id,
    label: labelForCommitItem(id, commit.shortSha, current),
    disabled: reason !== null,
    reason,
    separatorBefore: extra.separatorBefore ?? false,
    ...(extra.children === undefined ? {} : { children: extra.children }),
  });
  return [
    item("checkout-revision", busy),
    item("new-branch-from", busy),
    item("cherry-pick", first(mergeReason, noBranch, busy), { separatorBefore: true }),
    item("revert", first(mergeReason, noBranch, busy)),
    item("reset", first(noBranch, busy), { children: RESET_OPTIONS }),
    item("compare", noBranch, { separatorBefore: true }),
    item("copy-hash", null),
  ];
}

// ---------------------------------------------------------------------------
// Confirm tiers
// ---------------------------------------------------------------------------

export type ConfirmTier = "none" | "confirm" | "destructive";

export function confirmTierFor(
  plan: GitPlan,
  context: { hasUncommittedChanges: boolean; confirmBeforePush: boolean },
): ConfirmTier {
  switch (plan.op) {
    case "push":
      if (!plan.setUpstream && plan.lease !== null) return "destructive";
      return context.confirmBeforePush || plan.setUpstream ? "confirm" : "none";
    case "pull":
      return context.hasUncommittedChanges && !plan.autoStash ? "confirm" : "none";
    case "delete-local":
      return plan.force ? "destructive" : "confirm";
    case "delete-remote":
      return "destructive";
    case "merge":
    case "rebase":
    case "abort":
    case "worktree-add":
    case "worktree-add-track":
    case "switch-detach":
      return "confirm";
    case "restore-head":
    case "rm-cached":
    case "clean":
      return "destructive";
    case "commit":
      return plan.amend ? "confirm" : "none";
    case "cherry-pick":
    case "revert":
      return "confirm";
    case "reset":
      // Only --hard throws work away; soft and mixed keep the files.
      return plan.mode === "hard" ? "destructive" : "confirm";
    case "switch":
    case "switch-track":
    case "create":
    case "fetch":
    case "fetch-branch":
    case "rename":
    case "set-upstream":
    case "stage":
    case "unstage":
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Header label
// ---------------------------------------------------------------------------

export function headLabel(overview: Overview | null, fallbackBranch: string | null): string {
  const head = overview?.head ?? null;
  if (head === null) return fallbackBranch ?? "No branch";
  switch (head.kind) {
    case "branch":
      return head.name;
    case "detached":
      return head.sha.slice(0, 7);
    case "unborn":
      return `${head.name} (no commits)`;
  }
}

export function hasUncommittedChanges(overview: Overview): boolean {
  const tree = overview.workingTree;
  return tree.staged + tree.unstaged + tree.conflicted > 0;
}
