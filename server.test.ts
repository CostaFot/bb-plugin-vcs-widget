import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, JobStart, Overview } from "./contracts";
import { unavailableOverview } from "./contracts";
import plugin from "./server";

const READY_ENVIRONMENT = {
  id: "env1",
  name: "repo",
  projectId: "p1",
  hostId: "h1",
  path: "/repo",
  managed: false,
  isGitRepo: true,
  isWorktree: false,
  workspaceProvisionType: "unmanaged",
  branchName: "main",
  baseBranch: null,
  defaultBranch: "main",
  mergeBaseBranch: null,
  status: "ready",
  createdAt: 0,
  updatedAt: 0,
};

function overview(extra: Partial<Overview> = {}): Overview {
  return {
    ...unavailableOverview(""),
    unavailableReason: null,
    repoRoot: "/repo",
    repoName: "repo",
    gitVersion: "2.55.0",
    head: { kind: "branch", name: "main", sha: "abc1234" },
    remotes: ["origin"],
    local: [
      {
        name: "main",
        sha: "abc1234",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        gone: false,
        isCurrent: true,
        worktreePath: null,
        committedAt: 1,
        subject: "first",
      },
    ],
    ...extra,
  };
}

interface HostCall {
  method: string;
  input: unknown;
  hostId: string;
}

type Subscription = { event: string; callback: (event: unknown) => void };

function setup(options: {
  environment?: Record<string, unknown> | null;
  hostResult?: (call: HostCall) => unknown;
  settings?: Record<string, string | number | boolean>;
  send?: (args: unknown) => unknown;
} = {}) {
  const hostCalls: HostCall[] = [];
  const subscriptions: Subscription[] = [];
  const sends: unknown[] = [];
  const released = { count: 0 };
  const environment = options.environment === undefined ? READY_ENVIRONMENT : options.environment;
  const { bb, harness } = createFakePluginHost({
    pluginId: "vcs-widget",
    settings: options.settings,
    sdk: {
      threads: {
        get: async () => ({ id: "t1", environmentId: environment?.id ?? null, environment }),
        send: async (args: unknown) => {
          sends.push(args);
          return options.send ? options.send(args) : { ok: true, delivery: "sent" };
        },
      },
      environments: {
        status: async () => ({ outcome: "available" }),
      },
      subscribe: ((args: Subscription) => {
        subscriptions.push(args);
        return () => {
          released.count += 1;
        };
      }) as never,
    },
    experimental_callHostRpc: (call) => {
      hostCalls.push({ method: call.method, input: call.input, hostId: call.hostId });
      return options.hostResult ? options.hostResult(call) : defaultHostResult(call);
    },
  });
  return { bb, harness, hostCalls, subscriptions, sends, released };
}

const JOB_METHODS = new Set(["fetch", "pull", "push", "updateBranch", "deleteRemoteBranch", "commit"]);

function defaultHostResult(call: HostCall): unknown {
  if (call.method === "overview") return overview();
  if (JOB_METHODS.has(call.method)) {
    const start: JobStart = { ok: true, jobId: `job-${call.method}`, kind: call.method as JobStart extends { kind: infer K } ? K : never, command: `git ${call.method}`, startedAt: 1 };
    return start;
  }
  if (call.method === "jobGet") return null;
  if (call.method === "jobCancel") return { cancelled: true };
  if (call.method === "listTags") return { ok: true, tags: [], truncated: false };
  if (call.method === "changes") return { ok: true, head: { kind: "branch", name: "main", sha: "abc1234" }, operation: "none", indexLocked: false, files: [{ path: "a.txt", oldPath: null, index: ".", worktree: "M", kind: "tracked" }], truncated: false, lastCommit: null };
  if (call.method === "diffFile") return { ok: true, path: "a.txt", side: "worktree", patch: "", truncated: false, binary: false, contents: null };
  if (call.method === "log") return { ok: true, commits: [{ sha: "abc1234def", shortSha: "abc1234", author: "Costa", committedAt: 1, subject: "a change", refs: [], parents: [] }], skip: 0, hasMore: false };
  if (call.method === "commitDetails") {
    return {
      ok: true,
      commit: { sha: "abc1234def", shortSha: "abc1234", author: "Costa", authorEmail: "c@example.com", authoredAt: 1, committer: "Costa", committerEmail: "c@example.com", committedAt: 1, subject: "a change", message: "a change", refs: [], parents: [] },
      files: [],
      truncated: false,
      againstParent: null,
    };
  }
  if (call.method === "commitPatch") return { ok: true, path: "a.txt", patch: "", truncated: false, binary: false, contents: null };
  if (call.method === "compare") return { ok: true, base: "main", target: "feature", aheadCount: 0, behindCount: 0, ahead: [], behind: [], files: [], truncated: { ahead: false, behind: false, files: false } };
  const result: ActionResult = { ok: true, message: `${call.method} done`, overview: overview() };
  return result;
}

