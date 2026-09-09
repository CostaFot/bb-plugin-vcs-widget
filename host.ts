// The plugin's host entry: bb's daemon runs this on the machine that owns the
// thread's worktree, so git always sees the real files. bb cancels a host
// call at a fixed 30 s, so every handler runs its git commands against one
// budget (host/budget.ts) and returns a typed result before that. Network
// work (fetch, pull, push) is handed to a background job instead
// (host/jobs.ts) and reports back through signals.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ActionResult, GitError, JobStart, Overview } from "./contracts";
import { hostContract, hostSignals, unavailableOverview } from "./contracts";
import type { JobKind } from "./shared/constants";
import { pluginGitError } from "./shared/git-errors";
import { gitArgvFor } from "./shared/model";
import {
  abortOperation,
  addWorktree,
  checkout,
  checkoutRevision,
  createBranch,
  deleteBranch,
  merge,
  overviewAfterJob,
  overviewOrNull,
  prepareDeleteRemoteBranch,
  prepareFetch,
  preparePull,
  preparePush,
  prepareUpdateBranch,
  rebase,
  renameBranch,
  setUpstream,
  type ActionContext,
  type PreparedJob,
} from "./host/actions";
import { createBudget, DEADLINES_MS, type Budget } from "./host/budget";
import { diffFile, discard, prepareCommit, readChanges, stage, unstage } from "./host/changes";
import { compare, comparePatch, diffWorkingTree, diffWorkingTreePatch, listTags } from "./host/compare";
import { GitSpawnError } from "./host/git";
import { cancelJob, disposeJobs, jobState, startJob } from "./host/jobs";
import { BUSY, tryAcquireRepoLock, tryWithRepoLock } from "./host/locks";
import { OverviewReadError, readOverview, resolveRepo, type RepoInfo } from "./host/repo";
import { disposeWatches, ensureWatch } from "./host/watch";

interface CallContext {
  readonly signal: AbortSignal;
  readonly lifecycle: { readonly signal: AbortSignal };
  experimental_emitSignal(signal: "jobEvent", payload: { jobId: string; repoRoot: string; event: import("./contracts").JobEvent }): Promise<void>;
  experimental_emitSignal(signal: "changed", payload: { repoRoot: string; reason: string }): Promise<void>;
  experimental_watch: Parameters<typeof ensureWatch>[1]["experimental_watch"];
  experimental_retainWorker(): { dispose(): Promise<void> };
}

