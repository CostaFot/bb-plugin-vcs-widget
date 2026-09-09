// @vitest-environment jsdom
import { loadPluginApp, renderSlot, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

afterEach(() => cleanup());
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { ActionResult, ChangesResult, JobStart, LogCommit, Overview } from "./contracts";
import type { JobKind } from "./shared/constants";
import { unavailableOverview } from "./contracts";
import { requestOpen } from "./lib/events";
import type { rpcContract } from "./server";

// jsdom lacks the layout APIs Radix and cmdk touch.
beforeAll(() => {
  // nwsapi implements ':modal' by re-entering Element.matches until it
  // overflows the stack (~300 ms per call); floating-ui asks for it on every
  // ancestor while Radix positions the popover, which cost 25 s per open.
  const nativeMatches = Element.prototype.matches;
  Element.prototype.matches = function matches(this: Element, selector: string) {
    if (selector === ":modal" || selector === ":popover-open" || selector === ":fullscreen") return false;
    return nativeMatches.call(this, selector);
  };
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
    upstream: { name: "origin/main", remote: "origin", branch: "main", ahead: 0, behind: 0, gone: false },
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

const job = (kind: JobKind, jobId = `job-${kind}`): JobStart => ({
  ok: true,
  jobId,
  kind,
  command: `git ${kind}`,
  startedAt: 1,
});

type Rpc = NonNullable<Parameters<typeof renderSlot<typeof props, typeof rpcContract>>[2]>["rpc"];

function render(options: {
  overview?: Overview;
  checkout?: (input: unknown) => ActionResult;
  environment?: { id: string; branchName: string } | null;
  compact?: boolean;
  /** The thread is hidden or archived: absent from bb's sidebar list. */
  offSidebar?: boolean;
  rpc?: Partial<NonNullable<Rpc>>;
  favourites?: string[];
  openThreadPanel?: (options: { actionId: string; title?: string; params?: unknown }) => boolean;
} = {}) {
  const view = options.overview ?? overview();
  const sidebar = sidebarThread(options.environment === undefined ? { id: "env1", branchName: "main" } : options.environment);
  let favourites = options.favourites ?? [];
  return renderSlot<typeof props, typeof rpcContract>(
    app.threadHeaderActions[0]!,
    { ...props, isCompactViewport: options.compact ?? false },
    {
      sidebarThreads: options.offSidebar ? { ...sidebar, threads: [] } : sidebar,
      settings: { updateStrategy: "ff-only", autoStash: false, confirmBeforePush: true, defaultRemote: "origin", fetchPrune: true },
      openThreadPanel: options.openThreadPanel ?? (() => true),
      rpc: {
        overview: () => view,
        checkout: (input) =>
          options.checkout?.(input) ?? {
            ok: true,
            message: `Switched to ${input.target.kind === "local" ? input.target.name : input.target.branch}.`,
            overview: view,
          },
        createBranch: () => ({ ok: true, message: "Created.", overview: view }),
        fetch: () => job("fetch"),
        pull: () => job("pull"),
        push: () => job("push"),
        updateBranch: () => job("updateBranch"),
        deleteRemoteBranch: () => job("deleteRemoteBranch"),
        jobGet: () => null,
        jobCancel: () => ({ cancelled: true }),
        deleteBranch: (input) => ({ ok: true, message: `Deleted ${input.name}.`, overview: view }),
        renameBranch: (input) => ({ ok: true, message: `Renamed ${input.from} to ${input.to}.`, overview: view }),
        merge: () => ({ ok: true, message: "Merged.", overview: view }),
        rebase: () => ({ ok: true, message: "Rebased.", overview: view }),
        abortOperation: () => ({ ok: true, message: "Aborted the rebase.", overview: { ...view, operation: "none" } }),
        setUpstream: () => ({ ok: true, message: "Tracking.", overview: view }),
        addWorktree: () => ({ ok: true, message: "Added worktree.", overview: view }),
        checkoutRevision: (input) => ({ ok: true, message: `Checked out ${input.revision}.`, overview: view }),
        listTags: () => ({ ok: true, tags: [{ name: "v1.0", sha: "abc1234", createdAt: 1, subject: "one" }], truncated: false }),
        compare: () => ({ ok: true, base: "main", target: "feature", aheadCount: 1, behindCount: 0, ahead: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", author: "Costa", committedAt: 1, subject: "feature work" }], behind: [], files: [{ path: "a.txt", oldPath: null, additions: 1, deletions: 0, binary: false }], truncated: { ahead: false, behind: false, files: false } }),
        comparePatch: (input) => ({ ok: true, path: input.path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
        diffWorkingTree: () => ({ ok: true, ref: "main", files: [], truncated: false }),
        diffWorkingTreePatch: (input) => ({ ok: true, path: input.path, patch: "", truncated: false, binary: false, contents: null }),
        favourites: () => ({ names: favourites }),
        setFavourite: (input) => {
          favourites = input.favourite ? [...favourites, input.name] : favourites.filter((name) => name !== input.name);
          return { names: favourites };
        },
        favouriteRepos: () => ({ repos: [] }),
        clearFavourites: () => ({ repos: [] }),
        changes: () => CHANGES,
        diffFile: (input) => ({ ok: true, path: input.path, side: input.side, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: { old: { path: input.path, content: "a\n" }, new: { path: input.path, content: "b\n" } } }),
        stage: (input) => ({ ok: true, message: `Staged ${input.paths.length} file(s).`, overview: view }),
        unstage: (input) => ({ ok: true, message: `Unstaged ${input.paths.length} file(s).`, overview: view }),
        discard: () => ({ ok: true, message: "Discarded.", overview: view }),
        commit: () => job("commit"),
        log: () => ({ ok: true, commits: [], skip: 0, hasMore: false }),
        commitDetails: () => ({ ok: false, error: { code: "ref_not_found", message: "gone" } }),
        commitPatch: (input) => ({ ok: true, path: input.path, patch: "", truncated: false, binary: false, contents: null }),
        cherryPick: () => ({ ok: true, message: "Cherry-picked.", overview: view }),
        revert: () => ({ ok: true, message: "Reverted.", overview: view }),
        resetTo: () => ({ ok: true, message: "Reset.", overview: view }),
        sendToAgent: () => ({ ok: true, delivery: "sent" }),
        ...options.rpc,
      },
    },
  );
}

const CHANGES: ChangesResult = {
  ok: true,
  head: { kind: "branch", name: "main", sha: "abc1234" },
  operation: "none",
  indexLocked: false,
  truncated: false,
  lastCommit: { sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Last one", message: "Last one\n\nBody" },
  files: [
    { path: "staged.txt", oldPath: null, index: "M", worktree: ".", kind: "tracked" },
    { path: "edited.txt", oldPath: null, index: ".", worktree: "M", kind: "tracked" },
    { path: "both.txt", oldPath: null, index: "M", worktree: "M", kind: "tracked" },
    { path: "new.txt", oldPath: null, index: ".", worktree: "?", kind: "untracked" },
  ],
};

/** RPC methods called so far, without the favourites read that every open makes. */
const methods = (slot: { inspection: { rpcCalls: { method: string }[] } }) =>
  slot.inspection.rpcCalls.map((call) => call.method).filter((method) => method !== "favourites");

/** Opens the context menu of a branch row and returns the menu. */
async function openMenu(popup: HTMLElement, name: string) {
  const row = popup.querySelector(`[data-branch-name="${name}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  return screen.findByTestId("vcs-branch-menu");
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
    await waitFor(() => expect(methods(slot)).toEqual(["overview"]));
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
    await waitFor(() => expect(methods(slot)).toEqual(["overview"]));
    await slot.behavior.emitRealtime("changed", { environmentId: "other", reason: "checkout" });
    expect(methods(slot)).toEqual(["overview"]);
    await slot.behavior.emitRealtime("changed", { environmentId: "env1", reason: "checkout" });
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "overview"]));
    await act(async () => {
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.setRealtimeConnectionState("connected");
    });
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "overview", "overview"]));
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
    expect(methods(slot)).toEqual(["overview"]);
  });

  it("pushes a tracked branch by explicit refspec and names the branch it showed", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Push..."));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git push --no-progress --end-of-options origin HEAD:refs/heads/main");
    await user.click(screen.getByText("Push", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "push",
        input: { threadId: "t1", remote: "origin", setUpstream: false, expectedBranch: "main", source: "head", expectedSha: "abc1234", lease: null },
      }),
    );
  });

  it("runs a palette request only once the overview is loaded and the row is enabled", async () => {
    const slot = render();
    act(() => requestOpen({ threadId: "t1", action: "fetch" }));
    await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "fetch"]));
  });

  it("refuses a palette request the popup row would refuse", async () => {
    const slot = render({ overview: overview({ remotes: [] }) });
    act(() => requestOpen({ threadId: "t1", action: "push" }));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findByText("Push...");
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-command-preview")).toBeNull();
    expect(methods(slot)).toEqual(["overview"]);
  });

  it("ignores a window event that carries its own detail", async () => {
    const slot = render();
    act(() => {
      window.dispatchEvent(new CustomEvent("vcs-widget:open", { detail: { threadId: "t1", action: "fetch" } }));
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-branch-popup")).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("reads the repository again and forgets the last outcome when reopened", async () => {
    const user = userEvent.setup();
    const slot = render({
      checkout: () => ({ ok: false, error: { code: "index_locked", message: "The repository index is locked." }, overview: overview() }),
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    let popup = await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview"]));
    const [featureRow] = await within(popup).findAllByText("feature");
    await user.click(featureRow!);
    await within(popup).findByText("The repository index is locked.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
    await user.click(slot.getByTestId("vcs-branch-button"));
    popup = await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "checkout", "overview"]));
    expect(within(popup).queryByText("The repository index is locked.")).toBeNull();
    expect((within(popup).getByLabelText("Search for branches and actions") as HTMLInputElement).value).toBe("");
  });

  it("returns from the New Branch step on Escape instead of closing", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("New Branch..."));
    await within(popup).findByLabelText("New branch name");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("vcs-branch-popup")).not.toBeNull();
    await within(popup).findByLabelText("Search for branches and actions");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
  });

  it("hides the Local heading while a filter matches no local branch", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.type(within(popup).getByLabelText("Search for branches and actions"), "hotfix");
    await waitFor(() => expect(within(popup).queryByText("Local")).toBeNull());
    expect(within(popup).getByText("Remote")).toBeTruthy();
  });

  it("reads the overview for a thread bb's sidebar does not list", async () => {
    const slot = render({ offSidebar: true, overview: overview({ head: { kind: "branch", name: "hidden-branch", sha: "abc1234" } }) });
    await waitFor(() => expect(slot.getByTestId("vcs-branch-button").textContent).toContain("hidden-branch"));
  });
});

describe("jobs", () => {
  it("starts a fetch job, shows its output and finishes on the realtime event", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Fetch"));
    await within(popup).findByText("Fetching…");
    expect(within(popup).getByText("Cancel")).toBeTruthy();
    await slot.behavior.emitRealtime("job", { environmentId: "env1", hostId: "h1", jobId: "job-fetch", event: { kind: "output", line: "From origin" } });
    await within(popup).findByText("From origin");
    await slot.behavior.emitRealtime("job", { environmentId: "env1", hostId: "h1", jobId: "other", event: { kind: "finished", result: { ok: true, message: "Not ours.", overview: null } } });
    expect(within(popup).queryByText("Not ours.")).toBeNull();
    await slot.behavior.emitRealtime("job", { environmentId: "env1", hostId: "h1", jobId: "job-fetch", event: { kind: "finished", result: { ok: true, message: "Fetched origin.", overview: overview() } } });
    await within(popup).findByText("Fetched origin.");
    expect(within(popup).queryByText("Cancel")).toBeNull();
  });

  it("falls back to polling jobGet and cancels through jobCancel", async () => {
    const user = userEvent.setup();
    const slot = render({
      rpc: {
        jobGet: () => ({ jobId: "job-fetch", kind: "fetch", command: "git fetch", startedAt: 1, status: "finished", finishedAt: 2, output: ["done"], result: { ok: false, error: { code: "network", message: "Fetch failed: no route." }, overview: null } }),
      },
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Fetch"));
    await within(popup).findByText("Fetching…");
    await user.click(within(popup).getByText("Cancel"));
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("jobCancel"));
    await within(popup).findByText("Fetch failed: no route.", undefined, { timeout: 4_000 });
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("jobGet");
  });

  it("shows another pane's job from the overview with a cancel button", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ activeJob: { jobId: "elsewhere", kind: "pull", command: "git pull", startedAt: Date.now() } }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    const banner = await within(popup).findByTestId("vcs-active-job");
    expect(banner.textContent).toMatch(/Update Project running/u);
    expect((within(popup).getByText("Fetch").closest("[cmdk-item]") as HTMLElement).getAttribute("aria-disabled")).toBe("true");
    await user.click(within(banner).getByText("Cancel"));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "jobCancel", input: { threadId: "t1", jobId: "elsewhere" } }));
  });
});

describe("context menu", () => {
  it("lists the IntelliJ rows and opens Compare in the side panel", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    const labels = Array.from(menu.querySelectorAll("[role=menuitem]")).map((item) => item.textContent?.replace(/F2$/u, "").trim());
    expect(labels).toEqual([
      "Checkout",
      "New Branch from 'feature'...",
      "Checkout and Rebase onto 'main'",
      "Checkout and Update",
      "Compare with 'main'",
      "Show Diff with Working Tree",
      "Show Log",
      "Rebase 'main' onto 'feature'",
      "Merge 'feature' into 'main'",
      "New Worktree from 'feature'...",
      "Update",
      "Push...",
      "Tracked Branch",
      "Rename...",
      "Delete",
      "Add to Favorites",
      "Copy Branch Name",
    ]);
    await user.click(within(menu).getByText("Compare with 'main'"));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "openThreadPanel",
        options: { actionId: "compare", title: "main ⇄ feature", params: { base: { kind: "local", name: "main" }, target: { kind: "local", name: "feature" } } },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
  });

  it("merges after showing the exact command", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    await user.click(within(menu).getByText("Merge 'feature' into 'main'"));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git merge --no-edit --end-of-options refs/heads/feature");
    await user.click(screen.getByText("Merge", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "merge", input: { threadId: "t1", ref: { kind: "local", name: "feature" } } }));
  });

  it("previews both commands for Checkout and Rebase onto the current branch", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findByText("origin/hotfix");
    const menu = await openMenu(popup, "origin/hotfix");
    await user.click(within(menu).getByText("Checkout and Rebase onto 'main'"));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git switch -c hotfix --track --end-of-options refs/remotes/origin/hotfix\ngit rebase --end-of-options refs/heads/main");
    await user.click(screen.getByText("Rebase", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "rebase",
        input: { threadId: "t1", onto: { kind: "local", name: "main" }, checkoutFirst: { kind: "remote", remote: "origin", branch: "hotfix" } },
      }),
    );
  });

  it("renames from the menu through the inline step", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    await user.click(within(menu).getByText("Rename..."));
    const input = await within(popup).findByLabelText("New name");
    expect((input as HTMLInputElement).value).toBe("feature");
    await user.clear(input);
    await user.type(input, "feature-2{Enter}");
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "renameBranch", input: { threadId: "t1", from: "feature", to: "feature-2" } }));
    await within(popup).findByText("Renamed feature to feature-2.");
  });

  it("deletes with -d, then asks again with -D when the branch is not fully merged", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const slot = render({
      rpc: {
        deleteBranch: (input) => {
          calls += 1;
          return input.force
            ? { ok: true, message: "Deleted feature.", overview: overview() }
            : { ok: false, error: { code: "not_fully_merged", message: "Delete failed: the branch 'feature' is not fully merged" }, overview: overview() };
        },
      },
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    await user.click(within(menu).getByText("Delete"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git branch -d --end-of-options feature");
    await user.click(screen.getByText("Delete", { selector: "button" }));
    await waitFor(() => expect(calls).toBe(1));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git branch -D --end-of-options feature");
    await user.click(screen.getByText("Delete anyway", { selector: "button" }));
    await waitFor(() => expect(calls).toBe(2));
    expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "deleteBranch", input: { threadId: "t1", name: "feature", force: true } });
  });

  it("stars a branch into the Favorites group", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    expect(within(popup).queryByText("Favorites")).toBeNull();
    await user.click(within(popup).getAllByLabelText("Add feature to favourites")[0]!);
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "setFavourite", input: { threadId: "t1", name: "local:feature", favourite: true } }));
    await within(popup).findByText("Favorites");
    expect(within(popup).getAllByText("feature").length).toBe(3);
    const menu = await openMenu(popup, "feature");
    expect(within(menu).getByText("Remove from Favorites")).toBeTruthy();
  });
});

describe("operations and force push", () => {
  it("offers Abort while a rebase is in progress", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ operation: "rebase" }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    const banner = await within(popup).findByTestId("vcs-operation-banner");
    expect(banner.textContent).toContain("A rebase is in progress.");
    await user.click(within(banner).getByText("Abort"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git rebase --abort");
    await user.click(screen.getByText("Abort", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "abortOperation", input: { threadId: "t1" } }));
  });

  it("force-pushes only through the lease switch", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ upstream: { name: "origin/main", remote: "origin", branch: "main", ahead: 1, behind: 1, gone: false } }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Push..."));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git push --no-progress --end-of-options origin HEAD:refs/heads/main");
    await user.click(screen.getByTestId("vcs-confirm-toggle"));
    await waitFor(() => expect(preview.textContent).toBe("git push --no-progress --force-with-lease=refs/heads/main:abc1234 --end-of-options origin HEAD:refs/heads/main"));
    await user.click(screen.getByText("Push", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "push",
        input: { threadId: "t1", remote: "origin", setUpstream: false, expectedBranch: "main", source: "head", expectedSha: "abc1234", lease: "abc1234" },
      }),
    );
  });

  it("checks out a tag through the revision step", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Checkout Tag or Revision..."));
    await user.click(await within(popup).findByText("v1.0"));
    await user.click(within(popup).getByText("Checkout", { selector: "button" }));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git switch --detach --end-of-options v1.0");
    await user.click(screen.getByText("Checkout", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "checkoutRevision", input: { threadId: "t1", revision: "v1.0" } }));
  });
});

describe("panels", () => {
  it("registers the compare, diff, commit and log panel tabs", () => {
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["compare", "diff", "commit", "log"]);
  });

  it("renders the comparison and a file's patch", async () => {
    const user = userEvent.setup();
    const compare = app.threadPanelActions.find((action) => action.id === "compare")!;
    const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      compare,
      { threadId: "t1", params: { base: { kind: "local", name: "main" }, target: { kind: "local", name: "feature" } } },
      {
        sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
        rpc: {
          compare: () => ({ ok: true, base: "main", target: "feature", aheadCount: 1, behindCount: 0, ahead: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", author: "Costa", committedAt: 1, subject: "feature work" }], behind: [], files: [{ path: "a.txt", oldPath: null, additions: 1, deletions: 0, binary: false }], truncated: { ahead: false, behind: false, files: false } }),
          comparePatch: (input: { path: string }) => ({ ok: true, path: input.path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
        } as never,
      },
    );
    await slot.findByText("feature work");
    expect(slot.getByTestId("vcs-compare-counts").textContent).toBe("feature +1 · main +0");
    await user.click(slot.getByText("a.txt"));
    await slot.findByTestId("vcs-patch");
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["compare", "comparePatch"]);
    const bad = renderSlot<PluginThreadPanelProps, typeof rpcContract>(compare, { threadId: "t1", params: { base: 1 } }, {});
    expect(bad.getByText(/Open this tab from a branch/u)).toBeTruthy();
  });
});

describe("CommitPanel", () => {
  type CommitRpc = Record<string, (input: never) => unknown>;

  function renderCommitPanel(options: { changes?: ChangesResult; overview?: Overview; rpc?: CommitRpc } = {}) {
    const view = options.overview ?? overview();
    const panel = app.threadPanelActions.find((action) => action.id === "commit")!;
    return renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      panel,
      { threadId: "t1", params: {} },
      {
        sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
        settings: { updateStrategy: "ff-only", autoStash: false, confirmBeforePush: true, defaultRemote: "origin", fetchPrune: true },
        rpc: {
          overview: () => view,
          changes: () => options.changes ?? CHANGES,
          diffFile: (input: { path: string; side: "index" | "worktree" }) => ({ ok: true, path: input.path, side: input.side, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
          stage: (input: { paths: string[] }) => ({ ok: true, message: `Staged ${input.paths.length} file(s).`, overview: view }),
          unstage: (input: { paths: string[] }) => ({ ok: true, message: `Unstaged ${input.paths.length} file(s).`, overview: view }),
          discard: () => ({ ok: true, message: "Discarded.", overview: view }),
          commit: () => job("commit"),
          push: () => job("push"),
          jobGet: () => null,
          jobCancel: () => ({ cancelled: true }),
          ...options.rpc,
        } as never,
      },
    );
  }

  const calls = (slot: { inspection: { rpcCalls: { method: string; input: unknown }[] } }, method: string) =>
    slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);

  it("lists the working tree in groups with the checkbox as the staged state", async () => {
    const slot = renderCommitPanel();
    await slot.findByText("staged.txt");
    expect(slot.getByText("Changes")).toBeTruthy();
    expect(slot.getByText("Unversioned files")).toBeTruthy();
    expect(slot.getByTestId("vcs-commit-counts").textContent).toBe("2 staged · 2 unstaged");
    expect(slot.getByLabelText("Unstage staged.txt").getAttribute("aria-checked")).toBe("true");
    expect(slot.getByLabelText("Stage edited.txt").getAttribute("aria-checked")).toBe("false");
    expect(slot.getByLabelText("Unstage both.txt").getAttribute("aria-checked")).toBe("mixed");
    expect(slot.getByLabelText("Stage new.txt").getAttribute("aria-checked")).toBe("false");
    expect(slot.queryByText("Nothing to commit: the working tree is clean.")).toBeNull();
  });

  it("stages and unstages through the checkboxes, whole groups through the header", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await user.click(await slot.findByLabelText("Stage edited.txt"));
    await waitFor(() => expect(calls(slot, "stage")).toEqual([{ threadId: "t1", paths: ["edited.txt"] }]));
    await user.click(slot.getByLabelText("Unstage staged.txt"));
    await waitFor(() => expect(calls(slot, "unstage")).toEqual([{ threadId: "t1", paths: ["staged.txt"] }]));
    await user.click(slot.getByLabelText("Stage all in Changes"));
    await waitFor(() => expect(calls(slot, "stage").at(-1)).toEqual({ threadId: "t1", paths: ["edited.txt", "both.txt"] }));
  });

  it("previews the staged side of a selected file and lets the other side be picked", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await user.click(await slot.findByText("both.txt"));
    await slot.findByTestId("vcs-patch");
    expect(calls(slot, "diffFile")).toEqual([{ threadId: "t1", path: "both.txt", oldPath: null, side: "index" }]);
    await user.click(slot.getByText("Unstaged", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "diffFile").at(-1)).toEqual({ threadId: "t1", path: "both.txt", oldPath: null, side: "worktree" }));
  });

  it("commits the index with the message as a job and clears the message when it finishes", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findByText("staged.txt");
    const button = slot.getByTestId("vcs-commit-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(slot.getByTestId("vcs-commit-message"), "Ship it");
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(calls(slot, "commit")).toEqual([{ threadId: "t1", message: "Ship it", amend: false, signoff: false, noVerify: false }]));
    expect(slot.getByTestId("vcs-commit-busy")).toBeTruthy();
    await slot.behavior.emitRealtime("job", { jobId: "job-commit", event: { kind: "finished", result: { ok: true, message: "Committed abc1234: Ship it", overview: overview() } } });
    await waitFor(() => expect((slot.getByTestId("vcs-commit-message") as HTMLTextAreaElement).value).toBe(""));
    expect(slot.getByText("Committed abc1234: Ship it")).toBeTruthy();
  });

  it("refuses to commit while blocked, and without anything staged", async () => {
    const slot = renderCommitPanel({ changes: { ...CHANGES, indexLocked: true } });
    await slot.findByText("staged.txt");
    expect(slot.getByText("Another git process holds the index lock.")).toBeTruthy();
    const empty = renderCommitPanel({ changes: { ...CHANGES, files: [CHANGES.files[1]!] } });
    await empty.findByText("edited.txt");
    expect(empty.getByText("Nothing is staged: tick the files to include.")).toBeTruthy();
  });

  it("amend prefills the last message and asks first with the exact command", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findByText("staged.txt");
    await user.click(slot.getByLabelText("Amend"));
    expect((slot.getByTestId("vcs-commit-message") as HTMLTextAreaElement).value).toBe("Last one\n\nBody");
    await user.click(slot.getByLabelText("Sign-off"));
    await user.click(slot.getByTestId("vcs-commit-button"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git commit -F - --amend --signoff");
    await user.click(screen.getByText("Amend", { selector: "button[type=button]" }));
    await waitFor(() => expect(calls(slot, "commit")).toEqual([{ threadId: "t1", message: "Last one\n\nBody", amend: true, signoff: true, noVerify: false }]));
  });

  it("discard asks with one command per category and runs nothing on cancel", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findByText("new.txt");
    await user.click(slot.getByLabelText("Discard changes in new.txt"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git --literal-pathspecs clean -f -- new.txt");
    await user.click(screen.getByText("Cancel"));
    expect(calls(slot, "discard")).toEqual([]);
    await user.click(slot.getByLabelText("Discard changes in staged.txt"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git --literal-pathspecs restore --staged --worktree --source=HEAD -- staged.txt");
    await user.click(screen.getByText("Discard", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "discard")).toEqual([{ threadId: "t1", restore: ["staged.txt"], remove: [], clean: [] }]));
  });

  /** Right-clicks a file row and returns its menu. */
  async function openFileMenu(slot: { getByText: (text: string) => HTMLElement }, path: string) {
    const row = slot.getByText(path).closest("[data-path]");
    if (!(row instanceof HTMLElement)) throw new Error(`no row for ${path}`);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    return screen.findByTestId("vcs-file-menu");
  }

  it("right-clicks a file for Copy Path and Discard", async () => {
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
    });
    const slot = renderCommitPanel();
    await slot.findByText("staged.txt");
    const menu = await openFileMenu(slot, "staged.txt");
    expect(Array.from(menu.querySelectorAll("[role=menuitem]")).map((item) => item.textContent)).toEqual(["Copy Path", "Discard"]);
    await user.click(within(menu).getByText("Copy Path"));
    await waitFor(() => expect(copied).toEqual(["staged.txt"]));
    expect(slot.getByTestId("vcs-commit-notice").textContent).toContain("Copied staged.txt");
    // The menu item is the row's discard button by another name.
    const untracked = await openFileMenu(slot, "new.txt");
    await user.click(within(untracked).getByText("Discard"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git --literal-pathspecs clean -f -- new.txt");
    await user.click(screen.getByText("Discard", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "discard")).toEqual([{ threadId: "t1", restore: [], remove: [], clean: ["new.txt"] }]));
  });

  it("discards a whole group from its header, and leaves Conflicts without the button", async () => {
    const user = userEvent.setup();
    const conflicted = { path: "clash.txt", oldPath: null, index: "U", worktree: "U", kind: "conflicted" as const };
    const slot = renderCommitPanel({ changes: { ...CHANGES, files: [...CHANGES.files, conflicted] } });
    await slot.findByText("staged.txt");
    expect(slot.queryByLabelText("Discard all changes in Conflicts")).toBeNull();
    await user.click(slot.getByLabelText("Discard all changes in Changes"));
    expect(await screen.findByText("Discard changes in 3 files")).toBeTruthy();
    expect(screen.getByTestId("vcs-command-preview").textContent).toBe(
      "git --literal-pathspecs restore --staged --worktree --source=HEAD -- staged.txt edited.txt both.txt",
    );
    await user.click(screen.getByText("Discard", { selector: "button" }));
    await waitFor(() =>
      expect(calls(slot, "discard")).toEqual([{ threadId: "t1", restore: ["staged.txt", "edited.txt", "both.txt"], remove: [], clean: [] }]),
    );
  });

  it("refuses a group discard whose paths would not fit one call", async () => {
    const user = userEvent.setup();
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `${"d".repeat(3000)}/${index}.txt`,
      oldPath: null,
      index: ".",
      worktree: "M",
      kind: "tracked" as const,
    }));
    const slot = renderCommitPanel({ changes: { ...CHANGES, files } });
    await slot.findByLabelText("Discard all changes in Changes");
    await user.click(slot.getByLabelText("Discard all changes in Changes"));
    expect(await slot.findByText("Too many files for one discard.")).toBeTruthy();
    expect(slot.getByText("Discard them in smaller groups.")).toBeTruthy();
    expect(screen.queryByTestId("vcs-command-preview")).toBeNull();
    expect(calls(slot, "discard")).toEqual([]);
  });

  it("hands the commit to the thread's agent whatever is staged", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel({ rpc: { sendToAgent: () => ({ ok: true, delivery: "queued" }) } });
    await slot.findByText("staged.txt");
    const button = slot.getByTestId("vcs-agent-commit-button") as HTMLButtonElement;
    // The label names the actor, because "Commit" is taken by the button beside it.
    expect(button.textContent).toBe("Agent Commit");
    // Commit itself is refused without a message; this one never is.
    expect((slot.getByTestId("vcs-commit-button") as HTMLButtonElement).disabled).toBe(true);
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(calls(slot, "sendToAgent")).toEqual([{ threadId: "t1", variant: "commit" }]));
    expect((await slot.findByTestId("vcs-commit-notice")).textContent).toContain("queued");
  });

  it("asks the agent to push too, without ever naming the text it sends", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel({ rpc: { sendToAgent: () => ({ ok: true, delivery: "sent" }) } });
    await slot.findByText("staged.txt");
    const button = slot.getByTestId("vcs-agent-commit-push-button") as HTMLButtonElement;
    expect(button.textContent).toBe("Agent Commit & Push");
    // Enabled with no upstream, unlike the panel's own push: the agent is the
    // one that can set one up, so a disabled button would hide the way out.
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(calls(slot, "sendToAgent")).toEqual([{ threadId: "t1", variant: "commit-push" }]));
    // The notice quotes what went to the agent, which is not what the button says.
    expect((await slot.findByTestId("vcs-commit-notice")).textContent).toContain("LGTM - Commit & Push");
  });

  it("reports an agent that could not be reached", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel({
      rpc: { sendToAgent: () => ({ ok: false, error: { code: "git_failed", message: "The message did not reach the agent: no such thread" } }) },
    });
    await slot.findByText("staged.txt");
    await user.click(slot.getByTestId("vcs-agent-commit-button"));
    expect((await slot.findByTestId("vcs-commit-notice")).textContent).toContain("did not reach the agent");
  });

  it("Commit and Push follows the commit with the push dialog on the overview the commit reported", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findByText("staged.txt");
    await user.type(slot.getByTestId("vcs-commit-message"), "Ship and push");
    await user.click(slot.getByTestId("vcs-commit-push-button"));
    await waitFor(() => expect(calls(slot, "commit")).toHaveLength(1));
    const after = overview({ head: { kind: "branch", name: "main", sha: "def5678" } });
    await slot.behavior.emitRealtime("job", { jobId: "job-commit", event: { kind: "finished", result: { ok: true, message: "Committed def5678: Ship and push", overview: after } } });
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git push --no-progress --end-of-options origin HEAD:refs/heads/main");
    await user.click(screen.getByText("Push", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "push")).toEqual([{ threadId: "t1", remote: "origin", setUpstream: false, expectedBranch: "main", source: "head", expectedSha: "def5678", lease: null }]));
  });
});

describe("opening the commit panel", () => {
  it("opens it from the popup's Commit row and straight from a palette request", async () => {
    const user = userEvent.setup();
    const opened: { actionId: string; title?: string }[] = [];
    const slot = render({
      openThreadPanel: (options) => {
        opened.push({ actionId: options.actionId, title: options.title });
        return true;
      },
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Commit..."));
    await waitFor(() => expect(opened).toEqual([{ actionId: "commit", title: "Commit" }]));
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
    act(() => requestOpen({ threadId: "t1", action: "commit" }));
    await waitFor(() => expect(opened).toHaveLength(2));
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-branch-popup")).toBeNull();
  });
});

describe("LogPanel", () => {
  type LogRpc = Record<string, (input: never) => unknown>;

  const commit = (extra: Partial<LogCommit> = {}): LogCommit => ({
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    author: "Costa",
    committedAt: 1_700_000_000,
    subject: "a change",
    refs: [
      { kind: "head", name: "HEAD" },
      { kind: "local", name: "main" },
    ],
    parents: ["b".repeat(40)],
    ...extra,
  });

  const DETAILS = {
    ok: true as const,
    commit: {
      ...commit(),
      authorEmail: "costa@example.com",
      authoredAt: 1_700_000_000,
      committer: "Costa",
      committerEmail: "costa@example.com",
      message: "a change\n\nWhy it changed.",
    },
    files: [{ path: "a.txt", oldPath: null, additions: 2, deletions: 1, binary: false }],
    truncated: false,
    againstParent: "b".repeat(40),
  };

  function renderLogPanel(options: { params?: Record<string, unknown>; rpc?: LogRpc; overview?: Overview; openThreadPanel?: (options: { actionId: string; title?: string; params?: unknown }) => boolean } = {}) {
    const view = options.overview ?? overview();
    const panel = app.threadPanelActions.find((action) => action.id === "log")!;
    return renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      panel,
      { threadId: "t1", params: (options.params ?? {}) as never },
      {
        sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
        settings: { updateStrategy: "ff-only", autoStash: false, confirmBeforePush: true, defaultRemote: "origin", fetchPrune: true },
        ...(options.openThreadPanel ? { openThreadPanel: options.openThreadPanel } : {}),
        rpc: {
          overview: () => view,
          log: () => ({ ok: true, commits: [commit(), commit({ sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "Merge branch 'x'", refs: [], parents: ["c".repeat(40), "d".repeat(40)] })], skip: 0, hasMore: false }),
          commitDetails: () => DETAILS,
          commitPatch: (input: { path: string }) => ({ ok: true, path: input.path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
          cherryPick: () => ({ ok: true, message: "Cherry-picked aaaaaaa.", overview: view }),
          revert: () => ({ ok: true, message: "Reverted aaaaaaa.", overview: view }),
          resetTo: () => ({ ok: true, message: "Reset main to aaaaaaa (--hard).", overview: view }),
          createBranch: () => ({ ok: true, message: "Created.", overview: view }),
          checkoutRevision: () => ({ ok: true, message: "Checked out.", overview: view }),
          jobGet: () => null,
          jobCancel: () => ({ cancelled: true }),
          ...options.rpc,
        } as never,
      },
    );
  }

  const openCommitMenu = async (slot: { container: HTMLElement }, sha: string) => {
    const row = slot.container.querySelector(`[data-sha="${sha}"]`);
    if (!(row instanceof HTMLElement)) throw new Error(`no row for ${sha}`);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    return screen.findByTestId("vcs-commit-menu");
  };

  it("lists commits with their ref badges and reads the log once", async () => {
    const slot = renderLogPanel();
    await slot.findByText("a change");
    expect(slot.getByText("Merge branch 'x'")).toBeTruthy();
    expect(slot.getByTestId("vcs-log-count").textContent).toBe("2");
    const badges = Array.from(slot.container.querySelectorAll("[data-ref-kind]")).map((node) => [node.getAttribute("data-ref-kind"), node.textContent]);
    expect(badges).toEqual([
      ["head", "HEAD"],
      ["local", "main"],
    ]);
    const reads = slot.inspection.rpcCalls.filter((call) => call.method === "log");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.input).toEqual({ threadId: "t1", filter: { kind: "all" }, grep: null, skip: 0 });
  });

  it("opens the tab on a branch when the popup asked for one", async () => {
    const slot = renderLogPanel({ params: { filter: { kind: "ref", ref: { kind: "local", name: "feature" } } } });
    await slot.findByText("a change");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "log")?.input).toMatchObject({ filter: { kind: "ref", ref: { kind: "local", name: "feature" } } });
    expect((slot.getByTestId("vcs-log-filter") as HTMLSelectElement).value).toBe("ref:feature");
    const ignored = renderLogPanel({ params: { filter: { kind: "ref", ref: { kind: "local", name: "-bad" } } } });
    await ignored.findByText("a change");
    expect(ignored.inspection.rpcCalls.find((call) => call.method === "log")?.input).toMatchObject({ filter: { kind: "all" } });
  });

  it("reads again for a branch filter and for a message filter", async () => {
    const user = userEvent.setup();
    const slot = renderLogPanel();
    await slot.findByText("a change");
    await user.selectOptions(slot.getByTestId("vcs-log-filter"), "head");
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "log")).toHaveLength(2));
    expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({ filter: { kind: "head" } });
    await user.type(slot.getByTestId("vcs-log-search"), "fix");
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({ grep: "fix" }), { timeout: 2_000 });
  });

  it("shows the selected commit, its files and one file's diff", async () => {
    const user = userEvent.setup();
    const slot = renderLogPanel();
    await user.click(await slot.findByText("a change"));
    await slot.findByTestId("vcs-log-details");
    expect(slot.getByTestId("vcs-log-sha").textContent).toBe("a".repeat(40));
    expect(slot.getByText(/Why it changed/u)).toBeTruthy();
    await user.click(slot.getByText("a.txt"));
    await slot.findByTestId("vcs-patch");
    expect(slot.inspection.rpcCalls.at(-1)).toEqual({
      method: "commitPatch",
      input: { threadId: "t1", sha: "a".repeat(40), path: "a.txt", oldPath: null },
    });
    await user.click(slot.getByTestId("vcs-log-back"));
    await slot.findByTestId("vcs-log-details");
  });

  it("asks with the exact command before a cherry-pick, a revert and a reset", async () => {
    const user = userEvent.setup();
    const sha = "a".repeat(40);
    const slot = renderLogPanel();
    await slot.findByText("a change");

    const menu = await openCommitMenu(slot, sha);
    await user.click(within(menu).getByText("Cherry-Pick"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git cherry-pick --end-of-options ${sha}`);
    await user.click(screen.getByText("Cherry-pick", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "cherryPick", input: { threadId: "t1", sha } }));

    const again = await openCommitMenu(slot, sha);
    await user.click(within(again).getByText("Revert Commit"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git revert --no-edit --end-of-options ${sha}`);
    await user.click(screen.getByText("Revert", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "revert", input: { threadId: "t1", sha } }));

    const third = await openCommitMenu(slot, sha);
    // Radix opens a submenu on pointer move, which userEvent's hover sends.
    await user.hover(within(third).getByText("Reset Current Branch to Here..."));
    // A plain click: Radix's submenu items swallow userEvent's pointer
    // sequence under jsdom.
    fireEvent.click(await screen.findByText("Hard"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git reset --hard --end-of-options ${sha} --`);
    await user.click(screen.getByText("Reset --hard", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "resetTo", input: { threadId: "t1", sha, mode: "hard" } }));
  });

  it("ignores the release of the right-click that opened the menu", async () => {
    const slot = renderLogPanel();
    await slot.findByText("a change");
    const menu = await openCommitMenu(slot, "a".repeat(40));
    const checkout = within(menu).getByText("Checkout Revision");
    // Radix clicks an item on a pointerup it saw no pointerdown for, which is
    // the release of the right-click when the menu opened under the pointer.
    fireEvent.pointerUp(checkout);
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-command-preview")).toBeNull();
    // A real click still opens the confirm dialog with its command.
    fireEvent.click(checkout);
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git switch --detach --end-of-options ${"a".repeat(40)}`);
  });

  it("refuses to cherry-pick or revert a merge commit", async () => {
    const slot = renderLogPanel();
    await slot.findByText("Merge branch 'x'");
    const menu = await openCommitMenu(slot, "b".repeat(40));
    expect(within(menu).getByText("Cherry-Pick").getAttribute("data-disabled")).not.toBeNull();
    expect(within(menu).getByText("Revert Commit").getAttribute("data-disabled")).not.toBeNull();
    expect(within(menu).getByText("Copy Revision Number").getAttribute("data-disabled")).toBeNull();
  });

  it("creates a branch from a commit and opens the compare tab against the current branch", async () => {
    const user = userEvent.setup();
    const sha = "a".repeat(40);
    const opened: { actionId: string; params?: unknown }[] = [];
    const slot = renderLogPanel({
      openThreadPanel: (options) => {
        opened.push({ actionId: options.actionId, params: options.params });
        return true;
      },
    });
    await slot.findByText("a change");

    const menu = await openCommitMenu(slot, sha);
    await user.click(within(menu).getByText("New Branch from 'aaaaaaa'..."));
    await user.type(await screen.findByLabelText("New branch name"), "from-log");
    await user.click(screen.getByText("Create", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "createBranch",
        input: { threadId: "t1", name: "from-log", startPoint: sha, checkout: true },
      }),
    );

    const again = await openCommitMenu(slot, sha);
    await user.click(within(again).getByText("Compare with 'main'"));
    await waitFor(() =>
      expect(opened).toEqual([
        { actionId: "compare", params: { base: { kind: "local", name: "main" }, target: { kind: "revision", revision: sha } } },
      ]),
    );
  });

  it("reports a git failure and an empty log without pretending to have rows", async () => {
    const failing = renderLogPanel({ rpc: { log: () => ({ ok: false, error: { code: "git_failed", message: "log failed", hint: "try again" } }) } });
    expect(await failing.findByText("log failed")).toBeTruthy();
    expect(failing.getByText("try again")).toBeTruthy();
    const empty = renderLogPanel({ rpc: { log: () => ({ ok: true, commits: [], skip: 0, hasMore: false }) } });
    expect(await empty.findByText("No commit yet.")).toBeTruthy();
  });

  it("loads the next page and keeps the rows it already has", async () => {
    const user = userEvent.setup();
    let call = 0;
    const slot = renderLogPanel({
      rpc: {
        log: () => {
          call += 1;
          return call === 1
            ? { ok: true, commits: [commit()], skip: 0, hasMore: true }
            : { ok: true, commits: [commit(), commit({ sha: "c".repeat(40), shortSha: "ccccccc", subject: "older", refs: [], parents: [] })], skip: 1, hasMore: false };
        },
      },
    });
    await slot.findByText("a change");
    await user.click(slot.getByTestId("vcs-log-more"));
    await slot.findByText("older");
    // The repeated commit arrives once.
    expect(slot.container.querySelectorAll(`[data-sha="${"a".repeat(40)}"]`)).toHaveLength(1);
    expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({ skip: 1 });
  });
});

describe("settings sections", () => {
  function renderSettings(id: string, rpc: Record<string, unknown> = {}) {
    const section = app.settingsSections.find((entry) => entry.id === id)!;
    return renderSlot<Record<string, never>, typeof rpcContract>(section, {}, { rpc: rpc as never });
  }

  it("registers both sections with a heading of their own", () => {
    expect(app.settingsSections.map((section) => section.id)).toEqual(["agent-access", "favourites"]);
    expect(app.settingsSections[0]?.title).toBe("Agent access");
  });

  it("names the read-only surfaces an agent can reach", () => {
    const slot = renderSettings("agent-access");
    expect(slot.getByText("bb vcs-widget status")).toBeTruthy();
    expect(slot.getByText("vcs_widget_status")).toBeTruthy();
    expect(slot.container.textContent).toContain("Both only read");
  });

  it("says where favourites come from when there are none", async () => {
    const slot = renderSettings("favourites", { favouriteRepos: () => ({ repos: [] }) });
    expect(await slot.findByText(/No favourites yet/u)).toBeTruthy();
  });

  it("lists a repository's favourites and clears them", async () => {
    const user = userEvent.setup();
    let repos = [{ hostId: "h1", repoRoot: "/repo", names: ["local:main", "remote:origin/feature"] }];
    const slot = renderSettings("favourites", {
      favouriteRepos: () => ({ repos }),
      clearFavourites: (input: { hostId: string; repoRoot: string }) => {
        repos = repos.filter((repo) => repo.hostId !== input.hostId || repo.repoRoot !== input.repoRoot);
        return { repos };
      },
    });
    expect(await slot.findByText("/repo")).toBeTruthy();
    // The stored key is `local:main`; the row shows the branch.
    expect(slot.getByText("main")).toBeTruthy();
    expect(slot.getByText("origin/feature")).toBeTruthy();
    await user.click(slot.getByRole("button", { name: "Clear" }));
    expect(await slot.findByText(/No favourites yet/u)).toBeTruthy();
    expect(slot.inspection.rpcCalls.at(-1)).toMatchObject({ method: "clearFavourites", input: { hostId: "h1", repoRoot: "/repo" } });
  });
});
