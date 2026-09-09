// VCS Group backend: resolves a thread to its environment, forwards git work
// to the host worker on the machine that owns the worktree, and tells open
// app pages when the repository changed.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, unavailableOverview, type ActionResult } from "./contracts";
import { isValidRemoteName } from "./shared/branch-name";
import { CHANGED_CHANNEL, PULL_STRATEGIES, isPullStrategy } from "./shared/constants";
import { hintFor } from "./shared/git-errors";
import { createAfterMutation } from "./server/after-mutation";
import { RepositoryUnavailableError, repositoryForThread, type RepositoryTarget } from "./server/repo-target";

// app.tsx imports only the type of this contract.
export { rpcContract } from "./contracts";

const RECENT_LIMIT = 8;

const VERB: Record<string, string> = {
  checkout: "The checkout",
  createBranch: "Creating the branch",
  fetch: "The fetch",
  pull: "Update Project",
  push: "The push",
};

function isDeadlineFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (error instanceof Error && error.name === "AbortError") || /deadline|timed? ?out|cancel/iu.test(message);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    updateStrategy: {
      type: "select",
      label: "Update Project strategy",
      description: "How Update Project integrates upstream changes. ff-only refuses to run when the branches diverged.",
      options: [...PULL_STRATEGIES],
      default: "ff-only",
    },
    autoStash: {
      type: "boolean",
      label: "Auto-stash before Update Project",
      description: "Stash uncommitted changes before pulling and restore them afterwards.",
      default: false,
    },
    confirmBeforePush: {
      type: "boolean",
      label: "Confirm before push",
      description: "Show the exact git command and ask before every push.",
      default: true,
    },
    defaultRemote: {
      type: "string",
      label: "Default remote",
      description: "Remote used by Fetch and Push when the branch has no upstream.",
      default: "origin",
    },
    fetchPrune: {
      type: "boolean",
      label: "Prune on fetch",
      description: "Remove remote-tracking branches that no longer exist on the remote.",
      default: true,
    },
  });

  // Host calls are only legal from handlers, services and timers; creating
  // the client here is fine.
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const changes = createAfterMutation(bb);

  async function effectiveSettings() {
    const values = await settings.get();
    return {
      strategy: isPullStrategy(values.updateStrategy) ? values.updateStrategy : "ff-only",
      autoStash: values.autoStash,
      defaultRemote: isValidRemoteName(values.defaultRemote) ? values.defaultRemote : "origin",
      fetchPrune: values.fetchPrune,
    };
  }

  function unavailableResult(message: string): ActionResult {
    return {
      ok: false,
      error: { code: "not_a_repo", message, hint: hintFor("not_a_repo", "preflight") ?? "" },
      overview: unavailableOverview(message),
    };
  }

  async function withTarget(
    threadId: string,
    reason: string,
    run: (target: RepositoryTarget) => Promise<ActionResult>,
  ): Promise<ActionResult> {
    let target: RepositoryTarget;
    try {
      target = await repositoryForThread(bb, threadId);
    } catch (error) {
      if (error instanceof RepositoryUnavailableError) return unavailableResult(error.message);
      throw error;
    }
    // Every mutation is visible in the plugin log with the thread that asked
    // for it: the RPC route is local-auth like all of bb's API, so this is the
    // audit trail, not a guard (see README, "Safety model").
    bb.log.info(`${reason} requested for thread ${threadId} on ${target.hostId}:${target.repoPath}`);
    let result: ActionResult;
    try {
      result = await run(target);
    } catch (error) {
      // bb's 30 s deadline, an offline host or a crashed worker: the daemon
      // cancels the call, it does not undo git. Report a typed result and
      // refresh, because the mutation may well have completed.
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`${reason} on ${target.environmentId} did not report back: ${message}`);
      changes.afterMutation(target.environmentId, `${reason}:unknown`);
      return {
        ok: false,
        error: {
          code: isDeadlineFailure(error) ? "timeout" : "git_failed",
          message: `${VERB[reason] ?? reason} did not report back: ${message}`,
          hint: "The command may still have completed on the host; the branch list refreshes automatically.",
        },
        overview: null,
      };
    }
    if (result.ok) {
      changes.afterMutation(target.environmentId, reason);
    } else if (result.overview !== null || result.error.code === "timeout") {
      // A failed pull can still leave the tree changed; let other panes know.
      changes.publish(target.environmentId, `${reason}:failed`);
    }
    return result;
  }

  bb.rpc.register(rpcContract, {
    async overview({ threadId }) {
      try {
        const target = await repositoryForThread(bb, threadId);
        return await host.call(
          "overview",
          { repoPath: target.repoPath, recentLimit: RECENT_LIMIT },
          { hostId: target.hostId },
        );
      } catch (error) {
        if (error instanceof RepositoryUnavailableError) return unavailableOverview(error.message);
        throw error;
      }
    },

    checkout({ threadId, target }) {
      return withTarget(threadId, "checkout", (repo) =>
        host.call("checkout", { repoPath: repo.repoPath, target }, { hostId: repo.hostId }),
      );
    },

    createBranch({ threadId, ...input }) {
      return withTarget(threadId, "createBranch", (repo) =>
        host.call("createBranch", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    async fetch({ threadId, remote, prune }) {
      const defaults = await effectiveSettings();
      return withTarget(threadId, "fetch", (repo) =>
        host.call(
          "fetch",
          { repoPath: repo.repoPath, remote, prune: prune ?? defaults.fetchPrune },
          { hostId: repo.hostId },
        ),
      );
    },

    async pull({ threadId, strategy, autoStash }) {
      const defaults = await effectiveSettings();
      return withTarget(threadId, "pull", (repo) =>
        host.call(
          "pull",
          {
            repoPath: repo.repoPath,
            strategy: strategy ?? defaults.strategy,
            autoStash: autoStash ?? defaults.autoStash,
          },
          { hostId: repo.hostId },
        ),
      );
    },

    async push({ threadId, remote, setUpstream, expectedBranch }) {
      const defaults = await effectiveSettings();
      return withTarget(threadId, "push", (repo) =>
        host.call(
          "push",
          { repoPath: repo.repoPath, remote: remote ?? defaults.defaultRemote, setUpstream, expectedBranch },
          { hostId: repo.hostId },
        ),
      );
    },
  });

  // A crashed worker may have left a mutation half-reported; tell every open
  // popup to refetch (a payload without environmentId means "everyone").
  const offWorkerExit = host.experimental_onWorkerExit(({ hostId }) => {
    bb.log.warn(`host worker on ${hostId} exited unexpectedly`);
    bb.realtime.publish(CHANGED_CHANNEL, { hostId, reason: "worker-exit" });
  });

  // bb's daemon watches every environment and reports git ref and work-tree
  // changes (agent checkouts, terminal commits). Republish them on our channel
  // so open popups refetch without polling.
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = bb.sdk.subscribe({
      event: "environment:changed",
      callback: (event) => {
        // An event already in flight when the plugin reloads must not touch
        // a stale API handle.
        if (disposed || event.id === undefined) return;
        if (event.changes.includes("git-refs-changed") || event.changes.includes("work-status-changed")) {
          changes.publish(event.id, "environment-changed");
        }
      },
    });
  } catch (error) {
    bb.log.warn(
      `environment change subscription unavailable; popups refresh on open and after actions only: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  bb.onDispose(() => {
    disposed = true;
    unsubscribe?.();
    offWorkerExit();
    changes.dispose();
  });

  bb.log.info("VCS Group loaded");
}
