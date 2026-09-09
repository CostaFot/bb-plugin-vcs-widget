// Milestone 1 mutations. Each one: validate, pre-flight, build a GitPlan,
// run it inside the call's budget, classify failures, and return a fresh
// overview when there is time left to read one.
import type { ActionResult, CheckoutTarget, GitError, Overview } from "../contracts";
import type { PullStrategy } from "../shared/constants";
import { classifyGitFailure, pluginGitError } from "../shared/git-errors";
import type { GitPhase } from "../shared/git-errors";
import { gitArgvFor, type GitPlan, type PushPlan } from "../shared/model";
import { DEADLINES_MS, MIN_OVERVIEW_MS, type Budget } from "./budget";
import { runGit, type GitRunResult } from "./git";
import { preflight, readOverview, upstreamParts, type RepoInfo } from "./repo";

const RECENT_LIMIT = 8;

export interface ActionContext {
  repo: RepoInfo;
  budget: Budget;
  signal?: AbortSignal;
}

function readOptions(context: ActionContext) {
  return { cwd: context.repo.repoRoot, timeoutMs: context.budget.deadlineFor("read"), signal: context.signal };
}

/** The overview after a mutation, or null when the budget cannot afford the read. */
export async function overviewOrNull(context: ActionContext): Promise<Overview | null> {
  const left = context.budget.remaining();
  if (left < MIN_OVERVIEW_MS) return null;
  try {
    return await readOverview(context.repo, {
      recentLimit: RECENT_LIMIT,
      signal: context.signal,
      timeoutMs: Math.min(DEADLINES_MS.read, left),
    });
  } catch {
    return null;
  }
}

async function fail(context: ActionContext, error: GitError): Promise<ActionResult> {
  return { ok: false, error, overview: await overviewOrNull(context) };
}

async function succeed(context: ActionContext, message: string): Promise<ActionResult> {
  return { ok: true, message, overview: await overviewOrNull(context) };
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
  const result = await runGit(["check-ref-format", "--branch", name], readOptions(context));
  if (result.code === 0) return null;
  return pluginGitError("invalid_ref_name", `'${name}' is not a valid branch name.`, phase, {
    stderr: result.stderr.trim() || undefined,
  });
}

async function refExists(context: ActionContext, fullRef: string): Promise<boolean> {
  const result = await runGit(["show-ref", "--verify", "--quiet", fullRef], readOptions(context));
  return result.code === 0;
}

async function listRemotes(context: ActionContext): Promise<string[]> {
  const result = await runGit(["remote"], readOptions(context));
  return result.code === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

type Head = { kind: "branch"; name: string } | { kind: "detached" } | { kind: "unborn"; name: string };

async function currentBranch(context: ActionContext): Promise<Head> {
  const symbolic = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], readOptions(context));
  if (symbolic.code !== 0) return { kind: "detached" };
  const name = symbolic.stdout.trim();
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD", "--"], readOptions(context));
  return head.code === 0 ? { kind: "branch", name } : { kind: "unborn", name };
}

interface UpstreamInfo {
  name: string;
  remote: string | null;
  branch: string | null;
  gone: boolean;
}

/** The configured upstream of a local branch, even when its ref is gone. */
async function upstreamOf(context: ActionContext, branch: string, remotes: readonly string[]): Promise<UpstreamInfo | null> {
  const result = await runGit(
    ["for-each-ref", "--format=%(upstream:short)%00%(upstream:track)", `refs/heads/${branch}`],
    readOptions(context),
  );
  if (result.code !== 0) return null;
  const [name = "", track = ""] = result.stdout.trim().split("\0");
  if (name === "") return null;
  return { name, ...upstreamParts(name, remotes), gone: track.trim() === "[gone]" };
}

async function runPlan(context: ActionContext, plan: GitPlan, kind: "mutate" | "network"): Promise<{ result: GitRunResult; deadlineMs: number }> {
  const deadlineMs = context.budget.deadlineFor(kind);
  const result = await runGit(gitArgvFor(plan), { cwd: context.repo.repoRoot, timeoutMs: deadlineMs, signal: context.signal });
  return { result, deadlineMs };
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

  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, message);
}

/**
 * A start point chosen from the popup is a branch; hand git the full ref so a
 * tag with the same name cannot make it ambiguous. Anything else (a sha, a
 * tag, revision syntax) is verified as a commit and passed as typed.
 */
