import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, Overview } from "./contracts";
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
} = {}) {
  const hostCalls: HostCall[] = [];
  const subscriptions: Subscription[] = [];
  const environment = options.environment === undefined ? READY_ENVIRONMENT : options.environment;
  const { bb, harness } = createFakePluginHost({
    pluginId: "vcs-group",
    settings: options.settings,
    sdk: {
      threads: {
        get: async () => ({ id: "t1", environmentId: environment?.id ?? null, environment }),
      },
      environments: {
        status: async () => ({ outcome: "available" }),
      },
      subscribe: ((args: Subscription) => {
        subscriptions.push(args);
        return () => {};
      }) as never,
    },
    experimental_callHostRpc: (call) => {
      hostCalls.push({ method: call.method, input: call.input, hostId: call.hostId });
      return options.hostResult ? options.hostResult(call) : defaultHostResult(call);
    },
  });
  return { bb, harness, hostCalls, subscriptions };
}

function defaultHostResult(call: HostCall): unknown {
  if (call.method === "overview") return overview();
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
    await harness.behavior.callRpc("push", { threadId: "t1", remote: null, setUpstream: true });
    await harness.behavior.callRpc("pull", { threadId: "t1", strategy: "ff-only", autoStash: false });
    expect(hostCalls.map((call) => [call.method, call.input])).toEqual([
      ["pull", { repoPath: "/repo", strategy: "rebase", autoStash: true }],
      ["fetch", { repoPath: "/repo", remote: null, prune: false }],
      ["push", { repoPath: "/repo", remote: "upstream", setUpstream: true }],
      ["pull", { repoPath: "/repo", strategy: "ff-only", autoStash: false }],
    ]);
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

  it("disposes timers and the subscription cleanly", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.callRpc("checkout", { threadId: "t1", target: { kind: "local", name: "main" } });
    await harness.lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.inspection.sdk.callsTo("environments.status")).toHaveLength(1);
  });
});
