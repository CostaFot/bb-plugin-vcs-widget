// Milestone 1 mutations. Each one: validate, pre-flight, build a GitPlan,
// run it under a deadline, classify failures, and return a fresh overview.
import type { ActionResult, CheckoutTarget, GitError, Overview, PullStrategy } from "../contracts";
import { classifyGitFailure, pluginGitError } from "../shared/git-errors";
import type { GitPhase } from "../shared/git-errors";
import { gitArgvFor, type GitPlan } from "../shared/model";
import { DEADLINES_MS, runGit, type GitRunResult } from "./git";
import { preflight, readOverview, type RepoInfo } from "./repo";

const RECENT_LIMIT = 8;

export interface ActionContext {
  repo: RepoInfo;
  signal?: AbortSignal;
}

async function overviewOrNull(context: ActionContext): Promise<Overview | null> {
  try {
    return await readOverview(context.repo, { recentLimit: RECENT_LIMIT, signal: context.signal });
  } catch {
    return null;
  }
}

async function fail(context: ActionContext, error: GitError): Promise<ActionResult> {
  return { ok: false, error, overview: await overviewOrNull(context) };
}

async function succeed(context: ActionContext, message: string): Promise<ActionResult> {
  const overview = await overviewOrNull(context);
  if (overview === null) {
    return fail(context, pluginGitError("git_failed", `${message} Reading the repository afterwards failed.`, "read"));
  }
  return { ok: true, message, overview };
}

function failureFrom(phase: GitPhase, result: GitRunResult, deadlineMs: number): GitError {
  return classifyGitFailure({
    phase,
    exitCode: result.code,
    stderr: result.stderr,
    stdout: result.stdout,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    deadlineSeconds: Math.round(deadlineMs / 1000),
  });
}

async function checkRefFormat(context: ActionContext, name: string, phase: GitPhase): Promise<GitError | null> {
  const result = await runGit(["check-ref-format", "--branch", name], {
    cwd: context.repo.repoRoot,
    timeoutMs: DEADLINES_MS.read,
    signal: context.signal,
  });
  if (result.code === 0) return null;
  return pluginGitError("invalid_ref_name", `'${name}' is not a valid branch name.`, phase, {
    stderr: result.stderr.trim() || undefined,
  });
}

async function refExists(context: ActionContext, fullRef: string): Promise<boolean> {
  const result = await runGit(["show-ref", "--verify", "--quiet", fullRef], {
    cwd: context.repo.repoRoot,
    timeoutMs: DEADLINES_MS.read,
    signal: context.signal,
  });
  return result.code === 0;
}

async function listRemotes(context: ActionContext): Promise<string[]> {
  const result = await runGit(["remote"], { cwd: context.repo.repoRoot, timeoutMs: DEADLINES_MS.read, signal: context.signal });
  return result.code === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

async function currentBranch(context: ActionContext): Promise<{ kind: "branch"; name: string } | { kind: "detached" } | { kind: "unborn"; name: string }> {
  const symbolic = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: context.repo.repoRoot, timeoutMs: DEADLINES_MS.read, signal: context.signal });
  if (symbolic.code !== 0) return { kind: "detached" };
  const name = symbolic.stdout.trim();
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: context.repo.repoRoot, timeoutMs: DEADLINES_MS.read, signal: context.signal });
  return head.code === 0 ? { kind: "branch", name } : { kind: "unborn", name };
}

async function upstreamOf(context: ActionContext): Promise<string | null> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    cwd: context.repo.repoRoot,
    timeoutMs: DEADLINES_MS.read,
    signal: context.signal,
  });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function runPlan(context: ActionContext, plan: GitPlan, deadlineMs: number): Promise<GitRunResult> {
  return runGit(gitArgvFor(plan), { cwd: context.repo.repoRoot, timeoutMs: deadlineMs, signal: context.signal });
}

// ---------------------------------------------------------------------------

export async function checkout(context: ActionContext, target: CheckoutTarget): Promise<ActionResult> {
  const phase: GitPhase = "checkout";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);

  const branch = target.kind === "local" ? target.name : target.branch;
  const invalid = await checkRefFormat(context, branch, phase);
  if (invalid) return fail(context, invalid);

  let plan: GitPlan;
  let message: string;
  if (target.kind === "local") {
    if (!(await refExists(context, `refs/heads/${branch}`))) {
      return fail(context, pluginGitError("ref_not_found", `Branch '${branch}' does not exist.`, phase));
    }
    plan = { op: "switch", name: branch };
    message = `Switched to ${branch}.`;
  } else {
    if (!(await refExists(context, `refs/remotes/${target.remote}/${branch}`))) {
      return fail(context, pluginGitError("ref_not_found", `Remote branch '${target.remote}/${branch}' does not exist locally. Fetch first.`, phase));
    }
    if (await refExists(context, `refs/heads/${branch}`)) {
      // IntelliJ behaviour: a remote branch with a local counterpart switches
      // to the local branch instead of failing.
      plan = { op: "switch", name: branch };
      message = `Switched to the existing local branch ${branch}.`;
    } else {
      plan = { op: "switch-track", remote: target.remote, branch };
      message = `Switched to ${branch} (tracking ${target.remote}/${branch}).`;
    }
  }

  const result = await runPlan(context, plan, DEADLINES_MS.mutate);
  if (result.code !== 0) return fail(context, failureFrom(phase, result, DEADLINES_MS.mutate));
  return succeed(context, message);
}