async function resolveStartPoint(context: ActionContext, startPoint: string): Promise<string | null> {
  if (await refExists(context, `refs/heads/${startPoint}`)) return `refs/heads/${startPoint}`;
  if (await refExists(context, `refs/remotes/${startPoint}`)) return `refs/remotes/${startPoint}`;
  const verify = await runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${startPoint}^{commit}`],
    readOptions(context),
  );
  return verify.code === 0 ? startPoint : null;
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
  let startPoint: string | null = null;
  if (input.startPoint !== null) {
    startPoint = await resolveStartPoint(context, input.startPoint);
    if (startPoint === null) {
      return fail(context, pluginGitError("ref_not_found", `'${input.startPoint}' is not a commit, branch or tag in this repository.`, phase));
    }
  } else {
    const head = await currentBranch(context);
    if (head.kind === "unborn") {
      return fail(context, pluginGitError("ref_not_found", "The repository has no commits yet; make a first commit before branching.", phase));
    }
  }

  const plan: GitPlan = { op: "create", name: input.name, startPoint, checkout: input.checkout };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
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
  const { result, deadlineMs } = await runPlan(context, plan, "network");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
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

/** Preferred first: "Fast-forward" says more than the "Updating a..b" line before it. */
const PULL_SUMMARY_PATTERNS = [/^Already up to date/u, /^Fast-forward/u, /^Successfully rebased/u, /^Merge made/u, /^Updating /u];

const AUTOSTASH_CONFLICT = /resulted in conflicts/u;

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
  const upstream = await upstreamOf(context, head.name, await listRemotes(context));
  if (upstream === null) {
    return fail(context, pluginGitError("no_upstream", `Branch '${head.name}' has no upstream branch.`, phase));
  }
  if (upstream.gone) {
    return fail(context, pluginGitError("no_upstream", `The upstream of '${head.name}' (${upstream.name}) is gone.`, phase, {
      hint: "The remote branch was deleted. Push with 'set upstream' to recreate it, or track another branch.",
    }));
  }
  const plan: GitPlan = { op: "pull", strategy: input.strategy, autoStash: input.autoStash };
  const { result, deadlineMs } = await runPlan(context, plan, "network");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  // git exits 0 when the pull succeeded but re-applying the autostash did not.
  if (input.autoStash && AUTOSTASH_CONFLICT.test(`${result.stderr}\n${result.stdout}`)) {
    return fail(
      context,
      pluginGitError("conflict", "Updated, but re-applying your stashed changes conflicted.", phase, {
        hint: "Resolve the conflicts, then run `git stash drop`; or `git checkout -- .` and `git stash pop` later.",
        stderr: result.stderr.trim() || undefined,
      }),
    );
  }
  const lines = result.stdout.split("\n").map((candidate) => candidate.trim());
  const line = PULL_SUMMARY_PATTERNS.map((pattern) => lines.find((candidate) => pattern.test(candidate))).find(
    (candidate): candidate is string => candidate !== undefined,
  );
  return succeed(context, line ? `Update Project: ${line.replace(/\.$/u, "")}.` : `Updated ${head.name} from ${upstream.name}.`);
}

/**
 * Runs exactly the push the dialog previewed. The app derives the plan from
 * the overview it showed; the host re-derives it from git and refuses with a
 * typed error when the two disagree instead of pushing something else.
 */
export async function push(
  context: ActionContext,
  input: { remote: string; setUpstream: boolean; expectedBranch: string },
): Promise<ActionResult> {
  const phase: GitPhase = "push";
  const head = await currentBranch(context);
  if (head.kind === "detached") {
    return fail(context, pluginGitError("detached_head", "HEAD is detached; check out a branch to push.", phase));
  }
  if (head.kind === "unborn") {
    return fail(context, pluginGitError("ref_not_found", "The repository has no commits yet.", phase));
  }
  if (head.name !== input.expectedBranch) {
    return fail(
      context,
      pluginGitError("head_changed", `The current branch is now '${head.name}', not '${input.expectedBranch}'. Nothing was pushed.`, phase),
    );
  }
  const remotes = await listRemotes(context);
  if (!remotes.includes(input.remote)) {
    return fail(context, pluginGitError("no_remote", remotes.length === 0 ? "This repository has no remotes." : `Remote '${input.remote}' is not configured.`, phase));
  }

  let plan: PushPlan;
  let target: string;
  if (input.setUpstream) {
    plan = { op: "push", remote: input.remote, setUpstream: true };
    target = `${input.remote}/${head.name}`;
  } else {
    const upstream = await upstreamOf(context, head.name, remotes);
    if (upstream === null || upstream.gone || upstream.remote === null || upstream.branch === null) {
      const why = upstream === null ? "has no upstream branch" : upstream.gone ? `tracks ${upstream.name}, which is gone` : `tracks ${upstream.name}, which is not on a remote`;
      return fail(context, pluginGitError("no_upstream", `Branch '${head.name}' ${why}. Nothing was pushed.`, phase));
    }
    if (upstream.remote !== input.remote) {
      return fail(
        context,
        pluginGitError("head_changed", `'${head.name}' now tracks ${upstream.name}, not a branch on '${input.remote}'. Nothing was pushed.`, phase),
      );
    }
    plan = { op: "push", remote: upstream.remote, setUpstream: false, upstreamBranch: upstream.branch };
    target = upstream.name;
  }

  const { result, deadlineMs } = await runPlan(context, plan, "network");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  const upToDate = /Everything up-to-date/u.test(result.stderr);
  return succeed(
    context,
    upToDate
      ? `${head.name} is already up to date on ${target}.`
      : plan.setUpstream
        ? `Pushed ${head.name} to ${target} and set it as upstream.`
        : `Pushed ${head.name} to ${target}.`,
  );
}
