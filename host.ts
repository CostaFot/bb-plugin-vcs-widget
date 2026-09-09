// The plugin's host entry: bb's daemon runs this on the machine that owns the
// thread's worktree, so git always sees the real files. bb cancels a host
// call at a fixed 30 s, so every handler runs its git commands against one
// budget (host/budget.ts) and returns a typed result before that.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ActionResult, Overview } from "./contracts";
import { hostContract, unavailableOverview } from "./contracts";
import { pluginGitError } from "./shared/git-errors";
import { checkout, createBranch, fetch, overviewOrNull, pull, push, type ActionContext } from "./host/actions";
import { createBudget, DEADLINES_MS, type Budget } from "./host/budget";
import { GitSpawnError } from "./host/git";
import { BUSY, tryWithRepoLock } from "./host/locks";
import { OverviewReadError, readOverview, resolveRepo, type RepoInfo } from "./host/repo";

interface CallContext {
  readonly signal: AbortSignal;
}

async function withRepo(
  repoPath: string,
  context: CallContext,
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

function errorMessage(error: unknown): string {
  if (error instanceof GitSpawnError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function actionContext(repo: RepoInfo, budget: Budget, context: CallContext): ActionContext {
  return { repo, budget, signal: context.signal };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async overview({ repoPath, recentLimit }, context): Promise<Overview> {
      const budget = createBudget();
      const resolved = await resolveRepo(repoPath, { signal: context.signal, timeoutMs: budget.deadlineFor("read") });
      if ("error" in resolved) return unavailableOverview(resolved.error.message);
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
    fetch({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => fetch(action, input));
    },
    pull({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => pull(action, input));
    },
    push({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (action) => push(action, input));
    },
  },
});
