import { describe, expect, it } from "vitest";
import type { LocalBranch, Overview, RemoteBranch } from "../contracts";
import { unavailableOverview } from "../contracts";
import {
  blockingReason,
  confirmTierFor,
  entryKey,
  filterAndRank,
  fullRef,
  gitArgvFor,
  gitCommandPreview,
  gitCommandsPreview,
  groupBranches,
  headLabel,
  matchScore,
  menuFor,
  pushIntentFor,
  quickActionsFor,
  trackedOptionsFor,
  withLease,
  worktreePathFor,
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
    [{ op: "switch-track", remote: "origin", branch: "feature" }, "git switch -c feature --track --end-of-options refs/remotes/origin/feature"],
    [{ op: "create", name: "x", startPoint: null, checkout: true }, "git switch -c x --end-of-options"],
    [{ op: "create", name: "x", startPoint: "main", checkout: false }, "git branch --end-of-options x main"],
    [{ op: "fetch", remote: "origin", prune: true }, "git fetch --no-progress --prune --end-of-options origin"],
    [{ op: "fetch", remote: null, prune: false }, "git fetch --no-progress --all"],
    [{ op: "pull", strategy: "ff-only", autoStash: false }, "git pull --no-progress --no-edit --ff-only"],
    [{ op: "pull", strategy: "rebase", autoStash: true }, "git pull --no-progress --no-edit --rebase --autostash"],
    [{ op: "pull", strategy: "merge", autoStash: false }, "git pull --no-progress --no-edit --no-rebase"],
    [{ op: "push", remote: "origin", branch: null, setUpstream: true }, "git push --no-progress -u --end-of-options origin HEAD"],
    [{ op: "push", remote: "origin", branch: null, setUpstream: false, upstreamBranch: "main", lease: null }, "git push --no-progress --end-of-options origin HEAD:refs/heads/main"],
    [{ op: "push", remote: "org/mirror", branch: null, setUpstream: false, upstreamBranch: "release/1.x", lease: null }, "git push --no-progress --end-of-options org/mirror HEAD:refs/heads/release/1.x"],
    [{ op: "push", remote: "origin", branch: "feat", setUpstream: true }, "git push --no-progress -u --end-of-options origin refs/heads/feat:refs/heads/feat"],
    [{ op: "push", remote: "origin", branch: "feat", setUpstream: false, upstreamBranch: "feat", lease: null }, "git push --no-progress --end-of-options origin refs/heads/feat:refs/heads/feat"],
    [{ op: "push", remote: "origin", branch: null, setUpstream: false, upstreamBranch: "main", lease: "abc1234" }, "git push --no-progress --force-with-lease=refs/heads/main:abc1234 --end-of-options origin HEAD:refs/heads/main"],
    [{ op: "switch-detach", revision: "v1.0" }, "git switch --detach --end-of-options v1.0"],
    [{ op: "fetch-branch", remote: "origin", upstreamBranch: "main", branch: "main" }, "git fetch --no-progress --end-of-options origin refs/heads/main:refs/heads/main"],
    [{ op: "delete-local", name: "old", force: false }, "git branch -d --end-of-options old"],
    [{ op: "delete-local", name: "old", force: true }, "git branch -D --end-of-options old"],
    [{ op: "delete-remote", remote: "origin", branch: "old" }, "git push --no-progress --delete --end-of-options origin refs/heads/old"],
    [{ op: "rename", from: "a", to: "b" }, "git branch -m --end-of-options a b"],
    [{ op: "merge", ref: "refs/heads/feature" }, "git merge --no-edit --end-of-options refs/heads/feature"],
    [{ op: "rebase", onto: "refs/remotes/origin/main" }, "git rebase --end-of-options refs/remotes/origin/main"],
    [{ op: "abort", operation: "rebase" }, "git rebase --abort"],
    [{ op: "abort", operation: "cherry-pick" }, "git cherry-pick --abort"],
    [{ op: "set-upstream", branch: "feat", upstream: "origin/feat" }, "git branch --set-upstream-to=origin/feat --end-of-options feat"],
    [{ op: "set-upstream", branch: "feat", upstream: null }, "git branch --unset-upstream --end-of-options feat"],
    [{ op: "worktree-add", path: "/w/repo-feat", branch: "feat" }, "git worktree add --end-of-options /w/repo-feat feat"],
    [{ op: "worktree-add-track", path: "/w/repo-feat", remote: "origin", branch: "feat" }, "git worktree add --track -b feat --end-of-options /w/repo-feat refs/remotes/origin/feat"],
  ] as const)("%j", (plan, preview) => {
    expect(gitCommandPreview(plan)).toBe(preview);
    expect(gitArgvFor(plan).join(" ")).toBe(preview.slice("git ".length));
  });

  it("quotes unusual arguments for display only", () => {
    expect(gitCommandPreview({ op: "create", name: "feat/it's", startPoint: null, checkout: false })).toBe(
      "git branch --end-of-options 'feat/it'\\''s'",
    );
  });

  it("previews a sequence one command per line", () => {
    expect(gitCommandsPreview([{ op: "switch", name: "x" }, { op: "rebase", onto: "refs/heads/main" }])).toBe(
      "git switch --no-guess --end-of-options x\ngit rebase --end-of-options refs/heads/main",
    );
  });

  it("names full refs for popup entries", () => {
    expect(fullRef({ kind: "local", name: "x" })).toBe("refs/heads/x");
    expect(fullRef({ kind: "remote", remote: "origin", branch: "x/y" })).toBe("refs/remotes/origin/x/y");
  });
});