export async function createBranch(
  context: ActionContext,
  input: { name: string; startPoint: string | null; checkout: boolean },
): Promise<ActionResult> {
  const phase: GitPhase = "createBranch";
  if (input.checkout) {
    const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
    if (blocked) return fail(context, blocked);
  }
  const invalid = await checkRefFormat(context, input.name, phase);
  if (invalid) return fail(context, invalid);
  if (await refExists(context, `refs/heads/${input.name}`)) {
    return fail(context, pluginGitError("ref_exists", `A branch named '${input.name}' already exists.`, phase));
  }
  if (input.startPoint !== null) {
    const verify = await runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.startPoint}^{commit}`], {
      cwd: context.repo.repoRoot,
      timeoutMs: DEADLINES_MS.read,
      signal: context.signal,
    });
    if (verify.code !== 0) {
      return fail(context, pluginGitError("ref_not_found", `'${input.startPoint}' is not a commit, branch or tag in this repository.`, phase));
    }
  } else {
    const head = await currentBranch(context);
    if (head.kind === "unborn") {
      return fail(context, pluginGitError("ref_not_found", "The repository has no commits yet; make a first commit before branching.", phase));
    }
  }

  const plan: GitPlan = { op: "create", name: input.name, startPoint: input.startPoint, checkout: input.checkout };
  const result = await runPlan(context, plan, DEADLINES_MS.mutate);
  if (result.code !== 0) return fail(context, failureFrom(phase, result, DEADLINES_MS.mutate));
  const from = input.startPoint === null ? "" : ` from ${input.startPoint}`;
  return succeed(context, input.checkout ? `Created ${input.name}${from} and switched to it.` : `Created ${input.name}${from}.`);
}

export async function fetch(
  context: ActionContext,
  input: { remote: string | null; prune: boolean },
): Promise<ActionResult> {
  const phase: GitPhase = "fetch";
  const remotes = await listRemotes(context);
  if (remotes.length === 0) {
    return fail(context, pluginGitError("no_remote", "This repository has no remotes.", phase));
  }
  if (input.remote !== null && !remotes.includes(input.remote)) {
    return fail(context, pluginGitError("no_remote", `Remote '${input.remote}' is not configured.`, phase));
  }
  const plan: GitPlan = { op: "fetch", remote: input.remote, prune: input.prune };
  const result = await runPlan(context, plan, DEADLINES_MS.network);
  if (result.code !== 0) return fail(context, failureFrom(phase, result, DEADLINES_MS.network));
  const summary = summarizeFetch(result.stderr);
  return succeed(context, summary ?? `Fetched ${input.remote ?? "all remotes"}; already up to date.`);
}

function summarizeFetch(stderr: string): string | null {
  const updates = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[ *+!=-]?\s*\[?(?:new branch|new tag|forced update|deleted)|->/u.test(line) && !line.startsWith("From "));
  if (updates.length === 0) return null;
  const shown = updates.slice(0, 3).join("; ");
  return updates.length > 3 ? `Fetched: ${shown} and ${updates.length - 3} more.` : `Fetched: ${shown}.`;
}

export async function pull(
  context: ActionContext,
  input: { strategy: PullStrategy; autoStash: boolean },
): Promise<ActionResult> {
  const phase: GitPhase = "pull";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);
  const head = await currentBranch(context);
  if (head.kind === "detached") {
    return fail(context, pluginGitError("detached_head", "HEAD is detached; Update Project needs a branch.", phase));
  }
  if (head.kind === "unborn") {
    return fail(context, pluginGitError("ref_not_found", "The repository has no commits yet.", phase));
  }
  const upstream = await upstreamOf(context);
  if (upstream === null) {
    return fail(context, pluginGitError("no_upstream", `Branch '${head.name}' has no upstream branch.`, phase));
  }
  const plan: GitPlan = { op: "pull", strategy: input.strategy, autoStash: input.autoStash };
  const result = await runPlan(context, plan, DEADLINES_MS.network);
  if (result.code !== 0) return fail(context, failureFrom(phase, result, DEADLINES_MS.network));
  const line = result.stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => /Already up to date|Fast-forward|Successfully rebased|Merge made|Updating/u.test(candidate));
  return succeed(context, line ? `Update Project: ${line.replace(/\.$/u, "")}.` : `Updated ${head.name} from ${upstream}.`);
}

export async function push(
  context: ActionContext,
  input: { remote: string; setUpstream: boolean },
): Promise<ActionResult> {
  const phase: GitPhase = "push";
  const head = await currentBranch(context);
  if (head.kind === "detached") {
    return fail(context, pluginGitError("detached_head", "HEAD is detached; check out a branch to push.", phase));
  }
  if (head.kind === "unborn") {
    return fail(context, pluginGitError("ref_not_found", "The repository has no commits yet.", phase));
  }
  const remotes = await listRemotes(context);
  if (!remotes.includes(input.remote)) {
    return fail(context, pluginGitError("no_remote", remotes.length === 0 ? "This repository has no remotes." : `Remote '${input.remote}' is not configured.`, phase));
  }
  const upstream = await upstreamOf(context);
  const setUpstream = input.setUpstream || upstream === null;
  const plan: GitPlan = { op: "push", remote: input.remote, setUpstream };
  const result = await runPlan(context, plan, DEADLINES_MS.network);
  if (result.code !== 0) return fail(context, failureFrom(phase, result, DEADLINES_MS.network));
  const upToDate = /Everything up-to-date/u.test(result.stderr);
  const target = setUpstream ? `${input.remote}/${head.name}` : (upstream ?? input.remote);
  return succeed(
    context,
    upToDate
      ? `${head.name} is already up to date on ${target}.`
      : setUpstream
        ? `Pushed ${head.name} to ${target} and set it as upstream.`
        : `Pushed ${head.name} to ${target}.`,
  );
}
