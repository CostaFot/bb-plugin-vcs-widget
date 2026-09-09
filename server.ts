// VCS Widget backend: resolves a thread to its environment, forwards git work
// to the host worker on the machine that owns the worktree, relays the
// worker's signals (job progress, file watch) to open app pages, and keeps
// the favourites.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  hostSignals,
  rpcContract,
  unavailableOverview,
  type ActionResult,
  type FavouriteRepo,
  type GitError,
  type JobRealtimePayload,
  type JobStart,
  type Overview,
} from "./contracts";
import { MAX_BRANCH_NAME_LENGTH, isValidRemoteName } from "./shared/branch-name";
import {
  CHANGED_CHANNEL,
  JOB_CHANNEL,
  JOB_TIMEOUT_SECONDS,
  MAX_LOG_GREP_LENGTH,
  PULL_STRATEGIES,
  isPullStrategy,
  type ChangedPayload,
} from "./shared/constants";
import { hintFor } from "./shared/git-errors";
import { createAfterMutation } from "./server/after-mutation";
import { CLI_COMMANDS, CLI_NAME, CLI_SUMMARY, parseCli, runCli, runCommand, type CliReader } from "./server/cli";
import { RepositoryUnavailableError, repositoryForThread, type RepositoryTarget } from "./server/repo-target";

// app.tsx imports only the type of this contract.
export { rpcContract } from "./contracts";

const RECENT_LIMIT = 8;
/** Favourites are a small list; keep it well under the kv row cap. */
const MAX_FAVOURITES = 200;
const FAVOURITE_PREFIX = "fav:";

const VERB: Record<string, string> = {
  checkout: "The checkout",
  createBranch: "Creating the branch",
  fetch: "The fetch",
  pull: "Update Project",
  push: "The push",
  updateBranch: "The update",
  deleteRemoteBranch: "Deleting the remote branch",
  deleteBranch: "Deleting the branch",
  renameBranch: "Renaming the branch",
  merge: "The merge",
  rebase: "The rebase",
  abortOperation: "The abort",
  setUpstream: "Changing the tracked branch",
  addWorktree: "Adding the worktree",
  checkoutRevision: "The checkout",
  cherryPick: "The cherry-pick",
  revert: "The revert",
  resetTo: "The reset",
  stage: "Staging",
  unstage: "Unstaging",
  discard: "The discard",
  commit: "The commit",
};

function isDeadlineFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (error instanceof Error && error.name === "AbortError") || /deadline|timed? ?out|cancel/iu.test(message);
}