describe("worktreePathFor", () => {
  it("builds a sibling directory from the repo name and the branch", () => {
    expect(worktreePathFor("/home/me/work/repo", "feat/ui")).toBe("/home/me/work/repo-feat-ui");
    expect(worktreePathFor("/repo/", "a b")).toBe("/repo-a-b");
    expect(worktreePathFor("/r", "x")).toBe("/r-x");
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
    expect(groups.favourites).toEqual([]);
  });

  it("lists favourites in list order, local before remote, by their stable key", () => {
    const groups = groupBranches(overview(), new Set(["remote:origin/feature", "local:old", "local:missing"]));
    expect(groups.favourites.map(entryKey)).toEqual(["local:old", "remote:origin/feature"]);
  });
});

describe("quickActionsFor", () => {
  it("enables everything on a healthy repo", () => {
    expect(quickActionsFor(overview()).map((action) => [action.id, action.disabled])).toEqual([
      ["update", false],
      ["fetch", false],
      ["push", false],
      ["new-branch", false],
      ["checkout-revision", false],
    ]);
  });
  it("names the blocking state: job, operation, lock, old git", () => {
    expect(blockingReason(overview())).toBeNull();
    expect(blockingReason(overview({ activeJob: { jobId: "j1", kind: "pull", command: "git pull", startedAt: 1 } }))).toBe("An update is running.");
    expect(blockingReason(overview({ operation: "rebase" }))).toBe("A rebase is in progress.");
    expect(blockingReason(overview({ indexLocked: true }))).toMatch(/index lock/u);
    expect(blockingReason(overview({ gitVersion: "2.20.1" }))).toMatch(/too old/u);
    expect(blockingReason(overview({ gitVersion: null }))).toBeNull();
    expect(quickActionsFor(overview({ activeJob: { jobId: "j1", kind: "fetch", command: "git fetch", startedAt: 1 } })).find((action) => action.id === "fetch")?.reason).toBe("A fetch is running.");
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
      "Checkout and Rebase onto 'main'",
      "Compare with 'main'",
      "Show Diff with Working Tree",
      "Rebase 'main' onto 'origin/feature'",
      "Merge 'origin/feature' into 'main'",
      "New Worktree from 'origin/feature'...",
      "Delete",
      "Add to Favorites",
      "Copy Branch Name",
    ]);
  });

  it("lists the IntelliJ rows for another local branch and disables what needs an upstream", () => {
    const view = overview();
    const items = menuFor({ kind: "local", branch: local("feature") }, view, { favourite: true });
    expect(items.map((item) => item.id)).toEqual([
      "checkout",
      "new-branch-from",
      "checkout-rebase",
      "checkout-update",
      "compare",
      "diff-working-tree",
      "rebase",
      "merge",
      "new-worktree",
      "update",
      "push",
      "tracked-branch",
      "rename",
      "delete",
      "favourite",
      "copy-name",
    ]);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("checkout-update")?.reason).toBe("No upstream branch.");
    expect(byId.get("update")?.reason).toBe("No upstream branch.");
    expect(byId.get("push")?.disabled).toBe(false);
    expect(byId.get("rename")?.hint).toBe("F2");
    expect(byId.get("favourite")?.label).toBe("Remove from Favorites");
    expect(byId.get("compare")?.separatorBefore).toBe(true);
    expect(byId.get("tracked-branch")?.children?.map((child) => [child.label, child.checked])).toEqual([
      ["origin/feature", false],
      ["origin/main", false],
      ["None", true],
    ]);
    const tracked = menuFor({ kind: "local", branch: local("feature", { upstream: "origin/feature" }) }, view);
    expect(tracked.find((item) => item.id === "update")?.disabled).toBe(false);
    expect(tracked.find((item) => item.id === "tracked-branch")?.children?.[0]?.checked).toBe(true);
    const gone = menuFor({ kind: "local", branch: local("feature", { upstream: "origin/feature", gone: true }) }, view);
    expect(gone.find((item) => item.id === "update")?.reason).toMatch(/gone/u);
  });

  it("keeps compare, rebase and merge off for the current branch and everything mutating off while blocked", () => {
    const current = menuFor({ kind: "local", branch: local("main", { isCurrent: true, upstream: "origin/main" }) }, overview());
    const byId = new Map(current.map((item) => [item.id, item]));
    expect(byId.get("compare")?.reason).toMatch(/itself/u);
    expect(byId.get("rebase")?.disabled).toBe(true);
    expect(byId.get("merge")?.disabled).toBe(true);
    expect(byId.get("delete")?.reason).toMatch(/current branch/u);
    expect(byId.get("diff-working-tree")?.disabled).toBe(false);
    expect(byId.get("update")?.disabled).toBe(false);
    const blocked = menuFor({ kind: "local", branch: local("feature") }, overview({ operation: "merge" }));
    const enabled = blocked.filter((item) => !item.disabled).map((item) => item.id);
    expect(enabled).toEqual(["compare", "diff-working-tree", "favourite", "copy-name"]);
    const detached = menuFor({ kind: "remote", branch: remote("origin/feature") }, overview({ head: { kind: "detached", sha: "abc1234def" } }));
    expect(detached.find((item) => item.id === "merge")?.reason).toBe("Check out a branch first.");
    expect(detached.find((item) => item.id === "checkout")?.disabled).toBe(false);
  });

  it("orders tracked options with same-named remote branches first", () => {
    const view = overview({ remote: [remote("origin/main"), remote("origin/feature"), remote("mirror/feature")] });
    expect(trackedOptionsFor(local("feature"), view).map((option) => option.label)).toEqual(["mirror/feature", "origin/feature", "origin/main", "None"]);
  });
});