function errorMessage(error: unknown): string {
  if (error instanceof GitSpawnError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function actionContext(repo: RepoInfo, budget: Budget, context: { signal: AbortSignal }): ActionContext {
  return { repo, budget, signal: context.signal };
}

async function withRepo(
  repoPath: string,
  context: { signal: AbortSignal },
  fn: (action: ActionContext) => Promise<ActionResult>,
): Promise<ActionResult> {
  const budget = createBudget();
  const resolved = await resolveRepo(repoPath, { signal: context.signal, timeoutMs: budget.deadlineFor("read") });
  if ("error" in resolved) return { ok: false, error: resolved.error, overview: null };
  const action = actionContext(resolved, budget, context);
  try {
    const outcome = await tryWithRepoLock(resolved.commonDir, () => fn(action));
    if (outcome === BUSY) {
      return {
        ok: false,
        error: pluginGitError("busy", "Another VCS action is running on this repository.", "preflight"),
        overview: await overviewOrNull(action),
      };
    }
    return outcome;
  } catch (error) {
    return {
      ok: false,
      error: pluginGitError("git_failed", errorMessage(error), "preflight"),
      overview: await overviewOrNull(action),
    };
  }
}

/** Reads without the repository lock: they never write and must work during a job. */
async function withRepoRead<T>(
  repoPath: string,
  context: { signal: AbortSignal },
  fn: (action: ActionContext) => Promise<T>,
  onError: (error: GitError) => T,
): Promise<T> {
  const budget = createBudget();
  const resolved = await resolveRepo(repoPath, { signal: context.signal, timeoutMs: budget.deadlineFor("read") });
  if ("error" in resolved) return onError(resolved.error);
  try {
    return await fn(actionContext(resolved, budget, context));
  } catch (error) {
    return onError(pluginGitError("git_failed", errorMessage(error), "read"));
  }
}

/**
 * Pre-flights under the repository lock, then hands the lock and a worker
 * lease to the job. Returns at once with the job id or a typed failure.
 */
async function startPlanJob(
  repoPath: string,
  context: CallContext,
  kind: JobKind,
  timeoutMs: number,
  prepare: (action: ActionContext) => Promise<PreparedJob | GitError>,
): Promise<JobStart> {
  const budget = createBudget();
  const resolved = await resolveRepo(repoPath, { signal: context.signal, timeoutMs: budget.deadlineFor("read") });
  if ("error" in resolved) return { ok: false, error: resolved.error, overview: null };
  const action = actionContext(resolved, budget, context);
  const release = tryAcquireRepoLock(resolved.commonDir);
  if (release === null) {
    return {
      ok: false,
      error: pluginGitError("busy", "Another VCS action is running on this repository.", "preflight"),
      overview: await overviewOrNull(action),
    };
  }
  let job: PreparedJob | GitError;
  try {
    job = await prepare(action);
  } catch (error) {
    release();
    return { ok: false, error: pluginGitError("git_failed", errorMessage(error), "preflight"), overview: await overviewOrNull(action) };
  }
  if (!("plan" in job)) {
    release();
    return { ok: false, error: job, overview: await overviewOrNull(action) };
  }
  const repo = resolved;
  const summary = startJob({
    kind,
    repoRoot: repo.repoRoot,
    commonDir: repo.commonDir,
    cwd: repo.repoRoot,
    argv: gitArgvFor(job.plan),
    command: job.command,
    ...(job.stdin === undefined ? {} : { stdin: job.stdin }),
    timeoutMs,
    lifecycleSignal: context.lifecycle.signal,
    retainWorker: () => context.experimental_retainWorker(),
    emit: (jobId, event) => context.experimental_emitSignal("jobEvent", { jobId, repoRoot: repo.repoRoot, event }),
    releaseLock: release,
    finish: async (run) => {
      const outcome = job.outcome(run);
      const overview = await overviewAfterJob(repo, context.lifecycle.signal);
      return outcome.ok ? { ok: true, message: outcome.message, overview } : { ok: false, error: outcome.error, overview };
    },
  });
  return { ok: true, ...summary };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async overview({ repoPath, recentLimit }, context): Promise<Overview> {
      const budget = createBudget();
      const resolved = await resolveRepo(repoPath, { signal: context.signal, timeoutMs: budget.deadlineFor("read") });
      if ("error" in resolved) return unavailableOverview(resolved.error.message);
      ensureWatch(resolved, context, (repoRoot, reason) => context.experimental_emitSignal("changed", { repoRoot, reason }));
      try {
        return await readOverview(resolved, {
          recentLimit,
          signal: context.signal,
          timeoutMs: Math.min(DEADLINES_MS.read, budget.remaining()),
        });
      } catch (error) {
        if (error instanceof OverviewReadError) return unavailableOverview(error.gitError.message);
        return unavailableOverview(errorMessage(error));
      }
    },
    checkout({ repoPath, target }, context) {
      return withRepo(repoPath, context, (action) => checkout(action, target));
    },
    createBranch({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => createBranch(action, input));
    },
    fetch({ repoPath, timeoutMs, ...input }, context) {
      return startPlanJob(repoPath, context, "fetch", timeoutMs, (action) => prepareFetch(action, { ...input, timeoutMs }));
    },
    pull({ repoPath, timeoutMs, ...input }, context) {
      return startPlanJob(repoPath, context, "pull", timeoutMs, (action) => preparePull(action, { ...input, timeoutMs }));
    },
    push({ repoPath, timeoutMs, ...input }, context) {
      return startPlanJob(repoPath, context, "push", timeoutMs, (action) => preparePush(action, { ...input, timeoutMs }));
    },
    updateBranch({ repoPath, timeoutMs, ...input }, context) {
      return startPlanJob(repoPath, context, "updateBranch", timeoutMs, (action) => prepareUpdateBranch(action, { ...input, timeoutMs }));
    },
    deleteRemoteBranch({ repoPath, timeoutMs, ...input }, context) {
      return startPlanJob(repoPath, context, "deleteRemoteBranch", timeoutMs, (action) => prepareDeleteRemoteBranch(action, { ...input, timeoutMs }));
    },
    jobGet({ jobId }) {
      return jobState(jobId);
    },
    jobCancel({ jobId }) {
      return { cancelled: cancelJob(jobId) };
    },
    deleteBranch({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => deleteBranch(action, input));
    },
    renameBranch({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => renameBranch(action, input));
    },
    merge({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => merge(action, input));
    },
    rebase({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => rebase(action, input));
    },
    abortOperation({ repoPath }, context) {
      return withRepo(repoPath, context, (action) => abortOperation(action));
    },
    setUpstream({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => setUpstream(action, input));
    },
    addWorktree({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => addWorktree(action, input));
    },
    checkoutRevision({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => checkoutRevision(action, input));
    },
    listTags({ repoPath }, context) {
      return withRepoRead(repoPath, context, (action) => listTags(action), (error) => ({ ok: false, error }));
    },
    compare({ repoPath, ...input }, context) {
      return withRepoRead(repoPath, context, (action) => compare(action, input), (error) => ({ ok: false, error }));
    },
    comparePatch({ repoPath, ...input }, context) {
      return withRepoRead(repoPath, context, (action) => comparePatch(action, input), (error) => ({ ok: false, error }));
    },
    diffWorkingTree({ repoPath, ...input }, context) {
      return withRepoRead(repoPath, context, (action) => diffWorkingTree(action, input), (error) => ({ ok: false, error }));
    },
    diffWorkingTreePatch({ repoPath, ...input }, context) {
      return withRepoRead(repoPath, context, (action) => diffWorkingTreePatch(action, input), (error) => ({ ok: false, error }));
    },
    changes({ repoPath }, context) {
      return withRepoRead(repoPath, context, (action) => readChanges(action), (error) => ({ ok: false, error }));
    },
    diffFile({ repoPath, ...input }, context) {
      return withRepoRead(repoPath, context, (action) => diffFile(action, input), (error) => ({ ok: false, error }));
    },
    stage({ repoPath, paths }, context) {
      return withRepo(repoPath, context, (action) => stage(action, paths));
    },
    unstage({ repoPath, paths }, context) {
      return withRepo(repoPath, context, (action) => unstage(action, paths));
    },
    discard({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => discard(action, input));
    },
    commit({ repoPath, timeoutMs, ...input }, context) {
      return startPlanJob(repoPath, context, "commit", timeoutMs, (action) => prepareCommit(action, { ...input, timeoutMs }));
    },
  },
  async dispose() {
    await Promise.allSettled([disposeJobs(), disposeWatches()]);
  },
});
