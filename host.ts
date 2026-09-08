// The plugin's host entry: bb's daemon runs this on the machine that owns the
// thread's worktree, so git always sees the real files. Every handler must
// finish inside bb's fixed 30 s host-call cap; host/git.ts enforces shorter
// per-command deadlines.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ActionResult, Overview } from "./contracts";
import { hostContract, unavailableOverview } from "./contracts";
import { pluginGitError } from "./shared/git-errors";
import { checkout, createBranch, fetch, pull, push, type ActionContext } from "./host/actions";
import { GitSpawnError } from "./host/git";
import { BUSY, tryWithRepoLock } from "./host/locks";
import { OverviewReadError, readOverview, resolveRepo, type RepoInfo } from "./host/repo";

interface CallContext {
  readonly signal: AbortSignal;
}

async function withRepo(
  repoPath: string,
  context: CallContext,
  fn: (repo: RepoInfo) => Promise<ActionResult>,
): Promise<ActionResult> {
  const resolved = await resolveRepo(repoPath, context.signal);
  if ("error" in resolved) return { ok: false, error: resolved.error, overview: null };
  try {
    const outcome = await tryWithRepoLock(resolved.commonDir, () => fn(resolved));
    if (outcome === BUSY) {
      return {
        ok: false,
        error: pluginGitError("busy", "Another VCS action is running on this repository.", "preflight"),
        overview: await safeOverview(resolved, context),
      };
    }
    return outcome;
  } catch (error) {
    return {
      ok: false,
      error: pluginGitError("git_failed", errorMessage(error), "preflight"),
      overview: await safeOverview(resolved, context),
    };
  }
}

async function safeOverview(repo: RepoInfo, context: CallContext): Promise<Overview | null> {
  try {
    return await readOverview(repo, { recentLimit: 8, signal: context.signal });
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof GitSpawnError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function actionContext(repo: RepoInfo, context: CallContext): ActionContext {
  return { repo, signal: context.signal };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async overview({ repoPath, recentLimit }, context) {
      const resolved = await resolveRepo(repoPath, context.signal);
      if ("error" in resolved) return unavailableOverview(resolved.error.message);
      try {
        return await readOverview(resolved, { recentLimit, signal: context.signal });
      } catch (error) {
        if (error instanceof OverviewReadError) return unavailableOverview(error.gitError.message);
        return unavailableOverview(errorMessage(error));
      }
    },
    checkout({ repoPath, target }, context) {
      return withRepo(repoPath, context, (repo) => checkout(actionContext(repo, context), target));
    },
    createBranch({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (repo) => createBranch(actionContext(repo, context), input));
    },
    fetch({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (repo) => fetch(actionContext(repo, context), input));
    },
    pull({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (repo) => pull(actionContext(repo, context), input));
    },
    push({ repoPath, ...input }, context) {
      return withRepo(repoPath, context, (repo) => push(actionContext(repo, context), input));
    },
  },
});
