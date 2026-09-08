// DOM-free popup logic: grouping, ranking, IntelliJ labels, confirm tiers and
// the exact git argv each action runs. The host builds its argv through
// `gitArgvFor`, and the confirm dialog previews the same argv, so the two can
// never drift.
import type { LocalBranch, Overview, PullStrategy, RemoteBranch } from "../contracts";

// ---------------------------------------------------------------------------
// Git plans: what the host is about to run.
// ---------------------------------------------------------------------------

export type GitPlan =
  | { op: "switch"; name: string }
  | { op: "switch-track"; remote: string; branch: string }
  | { op: "create"; name: string; startPoint: string | null; checkout: boolean }
  | { op: "fetch"; remote: string | null; prune: boolean }
  | { op: "pull"; strategy: PullStrategy; autoStash: boolean }
  | { op: "push"; remote: string; setUpstream: boolean };

export function gitArgvFor(plan: GitPlan): string[] {
  switch (plan.op) {
    case "switch":
      return ["switch", "--no-guess", "--end-of-options", plan.name];
    case "switch-track":
      return [
        "switch",
        "-c",
        plan.branch,
        "--track",
        "--end-of-options",
        `${plan.remote}/${plan.branch}`,
      ];
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
    case "pull": {
      const strategy =
        plan.strategy === "ff-only"
          ? "--ff-only"
          : plan.strategy === "rebase"
            ? "--rebase"
            : "--no-rebase";
      return ["pull", "--no-progress", "--no-edit", strategy, ...(plan.autoStash ? ["--autostash"] : [])];
    }
    case "push":
      return plan.setUpstream
        ? ["push", "--no-progress", "-u", "--end-of-options", plan.remote, "HEAD"]
        : ["push", "--no-progress"];
  }
}

/** Human-readable preview of the command, for confirm dialogs and logs. */
export function gitCommandPreview(plan: GitPlan): string {
  return ["git", ...gitArgvFor(plan).map(quoteForDisplay)].join(" ");
}

function quoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replace(/'/gu, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Grouping and ranking
// ---------------------------------------------------------------------------

export interface BranchGroups {
  recent: LocalBranch[];
  local: LocalBranch[];
  remote: RemoteBranch[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export function groupBranches(overview: Overview): BranchGroups {
  const localByName = new Map(overview.local.map((branch) => [branch.name, branch]));
  const recent = overview.recent
    .map((name) => localByName.get(name))
    .filter((branch): branch is LocalBranch => branch !== undefined);
  const local = [...overview.local].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return byName(a, b);
  });
  const remote = [...overview.remote].sort(byName);
  return { recent, local, remote };
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

// ---------------------------------------------------------------------------
// Labels (the IntelliJ strings) and quick actions
// ---------------------------------------------------------------------------

export type QuickActionId = "update" | "fetch" | "push" | "new-branch";

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
  const busyReason =
    overview.operation !== "none"
      ? `A ${overview.operation} is in progress.`
      : overview.indexLocked
        ? "Another git process holds the index lock."
        : null;
  const disable = (reason: string | null): { disabled: boolean; reason: string | null } => ({
    disabled: reason !== null,
    reason,
  });
  return [
    {
      id: "update",
      label: "Update Project",
      hint: "Ctrl+T",
      ...disable(
        unavailable
          ? overview.unavailableReason
          : noRemote
            ? "No remote configured."
            : detached
              ? "Check out a branch first."
              : unborn
                ? "Make a first commit first."
                : busyReason,
      ),
    },
    {
      id: "fetch",
      label: "Fetch",
      hint: null,
      ...disable(unavailable ? overview.unavailableReason : noRemote ? "No remote configured." : null),
    },
    {
      id: "push",
      label: "Push...",
      hint: "Ctrl+Shift+K",
      ...disable(
        unavailable
          ? overview.unavailableReason
          : noRemote
            ? "No remote configured."
            : detached
              ? "Check out a branch first."
              : unborn
                ? "Make a first commit first."
                : busyReason,
      ),
    },
    {
      id: "new-branch",
      label: "New Branch...",
      hint: "Ctrl+Alt+N",
      ...disable(unavailable ? overview.unavailableReason : unborn ? "Make a first commit first." : busyReason),
    },
  ];
}

export type BranchMenuItemId = "checkout" | "new-branch-from" | "copy-name";

export interface BranchMenuItem {
  id: BranchMenuItemId;
  label: string;
  disabled: boolean;
  reason: string | null;
}

export function labelFor(id: BranchMenuItemId, branchName: string): string {
  switch (id) {
    case "checkout":
      return "Checkout";
    case "new-branch-from":
      return `New Branch from '${branchName}'...`;
    case "copy-name":
      return "Copy Branch Name";
  }
}

/** Milestone 1 context menu; later milestones extend this list. */
export function menuFor(
  branch: { kind: "local"; branch: LocalBranch } | { kind: "remote"; branch: RemoteBranch },
  overview: Overview,
): BranchMenuItem[] {
  const isCurrent = branch.kind === "local" && branch.branch.isCurrent;
  const busyReason =
    overview.operation !== "none"
      ? `A ${overview.operation} is in progress.`
      : overview.indexLocked
        ? "Another git process holds the index lock."
        : null;
  const checkoutReason = isCurrent
    ? "Already checked out."
    : branch.kind === "local" && branch.branch.worktreePath !== null
      ? `Checked out in another worktree (${branch.branch.worktreePath}).`
      : busyReason;
  return [
    {
      id: "checkout",
      label: labelFor("checkout", branch.branch.name),
      disabled: checkoutReason !== null,
      reason: checkoutReason,
    },
    {
      id: "new-branch-from",
      label: labelFor("new-branch-from", branch.branch.name),
      disabled: busyReason !== null,
      reason: busyReason,
    },
    { id: "copy-name", label: labelFor("copy-name", branch.branch.name), disabled: false, reason: null },
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
      return context.confirmBeforePush || plan.setUpstream ? "confirm" : "none";
    case "pull":
      return context.hasUncommittedChanges && !plan.autoStash ? "confirm" : "none";
    case "switch":
    case "switch-track":
    case "create":
    case "fetch":
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
