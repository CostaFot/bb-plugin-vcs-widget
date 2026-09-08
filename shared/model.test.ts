import { describe, expect, it } from "vitest";
import type { LocalBranch, Overview, RemoteBranch } from "../contracts";
import { unavailableOverview } from "../contracts";
import {
  confirmTierFor,
  filterAndRank,
  gitArgvFor,
  gitCommandPreview,
  groupBranches,
  headLabel,
  matchScore,
  menuFor,
  quickActionsFor,
} from "./model";

function local(name: string, extra: Partial<LocalBranch> = {}): LocalBranch {
  return {
    name,
    sha: "abc1234",
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    isCurrent: false,
    worktreePath: null,
    committedAt: 0,
    subject: "",
    ...extra,
  };
}

function remote(name: string): RemoteBranch {
  const [remoteName, ...rest] = name.split("/");
  return {
    name,
    remote: remoteName ?? "origin",
    branch: rest.join("/"),
    sha: "abc1234",
    hasLocal: false,
    committedAt: 0,
    subject: "",
  };
}

function overview(extra: Partial<Overview> = {}): Overview {
  return {
    ...unavailableOverview(""),
    unavailableReason: null,
    repoRoot: "/repo",
    repoName: "repo",
    gitVersion: "2.55.0",
    head: { kind: "branch", name: "main", sha: "abc1234" },
    remotes: ["origin"],
    local: [local("main", { isCurrent: true }), local("feature"), local("old")],
    remote: [remote("origin/main"), remote("origin/feature")],
    recent: ["feature"],
    ...extra,
  };
}

describe("gitArgvFor / gitCommandPreview", () => {
  it.each([
    [{ op: "switch", name: "feature" }, "git switch --no-guess --end-of-options feature"],
    [{ op: "switch-track", remote: "origin", branch: "feature" }, "git switch -c feature --track --end-of-options origin/feature"],
    [{ op: "create", name: "x", startPoint: null, checkout: true }, "git switch -c x --end-of-options"],
    [{ op: "create", name: "x", startPoint: "main", checkout: false }, "git branch --end-of-options x main"],
    [{ op: "fetch", remote: "origin", prune: true }, "git fetch --no-progress --prune --end-of-options origin"],
    [{ op: "fetch", remote: null, prune: false }, "git fetch --no-progress --all"],
    [{ op: "pull", strategy: "ff-only", autoStash: false }, "git pull --no-progress --no-edit --ff-only"],
    [{ op: "pull", strategy: "rebase", autoStash: true }, "git pull --no-progress --no-edit --rebase --autostash"],
    [{ op: "pull", strategy: "merge", autoStash: false }, "git pull --no-progress --no-edit --no-rebase"],
    [{ op: "push", remote: "origin", setUpstream: true }, "git push --no-progress -u --end-of-options origin HEAD"],
    [{ op: "push", remote: "origin", setUpstream: false }, "git push --no-progress"],
  ] as const)("%j", (plan, preview) => {
    expect(gitCommandPreview(plan)).toBe(preview);
    expect(gitArgvFor(plan).join(" ")).toBe(preview.slice("git ".length));
  });

  it("quotes unusual arguments for display only", () => {
    expect(gitCommandPreview({ op: "create", name: "feat/it's", startPoint: null, checkout: false })).toBe(
      "git branch --end-of-options 'feat/it'\\''s'",
    );
  });
});

describe("matchScore / filterAndRank", () => {
  it("ranks exact, prefix, component prefix, substring, subsequence", () => {
    expect(matchScore("feature", "feature")).toBe(100);
    expect(matchScore("feature", "fea")).toBe(80);
    expect(matchScore("origin/feature", "fea")).toBe(60);
    expect(matchScore("my-feature", "feat")).toBe(40);
    expect(matchScore("fix/eat", "fea")).toBe(20);
    expect(matchScore("main", "zzz")).toBe(0);
    expect(matchScore("anything", "")).toBe(1);
  });

  it("keeps order for an empty query and sorts stably by score", () => {
    const items = [{ name: "main" }, { name: "feature" }, { name: "feat/ui" }, { name: "origin/feature" }];
    expect(filterAndRank(items, "").map((item) => item.name)).toEqual(["main", "feature", "feat/ui", "origin/feature"]);
    expect(filterAndRank(items, "fea").map((item) => item.name)).toEqual(["feature", "feat/ui", "origin/feature"]);
    expect(filterAndRank(items, "ui").map((item) => item.name)).toEqual(["feat/ui"]);
  });

  it("applies bonuses", () => {
    const items = [{ name: "feature-a" }, { name: "feature-b" }];
    expect(filterAndRank(items, "feature", (item) => (item.name === "feature-b" ? 10 : 0))[0]?.name).toBe("feature-b");
  });
});