describe("confirmTierFor", () => {
  it("confirms pushes per setting and dirty pulls without autostash", () => {
    const tracked = { op: "push", remote: "origin", branch: null, setUpstream: false, upstreamBranch: "main", lease: null } as const;
    expect(confirmTierFor(tracked, { hasUncommittedChanges: false, confirmBeforePush: true })).toBe("confirm");
    expect(confirmTierFor(tracked, { hasUncommittedChanges: false, confirmBeforePush: false })).toBe("none");
    expect(confirmTierFor({ ...tracked, lease: "abc1234" }, { hasUncommittedChanges: false, confirmBeforePush: false })).toBe("destructive");
    expect(confirmTierFor({ op: "push", remote: "origin", branch: null, setUpstream: true }, { hasUncommittedChanges: false, confirmBeforePush: false })).toBe("confirm");
    expect(confirmTierFor({ op: "pull", strategy: "ff-only", autoStash: false }, { hasUncommittedChanges: true, confirmBeforePush: true })).toBe("confirm");
    expect(confirmTierFor({ op: "pull", strategy: "ff-only", autoStash: true }, { hasUncommittedChanges: true, confirmBeforePush: true })).toBe("none");
    expect(confirmTierFor({ op: "switch", name: "x" }, { hasUncommittedChanges: true, confirmBeforePush: true })).toBe("none");
  });
  it("confirms history and remote changes, destructive for forced deletes", () => {
    const context = { hasUncommittedChanges: false, confirmBeforePush: false };
    expect(confirmTierFor({ op: "delete-local", name: "x", force: false }, context)).toBe("confirm");
    expect(confirmTierFor({ op: "delete-local", name: "x", force: true }, context)).toBe("destructive");
    expect(confirmTierFor({ op: "delete-remote", remote: "origin", branch: "x" }, context)).toBe("destructive");
    expect(confirmTierFor({ op: "merge", ref: "refs/heads/x" }, context)).toBe("confirm");
    expect(confirmTierFor({ op: "rebase", onto: "refs/heads/x" }, context)).toBe("confirm");
    expect(confirmTierFor({ op: "abort", operation: "merge" }, context)).toBe("confirm");
    expect(confirmTierFor({ op: "worktree-add", path: "/w", branch: "x" }, context)).toBe("confirm");
    expect(confirmTierFor({ op: "switch-detach", revision: "v1" }, context)).toBe("confirm");
    expect(confirmTierFor({ op: "rename", from: "a", to: "b" }, context)).toBe("none");
    expect(confirmTierFor({ op: "set-upstream", branch: "a", upstream: null }, context)).toBe("none");
    expect(confirmTierFor({ op: "fetch-branch", remote: "origin", upstreamBranch: "a", branch: "a" }, context)).toBe("none");
  });
});