const repoKey = (hostId: string, repoRoot: string) => `${hostId}\0${repoRoot}`;

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
    jobTimeoutSeconds: {
      type: "number",
      label: "Network operation timeout (seconds)",
      description: "Fetch, pull and push run in the background on the host and are stopped after this long.",
      default: JOB_TIMEOUT_SECONDS.default,
    },
  });

  // Host calls are only legal from handlers, services and timers; creating
  // the client here is fine.
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const changes = createAfterMutation(bb);

  // Which environments a host repository serves, learned from overviews, so
  // a watch or job signal (which only knows the repository) reaches the
  // right popups.
  const environmentsByRepo = new Map<string, Set<string>>();
  const repoByEnvironment = new Map<string, { hostId: string; repoRoot: string }>();
  // Jobs this server started: the environment to refresh when they finish.
  const jobs = new Map<string, { environmentId: string; hostId: string; reason: string }>();

  function remember(target: RepositoryTarget, overview: Overview | null): void {
    if (overview === null || overview.repoRoot === null) return;
    const key = repoKey(target.hostId, overview.repoRoot);
    let set = environmentsByRepo.get(key);
    if (set === undefined) {
      set = new Set();
      environmentsByRepo.set(key, set);
    }
    set.add(target.environmentId);
    repoByEnvironment.set(target.environmentId, { hostId: target.hostId, repoRoot: overview.repoRoot });
  }

  async function effectiveSettings() {
    const values = await settings.get();
    const seconds = typeof values.jobTimeoutSeconds === "number" && Number.isFinite(values.jobTimeoutSeconds) ? values.jobTimeoutSeconds : JOB_TIMEOUT_SECONDS.default;
    return {
      strategy: isPullStrategy(values.updateStrategy) ? values.updateStrategy : "ff-only",
      autoStash: values.autoStash,
      defaultRemote: isValidRemoteName(values.defaultRemote) ? values.defaultRemote : "origin",
      fetchPrune: values.fetchPrune,
      jobTimeoutMs: Math.min(JOB_TIMEOUT_SECONDS.max, Math.max(JOB_TIMEOUT_SECONDS.min, Math.round(seconds))) * 1000,
    };
  }

  function unavailableError(message: string): GitError {
    return { code: "not_a_repo", message, hint: hintFor("not_a_repo", "preflight") ?? "" };
  }

  function unavailableResult(message: string): ActionResult {
    return { ok: false, error: unavailableError(message), overview: unavailableOverview(message) };
  }

  async function resolveTarget(threadId: string): Promise<RepositoryTarget | { unavailable: string }> {
    try {
      return await repositoryForThread(bb, threadId);
    } catch (error) {
      if (error instanceof RepositoryUnavailableError) return { unavailable: error.message };
      throw error;
    }
  }

  function transportFailure(reason: string, target: RepositoryTarget, error: unknown): GitError {
    // bb's 30 s deadline, an offline host or a crashed worker: the daemon
    // cancels the call, it does not undo git. Report a typed result and
    // refresh, because the mutation may well have completed.
    const message = error instanceof Error ? error.message : String(error);
    bb.log.warn(`${reason} on ${target.environmentId} did not report back: ${message}`);
    return {
      code: isDeadlineFailure(error) ? "timeout" : "git_failed",
      message: `${VERB[reason] ?? reason} did not report back: ${message}`,
      hint: "The command may still have completed on the host; the branch list refreshes automatically.",
    };
  }

  function logMutation(reason: string, threadId: string, target: RepositoryTarget): void {
    // Every mutation is visible in the plugin log with the thread that asked
    // for it: the RPC route is local-auth like all of bb's API, so this is the
    // audit trail, not a guard (see README, "Safety model").
    bb.log.info(`${reason} requested for thread ${threadId} on ${target.hostId}:${target.repoPath}`);
  }

  async function withTarget(
    threadId: string,
    reason: string,
    run: (target: RepositoryTarget) => Promise<ActionResult>,
  ): Promise<ActionResult> {
    const target = await resolveTarget(threadId);
    if ("unavailable" in target) return unavailableResult(target.unavailable);
    logMutation(reason, threadId, target);
    let result: ActionResult;
    try {
      result = await run(target);
    } catch (error) {
      changes.afterMutation(target.environmentId, `${reason}:unknown`);
      return { ok: false, error: transportFailure(reason, target, error), overview: null };
    }
    remember(target, result.overview);
    if (result.ok) {
      changes.afterMutation(target.environmentId, reason);
    } else if (result.overview !== null || result.error.code === "timeout") {
      // A failed merge can still leave the tree changed; let other panes know.
      changes.publish(target.environmentId, `${reason}:failed`);
    }
    return result;
  }

  /** Starts a background job on the host and remembers which environment it belongs to. */
  async function withJobTarget(
    threadId: string,
    reason: string,
    run: (target: RepositoryTarget, timeoutMs: number) => Promise<JobStart>,
  ): Promise<JobStart> {
    const target = await resolveTarget(threadId);
    if ("unavailable" in target) return { ok: false, error: unavailableError(target.unavailable), overview: unavailableOverview(target.unavailable) };
    logMutation(reason, threadId, target);
    const defaults = await effectiveSettings();
    let start: JobStart;
    try {
      start = await run(target, defaults.jobTimeoutMs);
    } catch (error) {
      changes.afterMutation(target.environmentId, `${reason}:unknown`);
      return { ok: false, error: transportFailure(reason, target, error), overview: null };
    }
    if (start.ok) {
      jobs.set(start.jobId, { environmentId: target.environmentId, hostId: target.hostId, reason });
      bb.log.info(`${reason} job ${start.jobId} started for thread ${threadId}: ${start.command}`);
    } else {
      remember(target, start.overview);
    }
    return start;
  }

  /** Forwards a read; host transport failures become a typed failure. */
  async function withReadTarget<T extends { ok: boolean }>(
    threadId: string,
    run: (target: RepositoryTarget) => Promise<T>,
    failure: (error: GitError) => T,
  ): Promise<T> {
    const target = await resolveTarget(threadId);
    if ("unavailable" in target) return failure(unavailableError(target.unavailable));
    try {
      return await run(target);
    } catch (error) {
      return failure(transportFailure("read", target, error));
    }
  }

  /** `fav:<hostId>:<repoRoot>`; host ids carry no colon, worktree paths may. */
  const favouriteKey = (hostId: string, repoRoot: string) => `${FAVOURITE_PREFIX}${hostId}:${repoRoot}`;

  async function favouritesKey(threadId: string): Promise<{ key: string } | { unavailable: string }> {
    const target = await resolveTarget(threadId);
    if ("unavailable" in target) return target;
    const known = repoByEnvironment.get(target.environmentId);
    return { key: favouriteKey(target.hostId, known?.repoRoot ?? target.repoPath) };
  }

  async function readFavourites(key: string): Promise<string[]> {
    const stored = await bb.storage.kv.get<unknown>(key);
    return Array.isArray(stored) ? stored.filter((name): name is string => typeof name === "string") : [];
  }

  async function allFavourites(): Promise<FavouriteRepo[]> {
    const keys = await bb.storage.kv.list(FAVOURITE_PREFIX);
    const repos: FavouriteRepo[] = [];
    for (const key of keys) {
      const rest = key.slice(FAVOURITE_PREFIX.length);
      const separator = rest.indexOf(":");
      if (separator <= 0) continue;
      const names = await readFavourites(key);
      if (names.length === 0) continue;
      repos.push({ hostId: rest.slice(0, separator), repoRoot: rest.slice(separator + 1), names });
    }
    return repos.sort((left, right) => left.repoRoot.localeCompare(right.repoRoot));
  }

  const readFailure = (error: GitError) => ({ ok: false as const, error });

  bb.rpc.register(rpcContract, {
    async overview({ threadId }) {
      const target = await resolveTarget(threadId);
      if ("unavailable" in target) return unavailableOverview(target.unavailable);
      const overview = await host.call(
        "overview",
        { repoPath: target.repoPath, recentLimit: RECENT_LIMIT },
        { hostId: target.hostId },
      );
      remember(target, overview);
      return overview;
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
      return withJobTarget(threadId, "fetch", (repo, timeoutMs) =>
        host.call(
          "fetch",
          { repoPath: repo.repoPath, remote, prune: prune ?? defaults.fetchPrune, timeoutMs },
          { hostId: repo.hostId },
        ),
      );
    },

    async pull({ threadId, strategy, autoStash }) {
      const defaults = await effectiveSettings();
      return withJobTarget(threadId, "pull", (repo, timeoutMs) =>
        host.call(
          "pull",
          {
            repoPath: repo.repoPath,
            strategy: strategy ?? defaults.strategy,
            autoStash: autoStash ?? defaults.autoStash,
            timeoutMs,
          },
          { hostId: repo.hostId },
        ),
      );
    },

    async push({ threadId, remote, ...input }) {
      const defaults = await effectiveSettings();
      return withJobTarget(threadId, "push", (repo, timeoutMs) =>
        host.call(
          "push",
          { repoPath: repo.repoPath, remote: remote ?? defaults.defaultRemote, ...input, timeoutMs },
          { hostId: repo.hostId },
        ),
      );
    },

    updateBranch({ threadId, branch }) {
      return withJobTarget(threadId, "updateBranch", (repo, timeoutMs) =>
        host.call("updateBranch", { repoPath: repo.repoPath, branch, timeoutMs }, { hostId: repo.hostId }),
      );
    },

    deleteRemoteBranch({ threadId, ...input }) {
      return withJobTarget(threadId, "deleteRemoteBranch", (repo, timeoutMs) =>
        host.call("deleteRemoteBranch", { repoPath: repo.repoPath, ...input, timeoutMs }, { hostId: repo.hostId }),
      );
    },

    async jobGet({ threadId, jobId }) {
      const target = await resolveTarget(threadId);
      if ("unavailable" in target) return null;
      return host.call("jobGet", { repoPath: target.repoPath, jobId }, { hostId: target.hostId });
    },

    async jobCancel({ threadId, jobId }) {
      const target = await resolveTarget(threadId);
      if ("unavailable" in target) return { cancelled: false };
      bb.log.info(`job ${jobId} cancel requested for thread ${threadId}`);
      return host.call("jobCancel", { repoPath: target.repoPath, jobId }, { hostId: target.hostId });
    },

    deleteBranch({ threadId, ...input }) {
      return withTarget(threadId, "deleteBranch", (repo) =>
        host.call("deleteBranch", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    renameBranch({ threadId, ...input }) {
      return withTarget(threadId, "renameBranch", (repo) =>
        host.call("renameBranch", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    merge({ threadId, ...input }) {
      return withTarget(threadId, "merge", (repo) =>
        host.call("merge", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    rebase({ threadId, ...input }) {
      return withTarget(threadId, "rebase", (repo) =>
        host.call("rebase", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    abortOperation({ threadId }) {
      return withTarget(threadId, "abortOperation", (repo) =>
        host.call("abortOperation", { repoPath: repo.repoPath }, { hostId: repo.hostId }),
      );
    },

    setUpstream({ threadId, ...input }) {
      return withTarget(threadId, "setUpstream", (repo) =>
        host.call("setUpstream", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    addWorktree({ threadId, ...input }) {
      return withTarget(threadId, "addWorktree", (repo) =>
        host.call("addWorktree", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    checkoutRevision({ threadId, ...input }) {
      return withTarget(threadId, "checkoutRevision", (repo) =>
        host.call("checkoutRevision", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
      );
    },

    listTags({ threadId }) {
      return withReadTarget(threadId, (repo) => host.call("listTags", { repoPath: repo.repoPath }, { hostId: repo.hostId }), readFailure);
    },

    compare({ threadId, ...input }) {
      return withReadTarget(threadId, (repo) => host.call("compare", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }), readFailure);
    },

    comparePatch({ threadId, ...input }) {
      return withReadTarget(threadId, (repo) => host.call("comparePatch", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }), readFailure);
    },

    diffWorkingTree({ threadId, ...input }) {
      return withReadTarget(threadId, (repo) => host.call("diffWorkingTree", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }), readFailure);
    },

    diffWorkingTreePatch({ threadId, ...input }) {
      return withReadTarget(threadId, (repo) => host.call("diffWorkingTreePatch", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }), readFailure);
    },

    log({ threadId, ...input }) {
      return withReadTarget(threadId, (repo) => host.call("log", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }), readFailure);
    },

    commitDetails({ threadId, sha }) {
      return withReadTarget(threadId, (repo) => host.call("commitDetails", { repoPath: repo.repoPath, sha }, { hostId: repo.hostId }), readFailure);
    },

    commitPatch({ threadId, ...input }) {
      return withReadTarget(threadId, (repo) => host.call("commitPatch", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }), readFailure);
    },

    cherryPick({ threadId, sha }) {
      return withTarget(threadId, "cherryPick", (repo) => host.call("cherryPick", { repoPath: repo.repoPath, sha }, { hostId: repo.hostId }));
    },

    revert({ threadId, sha }) {
      return withTarget(threadId, "revert", (repo) => host.call("revert", { repoPath: repo.repoPath, sha }, { hostId: repo.hostId }));
    },

    resetTo({ threadId, ...input }) {
      return withTarget(threadId, "resetTo", (repo) => host.call("resetTo", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }));
    },

    changes({ threadId }) {
      return withReadTarget(threadId, (repo) => host.call("changes", { repoPath: repo.repoPath }, { hostId: repo.hostId }), readFailure);
    },

    diffFile({ threadId, ...input }) {
      return withReadTarget(threadId, (repo) => host.call("diffFile", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }), readFailure);
    },

    stage({ threadId, paths }) {
      return withTarget(threadId, "stage", (repo) => host.call("stage", { repoPath: repo.repoPath, paths }, { hostId: repo.hostId }));
    },

    unstage({ threadId, paths }) {
      return withTarget(threadId, "unstage", (repo) => host.call("unstage", { repoPath: repo.repoPath, paths }, { hostId: repo.hostId }));
    },

    discard({ threadId, ...input }) {
      return withTarget(threadId, "discard", (repo) => host.call("discard", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }));
    },

    commit({ threadId, ...input }) {
      // The message is logged nowhere: it is the user's text, not an audit fact.
      return withJobTarget(threadId, "commit", (repo, timeoutMs) =>
        host.call("commit", { repoPath: repo.repoPath, ...input, timeoutMs }, { hostId: repo.hostId }),
      );
    },

    async favourites({ threadId }) {
      const key = await favouritesKey(threadId);
      if ("unavailable" in key) return { names: [] };
      return { names: await readFavourites(key.key) };
    },

    async favouriteRepos() {
      return { repos: await allFavourites() };
    },

    async clearFavourites({ hostId, repoRoot }) {
      // The key is rebuilt here, so the caller can only ever address a
      // favourites row of this plugin's own store.
      await bb.storage.kv.delete(favouriteKey(hostId, repoRoot));
      bb.log.info(`favourites cleared for ${hostId}:${repoRoot}`);
      bb.realtime.publish(CHANGED_CHANNEL, { hostId, reason: "favourites" });
      return { repos: await allFavourites() };
    },

    async setFavourite({ threadId, name, favourite }) {
      const key = await favouritesKey(threadId);
      if ("unavailable" in key) return { names: [] };
      const current = await readFavourites(key.key);
      const names = favourite
        ? current.includes(name)
          ? current
          : [...current, name].slice(-MAX_FAVOURITES)
        : current.filter((candidate) => candidate !== name);
      await bb.storage.kv.set(key.key, names);
      const target = await resolveTarget(threadId);
      if (!("unavailable" in target)) changes.publish(target.environmentId, "favourites");
      return { names };
    },
  });

  // -------------------------------------------------------------------------
  // Read-only surfaces: `bb vcs-widget` and one agent tool. Both go through
  // the same reader, which only ever calls the two reading host methods, so
  // no argv and no model can reach a mutation (README, "Safety model").
  // -------------------------------------------------------------------------

  const cliReader: CliReader = {
    async overview(threadId) {
      const target = await resolveTarget(threadId);
      if ("unavailable" in target) return unavailableOverview(target.unavailable);
      const result = await host.call(
        "overview",
        { repoPath: target.repoPath, recentLimit: RECENT_LIMIT },
        { hostId: target.hostId },
      );
      remember(target, result);
      return result;
    },
    log(threadId, input) {
      return withReadTarget(
        threadId,
        (repo) => host.call("log", { repoPath: repo.repoPath, ...input }, { hostId: repo.hostId }),
        readFailure,
      );
    },
  };

  bb.cli.register({
    name: CLI_NAME,
    summary: CLI_SUMMARY,
    commands: CLI_COMMANDS,
    run: (argv, ctx) => runCli(argv, ctx.threadId, cliReader),
  });

  bb.agents.registerTool({
    name: "vcs_widget_status",
    description:
      "Read the git state of this thread's worktree: the current branch and upstream, the working tree counts, the branch lists or the recent commits. Read-only — it cannot check out, commit, push or change anything.",
    instructions:
      "vcs_widget_status reads the same repository the user's VCS Widget popup shows. It cannot change git state, and neither can `bb vcs-widget`: checkout, commit, push, rebase and the rest are the human's to run from the popup, the Commit panel or the Git Log. Do not run `git` yourself to work around that unless the user asked for that change.",
    presentation: {
      label: { pending: "Reading the git state", completed: "Read the git state" },
    },
    parameters: z.object({
      section: z
        .enum(["status", "branches", "log"])
        .default("status")
        .describe("status: branch, upstream and working tree. branches: the branch lists. log: recent commits."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Rows for branches or log; defaults to 50 and 20."),
      branch: z
        .string()
        .max(MAX_BRANCH_NAME_LENGTH)
        .optional()
        .describe("log: walk this local branch instead of the current one."),
      grep: z.string().max(MAX_LOG_GREP_LENGTH).optional().describe("log: a literal substring of the commit message."),
    }),
    async execute({ section, limit, branch, grep }, { threadId }) {
      const argv = [
        section,
        ...(limit === undefined ? [] : ["--limit", String(limit)]),
        ...(branch === undefined ? [] : ["--branch", branch]),
        ...(grep === undefined ? [] : ["--grep", grep]),
      ];
      const parsed = parseCli(argv);
      if (!parsed.ok) return { content: [{ type: "text", text: parsed.message }], isError: true };
      const result = await runCommand(parsed.command, threadId, cliReader);
      const text = (result.stdout ?? result.stderr ?? "").trimEnd();
      return { content: [{ type: "text", text: text === "" ? "No output." : text }], isError: result.exitCode !== 0 };
    },
  });

  // Job progress from the host worker: relay to the app, refresh when done.
  const offJobEvent = host.experimental_onSignal("jobEvent", ({ hostId, payload }) => {
    if (disposed) return;
    const known = jobs.get(payload.jobId);
    const environmentId = known?.environmentId ?? environmentsForRepo(hostId, payload.repoRoot)[0] ?? null;
    const relay: JobRealtimePayload = { environmentId, hostId, jobId: payload.jobId, event: payload.event };
    bb.realtime.publish(JOB_CHANNEL, relay);
    if (payload.event.kind !== "finished") return;
    jobs.delete(payload.jobId);
    const reason = known?.reason ?? "job";
    const result = payload.event.result;
    bb.log.info(`${reason} job ${payload.jobId} finished: ${result.ok ? result.message : `${result.error.code}: ${result.error.message}`}`);
    for (const target of environmentId === null ? environmentsForRepo(hostId, payload.repoRoot) : [environmentId]) {
      if (result.ok) changes.afterMutation(target, reason);
      else changes.publish(target, `${reason}:failed`);
    }
  });

  function environmentsForRepo(hostId: string, repoRoot: string): string[] {
    return [...(environmentsByRepo.get(repoKey(hostId, repoRoot)) ?? [])];
  }

  // The host's file watch saw the repository change (agent, terminal, us).
  const offChanged = host.experimental_onSignal("changed", ({ hostId, payload }) => {
    if (disposed) return;
    const targets = environmentsForRepo(hostId, payload.repoRoot);
    if (targets.length === 0) {
      const everyone: ChangedPayload = { hostId, reason: payload.reason };
      bb.realtime.publish(CHANGED_CHANNEL, everyone);
      return;
    }
    for (const environmentId of targets) changes.publish(environmentId, payload.reason);
  });

  // A crashed worker may have left a mutation half-reported; tell every open
  // popup to refetch (a payload without environmentId means "everyone").
  const offWorkerExit = host.experimental_onWorkerExit(({ hostId }) => {
    bb.log.warn(`host worker on ${hostId} exited unexpectedly`);
    for (const [jobId, job] of jobs) {
      if (job.hostId !== hostId) continue;
      jobs.delete(jobId);
      const relay: JobRealtimePayload = {
        environmentId: job.environmentId,
        hostId,
        jobId,
        event: {
          kind: "finished",
          result: {
            ok: false,
            error: { code: "git_failed", message: `${VERB[job.reason] ?? job.reason} was interrupted: the host worker exited.`, hint: "Open the popup again to see the repository state." },
            overview: null,
          },
        },
      };
      bb.realtime.publish(JOB_CHANNEL, relay);
    }
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
    offJobEvent();
    offChanged();
    changes.dispose();
  });

  bb.log.info("VCS Widget loaded");
}