describe("groupBranches", () => {
  it("puts the current branch first, sorts the rest, and resolves recent names", () => {
    const groups = groupBranches(overview({ local: [local("zeta"), local("main", { isCurrent: true }), local("alpha")], recent: ["zeta", "missing"] }));
    expect(groups.local.map((branch) => branch.name)).toEqual(["main", "alpha", "zeta"]);
    expect(groups.recent.map((branch) => branch.name)).toEqual(["zeta"]);
    expect(groups.remote.map((branch) => branch.name)).toEqual(["origin/feature", "origin/main"]);
  });
});

describe("quickActionsFor", () => {
  it("enables everything on a healthy repo", () => {
    expect(quickActionsFor(overview()).map((action) => [action.id, action.disabled])).toEqual([
      ["update", false],
      ["fetch", false],
      ["push", false],
      ["new-branch", false],
    ]);
  });
  it("disables network actions without a remote and branch actions when detached", () => {
    const noRemote = quickActionsFor(overview({ remotes: [] }));
    expect(noRemote.find((action) => action.id === "update")?.reason).toMatch(/No remote/u);
    expect(noRemote.find((action) => action.id === "new-branch")?.disabled).toBe(false);
    const detached = quickActionsFor(overview({ head: { kind: "detached", sha: "abc1234def" } }));
    expect(detached.find((action) => action.id === "push")?.reason).toMatch(/Check out a branch/u);
    expect(detached.find((action) => action.id === "fetch")?.disabled).toBe(false);
  });
  it("disables everything when unavailable", () => {
    const actions = quickActionsFor(unavailableOverview("No environment."));
    expect(actions.every((action) => action.disabled)).toBe(true);
  });
});

describe("menuFor", () => {
  it("disables checkout for the current branch and branches in other worktrees", () => {
    const view = overview();
    const current = menuFor({ kind: "local", branch: local("main", { isCurrent: true }) }, view);
    expect(current[0]).toMatchObject({ id: "checkout", disabled: true, reason: "Already checked out." });
    const elsewhere = menuFor({ kind: "local", branch: local("wt", { worktreePath: "/repo-wt" }) }, view);
    expect(elsewhere[0]?.reason).toMatch(/another worktree/u);
    const remoteItems = menuFor({ kind: "remote", branch: remote("origin/feature") }, view);
    expect(remoteItems.map((item) => item.label)).toEqual([
      "Checkout",
      "New Branch from 'origin/feature'...",
      "Copy Branch Name",
    ]);
  });
});

describe("confirmTierFor", () => {
  it("confirms pushes per setting and dirty pulls without autostash", () => {
    expect(confirmTierFor({ op: "push", remote: "origin", setUpstream: false }, { hasUncommittedChanges: false, confirmBeforePush: true })).toBe("confirm");
    expect(confirmTierFor({ op: "push", remote: "origin", setUpstream: false }, { hasUncommittedChanges: false, confirmBeforePush: false })).toBe("none");
    expect(confirmTierFor({ op: "push", remote: "origin", setUpstream: true }, { hasUncommittedChanges: false, confirmBeforePush: false })).toBe("confirm");
    expect(confirmTierFor({ op: "pull", strategy: "ff-only", autoStash: false }, { hasUncommittedChanges: true, confirmBeforePush: true })).toBe("confirm");
    expect(confirmTierFor({ op: "pull", strategy: "ff-only", autoStash: true }, { hasUncommittedChanges: true, confirmBeforePush: true })).toBe("none");
    expect(confirmTierFor({ op: "switch", name: "x" }, { hasUncommittedChanges: true, confirmBeforePush: true })).toBe("none");
  });
});

describe("headLabel", () => {
  it("prefers the overview head and falls back to the sidebar branch", () => {
    expect(headLabel(overview(), "stale")).toBe("main");
    expect(headLabel(overview({ head: { kind: "detached", sha: "abcdef0123456" } }), null)).toBe("abcdef0");
    expect(headLabel(overview({ head: { kind: "unborn", name: "main" } }), null)).toBe("main (no commits)");
    expect(headLabel(null, "sidebar")).toBe("sidebar");
    expect(headLabel(null, null)).toBe("No branch");
  });
});