describe("pushIntentFor", () => {
  const tracked = { name: "origin/main", remote: "origin", branch: "main", ahead: 0, behind: 0, gone: false };
  it("pushes to the tracked branch by explicit refspec", () => {
    expect(pushIntentFor(overview({ upstream: tracked }), "origin")).toEqual({
      plan: { op: "push", remote: "origin", branch: null, setUpstream: false, upstreamBranch: "main", lease: null },
      branch: "main",
      sha: "abc1234",
      target: "origin/main",
      remoteSha: "abc1234",
      reason: "tracked",
      upstreamName: "origin/main",
    });
  });
  it("pushes another local branch by its own ref and reads its upstream from the branch row", () => {
    const view = overview({ local: [local("main", { isCurrent: true }), local("feature", { upstream: "origin/feature", sha: "fff1234" })] });
    const intent = pushIntentFor(view, "origin", view.local[1]);
    expect(intent).toMatchObject({
      plan: { op: "push", remote: "origin", branch: "feature", setUpstream: false, upstreamBranch: "feature" },
      branch: "feature",
      sha: "fff1234",
      target: "origin/feature",
    });
    const fresh = pushIntentFor(view, "mirror", local("new-one"));
    expect(fresh?.plan).toEqual({ op: "push", remote: "mirror", branch: "new-one", setUpstream: true });
    // The current branch passed explicitly still pushes HEAD.
    expect(pushIntentFor(view, "origin", view.local[0])?.plan).toMatchObject({ branch: null });
  });
  it("adds a lease only to a tracked push", () => {
    const tracked = pushIntentFor(overview({ upstream: { name: "origin/main", remote: "origin", branch: "main", ahead: 1, behind: 1, gone: false } }), "origin");
    expect(withLease(tracked!.plan, tracked!.remoteSha)).toMatchObject({ lease: "abc1234" });
    const fresh = pushIntentFor(overview({ upstream: null }), "origin");
    expect(withLease(fresh!.plan, "abc1234")).toEqual(fresh!.plan);
  });
  it("uses the upstream's own remote and branch, not the default remote or the local name", () => {
    const intent = pushIntentFor(overview({ upstream: { ...tracked, name: "mirror/fix-123", remote: "mirror", branch: "fix-123" } }), "origin");
    expect(intent?.plan).toEqual({ op: "push", remote: "mirror", branch: null, setUpstream: false, upstreamBranch: "fix-123", lease: null });
    expect(intent?.target).toBe("mirror/fix-123");
  });
  it("creates and tracks <defaultRemote>/<branch> without, with a gone, or with a local upstream", () => {
    expect(pushIntentFor(overview({ upstream: null }), "origin")).toMatchObject({
      plan: { op: "push", remote: "origin", branch: null, setUpstream: true },
      target: "origin/main",
      reason: "no-upstream",
    });
    expect(pushIntentFor(overview({ upstream: { ...tracked, gone: true } }), "upstream")).toMatchObject({
      plan: { op: "push", remote: "upstream", branch: null, setUpstream: true },
      target: "upstream/main",
      reason: "gone",
    });
    expect(pushIntentFor(overview({ upstream: { ...tracked, name: "develop", remote: null, branch: null } }), "origin")).toMatchObject({
      reason: "local-upstream",
      plan: { setUpstream: true },
    });
  });
  it("has nothing to push when HEAD is detached or unborn", () => {
    expect(pushIntentFor(overview({ head: { kind: "detached", sha: "abc1234def" } }), "origin")).toBeNull();
    expect(pushIntentFor(overview({ head: { kind: "unborn", name: "main" } }), "origin")).toBeNull();
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