describe("server", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards overview to the host that owns the environment", async () => {
    const { bb, harness, hostCalls } = setup();
    await plugin(bb);
    const result = (await harness.behavior.callRpc("overview", { threadId: "t1" })) as Overview;
    expect(result.head).toEqual({ kind: "branch", name: "main", sha: "abc1234" });
    expect(hostCalls).toEqual([
      { method: "overview", input: { repoPath: "/repo", recentLimit: 8 }, hostId: "h1" },
    ]);
  });

  it("reports an environment that is not ready without calling the host", async () => {
    const { bb, harness, hostCalls } = setup({
      environment: { ...READY_ENVIRONMENT, status: "provisioning" },
    });
    await plugin(bb);
    const result = (await harness.behavior.callRpc("overview", { threadId: "t1" })) as Overview;
    expect(result.unavailableReason).toBe("The thread environment is provisioning.");
    const action = (await harness.behavior.callRpc("checkout", {
      threadId: "t1",
      target: { kind: "local", name: "main" },
    })) as ActionResult;
    expect(action).toMatchObject({ ok: false, error: { code: "not_a_repo" } });
    expect(hostCalls).toEqual([]);
  });

  it("reports a thread without an environment", async () => {
    const { bb, harness } = setup({ environment: null });
    await plugin(bb);
    const result = (await harness.behavior.callRpc("overview", { threadId: "t1" })) as Overview;
    expect(result.unavailableReason).toBe("This thread has no project environment.");
  });

  it("nudges bb's status twice and publishes a change after a successful mutation", async () => {
    const { bb, harness, hostCalls } = setup();
    await plugin(bb);
    const result = (await harness.behavior.callRpc("checkout", {
      threadId: "t1",
      target: { kind: "remote", remote: "origin", branch: "feature" },
    })) as ActionResult;
    expect(result.ok).toBe(true);
    expect(hostCalls[0]).toEqual({
      method: "checkout",
      input: { repoPath: "/repo", target: { kind: "remote", remote: "origin", branch: "feature" } },
      hostId: "h1",
    });
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("environments.status")[0]).toEqual([{ environmentId: "env1" }]);
    expect(harness.realtimeSignals).toContainEqual({
      channel: "changed",
      payload: { environmentId: "env1", reason: "checkout" },
    });
    await vi.advanceTimersByTimeAsync(3_300);
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(2);
    expect(harness.realtimeSignals).toContainEqual({
      channel: "changed",
      payload: { environmentId: "env1", reason: "checkout:settled" },
    });
  });

  it("passes a typed failure through and skips the status nudge", async () => {
    const failure: ActionResult = {
      ok: false,
      error: { code: "dirty_worktree", message: "Checkout failed: local changes", hint: "Commit first." },
      overview: overview(),
    };
    const { bb, harness } = setup({ hostResult: () => failure });
    await plugin(bb);
    const result = await harness.behavior.callRpc("checkout", {
      threadId: "t1",
      target: { kind: "local", name: "main" },
    });
    expect(result).toEqual(failure);
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(0);
    expect(harness.realtimeSignals).toContainEqual({
      channel: "changed",
      payload: { environmentId: "env1", reason: "checkout:failed" },
    });
  });

  it("fills pull, fetch and push defaults from settings", async () => {
    const { bb, harness, hostCalls } = setup({
      settings: { updateStrategy: "rebase", autoStash: true, defaultRemote: "upstream", fetchPrune: false },
    });
    await plugin(bb);
    await harness.behavior.callRpc("pull", { threadId: "t1", strategy: null, autoStash: null });
    await harness.behavior.callRpc("fetch", { threadId: "t1", remote: null, prune: null });
    await harness.behavior.callRpc("push", { threadId: "t1", remote: null, setUpstream: true, expectedBranch: "main" });
    await harness.behavior.callRpc("push", { threadId: "t1", remote: "mirror", setUpstream: false, expectedBranch: "main" });
    await harness.behavior.callRpc("pull", { threadId: "t1", strategy: "ff-only", autoStash: false });
    const push = { source: "head", expectedSha: null, lease: null, timeoutMs: 600_000 };
    expect(hostCalls.map((call) => [call.method, call.input])).toEqual([
      ["pull", { repoPath: "/repo", strategy: "rebase", autoStash: true, timeoutMs: 600_000 }],
      ["fetch", { repoPath: "/repo", remote: null, prune: false, timeoutMs: 600_000 }],
      ["push", { repoPath: "/repo", remote: "upstream", setUpstream: true, expectedBranch: "main", ...push }],
      ["push", { repoPath: "/repo", remote: "mirror", setUpstream: false, expectedBranch: "main", ...push }],
      ["pull", { repoPath: "/repo", strategy: "ff-only", autoStash: false, timeoutMs: 600_000 }],
    ]);
  });

  it("turns a host transport failure into a typed result and still refreshes", async () => {
    const { bb, harness } = setup({
      hostResult: () => {
        throw new Error("host plugin call 1234 exceeded its deadline");
      },
    });
    await plugin(bb);
    const result = (await harness.behavior.callRpc("pull", { threadId: "t1", strategy: null, autoStash: null })) as ActionResult;
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" }, overview: null });
    if (!result.ok) {
      expect(result.error.message).toMatch(/did not report back/u);
      expect(result.error.hint).toMatch(/may still have completed/u);
    }
    // The pull may well have finished on the host: nudge bb and tell open popups.
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(1);
    expect(harness.realtimeSignals).toContainEqual({
      channel: "changed",
      payload: { environmentId: "env1", reason: "pull:unknown" },
    });
    const offline = setup({
      hostResult: () => {
        throw new Error("host h1 is offline");
      },
    });
    await plugin(offline.bb);
    const other = (await offline.harness.behavior.callRpc("fetch", { threadId: "t1", remote: null, prune: null })) as ActionResult;
    expect(other).toMatchObject({ ok: false, error: { code: "git_failed" } });
  });

  it("tells open popups to refetch when the host worker exits unexpectedly", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.experimental_emitHostWorkerExit("h1");
    expect(harness.realtimeSignals).toContainEqual({
      channel: "changed",
      payload: { hostId: "h1", reason: "worker-exit" },
    });
  });

  it("republishes bb's git change events on the plugin channel", async () => {
    const { bb, harness, subscriptions } = setup();
    await plugin(bb);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.event).toBe("environment:changed");
    subscriptions[0]?.callback({ type: "changed", entity: "environment", id: "env9", changes: ["git-refs-changed"] });
    subscriptions[0]?.callback({ type: "changed", entity: "environment", id: "env8", changes: ["metadata-changed"] });
    subscriptions[0]?.callback({ type: "changed", entity: "environment", changes: ["git-refs-changed"] });
    expect(harness.realtimeSignals).toEqual([
      { channel: "changed", payload: { environmentId: "env9", reason: "environment-changed" } },
    ]);
  });

  it("clamps the job timeout setting and passes push fields through", async () => {
    const { bb, harness, hostCalls } = setup({ settings: { jobTimeoutSeconds: 5 } });
    await plugin(bb);
    await harness.behavior.callRpc("push", { threadId: "t1", remote: "origin", setUpstream: false, expectedBranch: "feat", source: "branch", expectedSha: "abc1234", lease: "def5678" });
    expect(hostCalls[0]?.input).toEqual({ repoPath: "/repo", remote: "origin", setUpstream: false, expectedBranch: "feat", source: "branch", expectedSha: "abc1234", lease: "def5678", timeoutMs: 30_000 });
    const long = setup({ settings: { jobTimeoutSeconds: 100 } });
    await plugin(long.bb);
    await long.harness.behavior.callRpc("fetch", { threadId: "t1", remote: null, prune: null });
    expect(long.hostCalls[0]?.input).toMatchObject({ timeoutMs: 100_000 });
  });

  it("relays job events to the app and refreshes when a job it started finishes", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const start = (await harness.behavior.callRpc("pull", { threadId: "t1", strategy: null, autoStash: null })) as JobStart;
    expect(start).toMatchObject({ ok: true, jobId: "job-pull", kind: "pull" });
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(0);
    await harness.behavior.experimental_emitHostSignal("h1", "jobEvent", { jobId: "job-pull", repoRoot: "/repo", event: { kind: "output", line: "Updating a..b" } });
    expect(harness.realtimeSignals).toContainEqual({
      channel: "job",
      payload: { environmentId: "env1", hostId: "h1", jobId: "job-pull", event: { kind: "output", line: "Updating a..b" } },
    });
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(0);
    const finished = { kind: "finished", result: { ok: true, message: "Update Project: Fast-forward.", overview: overview() } };
    await harness.behavior.experimental_emitHostSignal("h1", "jobEvent", { jobId: "job-pull", repoRoot: "/repo", event: finished });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { environmentId: "env1", reason: "pull" } });
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(1);
    // A failed job publishes a change without nudging.
    await harness.behavior.callRpc("fetch", { threadId: "t1", remote: null, prune: null });
    await harness.behavior.experimental_emitHostSignal("h1", "jobEvent", { jobId: "job-fetch", repoRoot: "/repo", event: { kind: "finished", result: { ok: false, error: { code: "network", message: "Fetch failed." }, overview: null } } });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { environmentId: "env1", reason: "fetch:failed" } });
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(1);
    // A job this server did not start still reaches the environments it has seen for that repository.
    await harness.behavior.callRpc("overview", { threadId: "t1" });
    await harness.behavior.experimental_emitHostSignal("h1", "jobEvent", { jobId: "elsewhere", repoRoot: "/repo", event: { kind: "started", command: "git push" } });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "job", payload: { environmentId: "env1", hostId: "h1", jobId: "elsewhere", event: { kind: "started", command: "git push" } } });
  });

  it("maps the host's watch signal to the environments that use the repository", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.experimental_emitHostSignal("h1", "changed", { repoRoot: "/repo", reason: "watch" });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { hostId: "h1", reason: "watch" } });
    await harness.behavior.callRpc("overview", { threadId: "t1" });
    await harness.behavior.experimental_emitHostSignal("h1", "changed", { repoRoot: "/repo", reason: "watch" });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { environmentId: "env1", reason: "watch" } });
    await harness.behavior.experimental_emitHostSignal("h2", "changed", { repoRoot: "/repo", reason: "watch" });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { hostId: "h2", reason: "watch" } });
  });

  it("forwards job polling and cancellation and the read methods", async () => {
    const { bb, harness, hostCalls } = setup();
    await plugin(bb);
    expect(await harness.behavior.callRpc("jobGet", { threadId: "t1", jobId: "j1" })).toBeNull();
    expect(await harness.behavior.callRpc("jobCancel", { threadId: "t1", jobId: "j1" })).toEqual({ cancelled: true });
    expect(await harness.behavior.callRpc("compare", { threadId: "t1", base: { kind: "local", name: "main" }, target: { kind: "local", name: "feature" } })).toMatchObject({ ok: true, aheadCount: 0 });
    expect(hostCalls.map((call) => [call.method, call.input])).toEqual([
      ["jobGet", { repoPath: "/repo", jobId: "j1" }],
      ["jobCancel", { repoPath: "/repo", jobId: "j1" }],
      ["compare", { repoPath: "/repo", base: { kind: "local", name: "main" }, target: { kind: "local", name: "feature" } }],
    ]);
    const broken = setup({
      hostResult: () => {
        throw new Error("host h1 is offline");
      },
    });
    await plugin(broken.bb);
    expect(await broken.harness.behavior.callRpc("listTags", { threadId: "t1" })).toMatchObject({ ok: false, error: { code: "git_failed" } });
    const unavailable = setup({ environment: null });
    await plugin(unavailable.bb);
    expect(await unavailable.harness.behavior.callRpc("jobGet", { threadId: "t1", jobId: "j1" })).toBeNull();
    expect(await unavailable.harness.behavior.callRpc("fetch", { threadId: "t1", remote: null, prune: null })).toMatchObject({ ok: false, error: { code: "not_a_repo" } });
  });

  it("forwards the commit panel: reads, index mutations with a change publish, and commit as a job", async () => {
    const { bb, harness, hostCalls } = setup({ settings: { jobTimeoutSeconds: 120 } });
    await plugin(bb);
    const changes = await harness.behavior.callRpc("changes", { threadId: "t1" });
    expect(changes).toMatchObject({ ok: true, files: [{ path: "a.txt" }] });
    await harness.behavior.callRpc("diffFile", { threadId: "t1", path: "a.txt", oldPath: null, side: "worktree" });
    const staged = (await harness.behavior.callRpc("stage", { threadId: "t1", paths: ["a.txt"] })) as ActionResult;
    expect(staged.ok).toBe(true);
    expect(harness.realtimeSignals).toContainEqual({ channel: "changed", payload: { environmentId: "env1", reason: "stage" } });
    await harness.behavior.callRpc("unstage", { threadId: "t1", paths: ["a.txt"] });
    await harness.behavior.callRpc("discard", { threadId: "t1", restore: ["a.txt"], remove: [], clean: ["junk"] });
    const started = (await harness.behavior.callRpc("commit", { threadId: "t1", message: "Subject\n\nBody", amend: false, signoff: true, noVerify: false })) as JobStart;
    expect(started).toMatchObject({ ok: true, kind: "commit" });
    expect(hostCalls.map((call) => call.method)).toEqual(["changes", "diffFile", "stage", "unstage", "discard", "commit"]);
    expect(hostCalls[1]?.input).toEqual({ repoPath: "/repo", path: "a.txt", oldPath: null, side: "worktree" });
    expect(hostCalls[2]?.input).toEqual({ repoPath: "/repo", paths: ["a.txt"] });
    expect(hostCalls[4]?.input).toEqual({ repoPath: "/repo", restore: ["a.txt"], remove: [], clean: ["junk"] });
    expect(hostCalls[5]?.input).toEqual({ repoPath: "/repo", message: "Subject\n\nBody", amend: false, signoff: true, noVerify: false, timeoutMs: 120_000 });
    await expect(harness.behavior.callRpc("commit", { threadId: "t1", message: "   ", amend: false, signoff: false, noVerify: false })).rejects.toThrow();
    await expect(harness.behavior.callRpc("stage", { threadId: "t1", paths: ["/etc/passwd"] })).rejects.toThrow();
  });

  it("forwards the log panel: reads, and its mutations with a change publish", async () => {
    const { bb, harness, hostCalls } = setup();
    await plugin(bb);
    const page = await harness.behavior.callRpc("log", { threadId: "t1", filter: { kind: "all" }, grep: null, skip: 0 });
    expect(page).toMatchObject({ ok: true, hasMore: false });
    await harness.behavior.callRpc("commitDetails", { threadId: "t1", sha: "abc1234def" });
    await harness.behavior.callRpc("commitPatch", { threadId: "t1", sha: "abc1234def", path: "a.txt", oldPath: null });
    const picked = (await harness.behavior.callRpc("cherryPick", { threadId: "t1", sha: "abc1234def" })) as ActionResult;
    expect(picked.ok).toBe(true);
    expect(harness.realtimeSignals).toContainEqual({ channel: "changed", payload: { environmentId: "env1", reason: "cherryPick" } });
    await harness.behavior.callRpc("revert", { threadId: "t1", sha: "abc1234def" });
    await harness.behavior.callRpc("resetTo", { threadId: "t1", sha: "abc1234def", mode: "hard" });
    expect(hostCalls.map((call) => [call.method, call.input])).toEqual([
      ["log", { repoPath: "/repo", filter: { kind: "all" }, grep: null, skip: 0 }],
      ["commitDetails", { repoPath: "/repo", sha: "abc1234def" }],
      ["commitPatch", { repoPath: "/repo", sha: "abc1234def", path: "a.txt", oldPath: null }],
      ["cherryPick", { repoPath: "/repo", sha: "abc1234def" }],
      ["revert", { repoPath: "/repo", sha: "abc1234def" }],
      ["resetTo", { repoPath: "/repo", sha: "abc1234def", mode: "hard" }],
    ]);
    // The boundary refuses what git would have to interpret.
    await expect(harness.behavior.callRpc("cherryPick", { threadId: "t1", sha: "HEAD~1" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("resetTo", { threadId: "t1", sha: "abc1234def", mode: "keep" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("log", { threadId: "t1", filter: { kind: "ref", ref: { kind: "local", name: "-x" } }, grep: null, skip: 0 })).rejects.toThrow();
    await expect(harness.behavior.callRpc("log", { threadId: "t1", filter: { kind: "all" }, grep: "a\u0000b", skip: 0 })).rejects.toThrow();
  });

  it("keeps favourites per host and repository in kv and tells other panes", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    expect(await harness.behavior.callRpc("favourites", { threadId: "t1" })).toEqual({ names: [] });
    await harness.behavior.callRpc("overview", { threadId: "t1" });
    expect(await harness.behavior.callRpc("setFavourite", { threadId: "t1", name: "local:feature", favourite: true })).toEqual({ names: ["local:feature"] });
    expect(await harness.behavior.callRpc("setFavourite", { threadId: "t1", name: "remote:origin/main", favourite: true })).toEqual({ names: ["local:feature", "remote:origin/main"] });
    expect(await harness.behavior.callRpc("setFavourite", { threadId: "t1", name: "local:feature", favourite: true })).toEqual({ names: ["local:feature", "remote:origin/main"] });
    expect(await bb.storage.kv.get("fav:h1:/repo")).toEqual(["local:feature", "remote:origin/main"]);
    expect(await harness.behavior.callRpc("setFavourite", { threadId: "t1", name: "local:feature", favourite: false })).toEqual({ names: ["remote:origin/main"] });
    expect(await harness.behavior.callRpc("favourites", { threadId: "t1" })).toEqual({ names: ["remote:origin/main"] });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { environmentId: "env1", reason: "favourites" } });
  });

  it("lists every stored favourites list for the settings page and clears one", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await bb.storage.kv.set("fav:h1:/repo", ["local:main"]);
    await bb.storage.kv.set("fav:h2:/other/work tree", ["remote:origin/x"]);
    // An emptied list and a key from something else are not repositories.
    await bb.storage.kv.set("fav:h3:/gone", []);
    await bb.storage.kv.set("panel:h1", ["not a favourite"]);

    expect(await harness.behavior.callRpc("favouriteRepos", {})).toEqual({
      repos: [
        { hostId: "h2", repoRoot: "/other/work tree", names: ["remote:origin/x"] },
        { hostId: "h1", repoRoot: "/repo", names: ["local:main"] },
      ],
    });

    expect(await harness.behavior.callRpc("clearFavourites", { hostId: "h1", repoRoot: "/repo" })).toEqual({
      repos: [{ hostId: "h2", repoRoot: "/other/work tree", names: ["remote:origin/x"] }],
    });
    expect(await bb.storage.kv.get("fav:h1:/repo")).toBeUndefined();
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { hostId: "h1", reason: "favourites" } });
  });

  it("fails the jobs it started when the host worker exits", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.callRpc("push", { threadId: "t1", remote: null, setUpstream: true, expectedBranch: "main" });
    await harness.behavior.experimental_emitHostWorkerExit("h1");
    expect(harness.realtimeSignals.at(-2)).toMatchObject({
      channel: "job",
      payload: { environmentId: "env1", jobId: "job-push", event: { kind: "finished", result: { ok: false, error: { code: "git_failed" } } } },
    });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "changed", payload: { hostId: "h1", reason: "worker-exit" } });
  });

  it("registers a read-only CLI whose commands only read", async () => {
    const { bb, harness, hostCalls } = setup();
    await plugin(bb);
    expect(harness.registrations.cli?.name).toBe("vcs-widget");
    expect(harness.registrations.cli?.commands.map((command) => command.name)).toEqual(["status", "branches", "log"]);

    const status = await harness.behavior.runCli(["status"], { threadId: "t1" });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Repository: repo (/repo)");

    const log = await harness.behavior.runCli(["log", "--limit", "1", "--json"], { threadId: "t1" });
    expect(JSON.parse(log.stdout)).toMatchObject({ commits: [{ shortSha: "abc1234" }] });

    expect(hostCalls.map((call) => call.method)).toEqual(["overview", "log"]);
  });

  it("takes the thread from --thread when the CLI was not called on one", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    expect((await harness.behavior.runCli(["status"], {})).exitCode).toBe(2);
    expect((await harness.behavior.runCli(["status", "--thread", "t1"], {})).exitCode).toBe(0);
  });

  it("reports a thread without a repository as an exit code, not a crash", async () => {
    const { bb, harness, hostCalls } = setup({ environment: null });
    await plugin(bb);
    const result = await harness.behavior.runCli(["branches"], { threadId: "t1" });
    expect(result).toMatchObject({ exitCode: 1, stderr: "This thread has no project environment.\n" });
    expect(hostCalls).toEqual([]);
  });

  it("answers the agent tool from the same reads and never mutates", async () => {
    const { bb, harness, hostCalls } = setup();
    await plugin(bb);
    const tool = harness.registrations.agentTools.find((entry) => entry.name === "vcs_widget_status");
    expect(tool).toBeDefined();
    expect(tool?.instructions).toContain("cannot change git state");

    const status = await harness.behavior.callAgentTool("vcs_widget_status", {}, { threadId: "t1" });
    expect(status).toMatchObject({ isError: false });
    expect(JSON.stringify(status)).toContain("Repository: repo (/repo)");

    const branches = await harness.behavior.callAgentTool("vcs_widget_status", { section: "branches" }, { threadId: "t1" });
    expect(JSON.stringify(branches)).toContain("Local branches (1)");

    expect(hostCalls.map((call) => call.method)).toEqual(["overview", "overview"]);
  });

  it("turns a branch name git would refuse into a tool error, not a git call", async () => {
    const { bb, harness, hostCalls } = setup();
    await plugin(bb);
    const result = await harness.behavior.callAgentTool(
      "vcs_widget_status",
      { section: "log", branch: "bad name" },
      { threadId: "t1" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("not a valid git branch name");
    expect(hostCalls).toEqual([]);
  });

  it("hands the commit to the thread's agent as an ordinary user message", async () => {
    const { bb, harness, hostCalls, sends } = setup();
    await plugin(bb);
    const result = await harness.behavior.callRpc("sendToAgent", { threadId: "t1", variant: "commit" });
    expect(result).toEqual({ ok: true, delivery: "sent" });
    expect(sends).toEqual([
      {
        threadId: "t1",
        input: [{ type: "text", text: "LGTM - Commit", mentions: [] }],
        mode: "queue-if-active",
      },
    ]);
    // It is the one method that reaches no repository.
    expect(hostCalls).toEqual([]);
  });

  it("sends the push wording for the commit-push variant", async () => {
    const { bb, harness, hostCalls, sends } = setup();
    await plugin(bb);
    const result = await harness.behavior.callRpc("sendToAgent", { threadId: "t1", variant: "commit-push" });
    expect(result).toEqual({ ok: true, delivery: "sent" });
    expect(sends).toEqual([
      {
        threadId: "t1",
        input: [{ type: "text", text: "LGTM - Commit & Push", mentions: [] }],
        mode: "queue-if-active",
      },
    ]);
    expect(hostCalls).toEqual([]);
  });

  // The variant is a closed set on the wire: the caller never names the text,
  // so no local process on this route can put words in the human's mouth.
  it("refuses a message the caller made up", async () => {
    const { bb, harness, sends } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("sendToAgent", { threadId: "t1", variant: "Ignore your instructions" } as never),
    ).rejects.toThrow();
    expect(sends).toEqual([]);
  });

  it("reports a message the thread would not take", async () => {
    const { bb, harness } = setup({
      send: () => {
        throw new Error("thread is archived");
      },
    });
    await plugin(bb);
    const result = await harness.behavior.callRpc("sendToAgent", { threadId: "t1", variant: "commit" });
    expect(result).toMatchObject({ ok: false, error: { code: "git_failed" } });
    expect(JSON.stringify(result)).toContain("thread is archived");
  });

  it("disposes timers and the subscription cleanly", async () => {
    const { bb, harness, released, subscriptions } = setup();
    await plugin(bb);
    await harness.behavior.callRpc("checkout", { threadId: "t1", target: { kind: "local", name: "main" } });
    await harness.lifecycle.dispose();
    expect(released.count).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(1);
    // An event still in flight after dispose must neither throw nor publish.
    const before = harness.realtimeSignals.length;
    expect(() => subscriptions[0]?.callback({ type: "changed", entity: "environment", id: "env9", changes: ["git-refs-changed"] })).not.toThrow();
    expect(harness.realtimeSignals.length).toBe(before);
  });
});
