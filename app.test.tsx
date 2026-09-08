// @vitest-environment jsdom
import { loadPluginApp, renderSlot, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

afterEach(() => cleanup());
import type { ActionResult, Overview } from "./contracts";
import { unavailableOverview } from "./contracts";
import type { rpcContract } from "./server";

// jsdom lacks the layout APIs Radix and cmdk touch.
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

function overview(extra: Partial<Overview> = {}): Overview {
  const branch = (name: string, isCurrent = false) => ({
    name,
    sha: "abc1234",
    upstream: isCurrent ? "origin/main" : null,
    ahead: 0,
    behind: 0,
    gone: false,
    isCurrent,
    worktreePath: null,
    committedAt: 1,
    subject: "",
  });
  return {
    ...unavailableOverview(""),
    unavailableReason: null,
    repoRoot: "/repo",
    repoName: "repo",
    gitVersion: "2.55.0",
    head: { kind: "branch", name: "main", sha: "abc1234" },
    upstream: { name: "origin/main", ahead: 0, behind: 0 },
    remotes: ["origin"],
    local: [branch("main", true), branch("feature"), branch("release")],
    remote: [
      { name: "origin/main", remote: "origin", branch: "main", sha: "abc1234", hasLocal: true, committedAt: 1, subject: "" },
      { name: "origin/hotfix", remote: "origin", branch: "hotfix", sha: "abc1234", hasLocal: false, committedAt: 1, subject: "" },
    ],
    recent: ["feature"],
    ...extra,
  };
}

const sidebarThread = (environment: { id: string; branchName: string } | null) => ({
  status: "ready" as const,
  projects: [],
  threads: [
    {
      id: "t1",
      projectId: "p1",
      title: "Thread",
      titleFallback: null,
      parentThreadId: null,
      sectionId: null,
      originKind: null,
      originPluginId: null,
      providerId: "claude-code",
      hasPendingInteraction: false,
      activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
      indicator: "none" as const,
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      environment: environment
        ? { id: environment.id, name: "repo", branchName: environment.branchName, workspaceDisplayKind: "other" as const }
        : null,
      host: { id: "h1", name: "laptop" },
      createdAt: 0,
      updatedAt: 0,
      lastReadAt: null,
      latestAttentionAt: 0,
    },
  ],
});

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("./app"));
});

const props = { threadId: "t1", projectId: "p1", isCompactViewport: false };

function render(options: {
  overview?: Overview;
  checkout?: (input: unknown) => ActionResult;
  environment?: { id: string; branchName: string } | null;
  compact?: boolean;
} = {}) {
  const view = options.overview ?? overview();
  return renderSlot<typeof props, typeof rpcContract>(
    app.threadHeaderActions[0]!,
    { ...props, isCompactViewport: options.compact ?? false },
    {
      sidebarThreads: sidebarThread(options.environment === undefined ? { id: "env1", branchName: "main" } : options.environment),
      settings: { updateStrategy: "ff-only", autoStash: false, confirmBeforePush: true, defaultRemote: "origin", fetchPrune: true },
      rpc: {
        overview: () => view,
        checkout: (input) =>
          options.checkout?.(input) ?? {
            ok: true,
            message: `Switched to ${input.target.kind === "local" ? input.target.name : input.target.branch}.`,
            overview: view,
          },
        createBranch: () => ({ ok: true, message: "Created.", overview: view }),
        fetch: () => ({ ok: true, message: "Fetched.", overview: view }),
        pull: () => ({ ok: true, message: "Updated.", overview: view }),
        push: () => ({ ok: true, message: "Pushed.", overview: view }),
      },
    },
  );
}

describe("header registration", () => {
  it("registers one thread header action", () => {
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual(["branches"]);
  });
});

describe("BranchButton", () => {
  it("labels itself from the sidebar without calling the server", () => {
    const slot = render();
    const button = slot.getByTestId("vcs-branch-button");
    expect(button.textContent).toContain("main");
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("renders nothing for a thread without an environment", () => {
    const slot = render({ environment: null });
    expect(slot.queryByTestId("vcs-branch-button")).toBeNull();
  });

  it("collapses to an icon on compact viewports", () => {
    const slot = render({ compact: true });
    const button = slot.getByTestId("vcs-branch-button");
    expect(button.getAttribute("aria-label")).toMatch(/^Git branch: main/u);
    expect(button.textContent).toBe("");
  });

  it("opens the popup, lists branches, filters and checks out", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["overview"]));
    // "feature" is listed under Recent and Local.
    expect(await within(popup).findAllByText("feature")).toHaveLength(2);
    expect(within(popup).getByText("Recent")).toBeTruthy();
    expect(within(popup).getByText("Local")).toBeTruthy();
    expect(within(popup).getByText("Remote")).toBeTruthy();
    expect(within(popup).getByText("Update Project")).toBeTruthy();

    const input = within(popup).getByLabelText("Search for branches and actions");
    await user.type(input, "hot");
    await waitFor(() => expect(within(popup).queryByText("release")).toBeNull());
    expect(within(popup).getByText("origin/hotfix")).toBeTruthy();

    await user.click(within(popup).getByText("origin/hotfix"));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "checkout",
        input: { threadId: "t1", target: { kind: "remote", remote: "origin", branch: "hotfix" } },
      }),
    );
  });

  it("shows a typed failure in the status line and keeps the popup open", async () => {
    const user = userEvent.setup();
    const slot = render({
      checkout: () => ({
        ok: false,
        error: { code: "dirty_worktree", message: "Checkout failed: local changes would be overwritten.", hint: "Commit or stash your changes first." },
        overview: overview(),
      }),
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    const [featureRow] = await within(popup).findAllByText("feature");
    await user.click(featureRow!);
    await within(popup).findByText("Checkout failed: local changes would be overwritten.");
    expect(within(popup).getByText("Commit or stash your changes first.")).toBeTruthy();
    expect(screen.queryByTestId("vcs-branch-popup")).not.toBeNull();
  });

  it("refetches on a realtime change for its environment and ignores others", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.emitRealtime("changed", { environmentId: "other", reason: "checkout" });
    expect(slot.inspection.rpcCalls).toHaveLength(1);
    await slot.behavior.emitRealtime("changed", { environmentId: "env1", reason: "checkout" });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    await act(async () => {
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.setRealtimeConnectionState("connected");
    });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(3));
  });

  it("asks for confirmation before pushing and previews the command", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ upstream: null, local: [{ name: "feat", sha: "abc1234", upstream: null, ahead: 0, behind: 0, gone: false, isCurrent: true, worktreePath: null, committedAt: 1, subject: "" }], head: { kind: "branch", name: "feat", sha: "abc1234" } }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Push..."));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toContain("git push --no-progress -u --end-of-options origin HEAD");
    await user.click(screen.getByText("Cancel"));
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["overview"]);
  });
});
