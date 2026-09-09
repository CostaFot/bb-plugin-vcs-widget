// Mutations. Each one: validate, pre-flight, build a GitPlan, run it inside
// the call's budget (or hand it to a background job), classify failures, and
// return a fresh overview when there is time left to read one.
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ActionResult, BranchRef, CheckoutTarget, GitError, Operation, Overview } from "../contracts";
import type { PullStrategy, ResetMode } from "../shared/constants";
import { classifyGitFailure, pluginGitError } from "../shared/git-errors";
import type { GitPhase } from "../shared/git-errors";
import { fullRef, gitArgvFor, gitCommandPreview, refLabel, type GitPlan, type PushPlan } from "../shared/model";
import { DEADLINES_MS, MIN_OVERVIEW_MS, createBudget, type Budget } from "./budget";
import { runGit, type GitRunResult } from "./git";
import { parseCommitSummary } from "../shared/parse";
import { detectOperation, preflight, readOverview, upstreamParts, type RepoInfo } from "./repo";

const RECENT_LIMIT = 8;

export interface ActionContext {
  repo: RepoInfo;
  budget: Budget;
  signal?: AbortSignal;
}

export function readOptions(context: ActionContext) {
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

/** An overview read on a fresh budget, for a job that finished outside any call. */
export async function overviewAfterJob(repo: RepoInfo, signal?: AbortSignal): Promise<Overview | null> {
  return overviewOrNull({ repo, budget: createBudget(), signal });
}

export async function fail(context: ActionContext, error: GitError): Promise<ActionResult> {
  return { ok: false, error, overview: await overviewOrNull(context) };
}

export async function succeed(context: ActionContext, message: string): Promise<ActionResult> {
  return { ok: true, message, overview: await overviewOrNull(context) };
}

export function failureFrom(phase: GitPhase, result: GitRunResult, deadlineMs: number): GitError {
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

async function refExists(context: ActionContext, fullRefName: string): Promise<boolean> {
  const result = await runGit(["show-ref", "--verify", "--quiet", fullRefName], readOptions(context));
  return result.code === 0;
}

async function refSha(context: ActionContext, fullRefName: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", fullRefName], readOptions(context));
  return result.code === 0 ? result.stdout.trim() : null;
}

async function listRemotes(context: ActionContext): Promise<string[]> {
  const result = await runGit(["remote"], readOptions(context));
  return result.code === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

type Head = { kind: "branch"; name: string } | { kind: "detached" } | { kind: "unborn"; name: string };

export async function currentBranch(context: ActionContext): Promise<Head> {
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

/** The worktree a branch is checked out in, other than this one; null when none. */
async function otherWorktreeOf(context: ActionContext, branch: string): Promise<string | null> {
  const result = await runGit(["for-each-ref", "--format=%(worktreepath)", `refs/heads/${branch}`], readOptions(context));
  const path = result.stdout.trim();
  if (result.code !== 0 || path === "") return null;
  return resolve(path) === resolve(context.repo.repoRoot) ? null : path;
}

export async function runPlan(context: ActionContext, plan: GitPlan, kind: "mutate" | "network"): Promise<{ result: GitRunResult; deadlineMs: number }> {
  const deadlineMs = context.budget.deadlineFor(kind);
  const result = await runGit(gitArgvFor(plan), { cwd: context.repo.repoRoot, timeoutMs: deadlineMs, signal: context.signal });
  return { result, deadlineMs };
}

/** Requires HEAD on a branch with at least one commit. */
async function requireBranch(context: ActionContext, phase: GitPhase, verb: string): Promise<{ name: string } | GitError> {
  const head = await currentBranch(context);
  if (head.kind === "detached") return pluginGitError("detached_head", `HEAD is detached; ${verb} needs a branch.`, phase);
  if (head.kind === "unborn") return pluginGitError("ref_not_found", "The repository has no commits yet.", phase);
  return { name: head.name };
}

/** Verifies a popup entry still exists and returns its full ref. */
async function resolveBranchRef(context: ActionContext, ref: BranchRef, phase: GitPhase): Promise<string | GitError> {
  const name = ref.kind === "local" ? ref.name : ref.branch;
  const invalid = await checkRefFormat(context, name, phase);
  if (invalid) return invalid;
  const full = fullRef(ref);
  if (!(await refExists(context, full))) {
    return pluginGitError("ref_not_found", `Branch '${refLabel(ref)}' does not exist${ref.kind === "remote" ? " locally. Fetch first" : ""}.`, phase);
  }
  return full;
}

const isError = (value: unknown): value is GitError =>
  typeof value === "object" && value !== null && "code" in value && "message" in value;

// ---------------------------------------------------------------------------
// Synchronous mutations
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

export async function deleteBranch(context: ActionContext, input: { name: string; force: boolean }): Promise<ActionResult> {
  const phase: GitPhase = "deleteBranch";
  const invalid = await checkRefFormat(context, input.name, phase);
  if (invalid) return fail(context, invalid);
  if (!(await refExists(context, `refs/heads/${input.name}`))) {
    return fail(context, pluginGitError("ref_not_found", `Branch '${input.name}' does not exist.`, phase));
  }
  const head = await currentBranch(context);
  if (head.kind !== "detached" && head.name === input.name) {
    return fail(context, pluginGitError("busy", `'${input.name}' is the current branch; check out another branch first.`, phase, { hint: "Git cannot delete the branch that is checked out." }));
  }
  const elsewhere = await otherWorktreeOf(context, input.name);
  if (elsewhere !== null) {
    return fail(context, pluginGitError("path_exists", `'${input.name}' is checked out in another worktree (${elsewhere}).`, phase, { hint: "Remove that worktree first." }));
  }
  const plan: GitPlan = { op: "delete-local", name: input.name, force: input.force };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Deleted ${input.name}.`);
}

export async function renameBranch(context: ActionContext, input: { from: string; to: string }): Promise<ActionResult> {
  const phase: GitPhase = "renameBranch";
  for (const name of [input.from, input.to]) {
    const invalid = await checkRefFormat(context, name, phase);
    if (invalid) return fail(context, invalid);
  }
  if (!(await refExists(context, `refs/heads/${input.from}`))) {
    return fail(context, pluginGitError("ref_not_found", `Branch '${input.from}' does not exist.`, phase));
  }
  if (input.from !== input.to && (await refExists(context, `refs/heads/${input.to}`))) {
    return fail(context, pluginGitError("ref_exists", `A branch named '${input.to}' already exists.`, phase));
  }
  const plan: GitPlan = { op: "rename", from: input.from, to: input.to };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Renamed ${input.from} to ${input.to}.`);
}

/** Preferred first: "Fast-forward" says more than the "Updating a..b" line before it. */
const MERGE_SUMMARY_PATTERNS = [/^Already up to date/u, /^Fast-forward/u, /^Merge made/u, /^Successfully rebased/u, /^Updating /u];

function summaryLine(stdout: string, stderr: string): string | null {
  const lines = `${stdout}\n${stderr}`.split("\n").map((candidate) => candidate.trim());
  return (
    MERGE_SUMMARY_PATTERNS.map((pattern) => lines.find((candidate) => pattern.test(candidate))).find(
      (candidate): candidate is string => candidate !== undefined,
    ) ?? null
  );
}

export async function merge(context: ActionContext, input: { ref: BranchRef }): Promise<ActionResult> {
  const phase: GitPhase = "merge";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);
  const head = await requireBranch(context, phase, "a merge");
  if (isError(head)) return fail(context, head);
  const full = await resolveBranchRef(context, input.ref, phase);
  if (isError(full)) return fail(context, full);
  const plan: GitPlan = { op: "merge", ref: full };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  const line = summaryLine(result.stdout, result.stderr);
  return succeed(context, `Merged ${refLabel(input.ref)} into ${head.name}${line ? `: ${line.replace(/\.$/u, "")}` : ""}.`);
}

export async function rebase(
  context: ActionContext,
  input: { onto: BranchRef; checkoutFirst: BranchRef | null },
): Promise<ActionResult> {
  const phase: GitPhase = "rebase";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);
  const onto = await resolveBranchRef(context, input.onto, phase);
  if (isError(onto)) return fail(context, onto);
  let rebased: string;
  if (input.checkoutFirst !== null) {
    const switched = await checkout(context, input.checkoutFirst);
    if (!switched.ok) return switched;
    rebased = refLabel(input.checkoutFirst);
    const now = await currentBranch(context);
    if (now.kind === "branch") rebased = now.name;
  } else {
    const head = await requireBranch(context, phase, "a rebase");
    if (isError(head)) return fail(context, head);
    rebased = head.name;
  }
  const plan: GitPlan = { op: "rebase", onto };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  const line = summaryLine(result.stdout, result.stderr);
  const upToDate = /is up to date/u.test(`${result.stdout}\n${result.stderr}`);
  return succeed(context, upToDate ? `${rebased} is already up to date with ${refLabel(input.onto)}.` : `Rebased ${rebased} onto ${refLabel(input.onto)}${line ? `: ${line.replace(/\.$/u, "")}` : ""}.`);
}

export async function abortOperation(context: ActionContext): Promise<ActionResult> {
  const phase: GitPhase = "abort";
  const operation: Operation = await detectOperation(context.repo.gitDir);
  if (operation === "none") {
    return fail(context, pluginGitError("git_failed", "No merge, rebase, cherry-pick or revert is in progress.", phase));
  }
  const plan: GitPlan = { op: "abort", operation };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Aborted the ${operation}.`);
}

export async function setUpstream(
  context: ActionContext,
  input: { branch: string; upstream: { remote: string; branch: string } | null },
): Promise<ActionResult> {
  const phase: GitPhase = "setUpstream";
  const invalid = await checkRefFormat(context, input.branch, phase);
  if (invalid) return fail(context, invalid);
  if (!(await refExists(context, `refs/heads/${input.branch}`))) {
    return fail(context, pluginGitError("ref_not_found", `Branch '${input.branch}' does not exist.`, phase));
  }
  let upstream: string | null = null;
  if (input.upstream !== null) {
    upstream = `${input.upstream.remote}/${input.upstream.branch}`;
    if (!(await refExists(context, `refs/remotes/${upstream}`))) {
      return fail(context, pluginGitError("ref_not_found", `Remote branch '${upstream}' does not exist locally. Fetch first.`, phase));
    }
  } else if ((await upstreamOf(context, input.branch, await listRemotes(context))) === null) {
    return succeed(context, `${input.branch} tracks no branch.`);
  }
  const plan: GitPlan = { op: "set-upstream", branch: input.branch, upstream };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, upstream === null ? `${input.branch} no longer tracks a branch.` : `${input.branch} now tracks ${upstream}.`);
}

export async function addWorktree(context: ActionContext, input: { ref: BranchRef; path: string }): Promise<ActionResult> {
  const phase: GitPhase = "worktree";
  if (!isAbsolute(input.path) || resolve(dirname(input.path)) !== resolve(dirname(context.repo.repoRoot)) || resolve(input.path) === resolve(context.repo.repoRoot)) {
    return fail(context, pluginGitError("git_failed", "The worktree directory must be a sibling of the repository.", phase));
  }
  try {
    await stat(input.path);
    return fail(context, pluginGitError("path_exists", `${input.path} already exists.`, phase));
  } catch {
    // Expected: the directory does not exist yet.
  }
  const full = await resolveBranchRef(context, input.ref, phase);
  if (isError(full)) return fail(context, full);
  let plan: GitPlan;
  let message: string;
  if (input.ref.kind === "local") {
    const elsewhere = await otherWorktreeOf(context, input.ref.name);
    if (elsewhere !== null) {
      return fail(context, pluginGitError("path_exists", `'${input.ref.name}' is already checked out in ${elsewhere}.`, phase));
    }
    plan = { op: "worktree-add", path: input.path, branch: input.ref.name };
    message = `Added worktree ${input.path} on ${input.ref.name}.`;
  } else {
    if (await refExists(context, `refs/heads/${input.ref.branch}`)) {
      return fail(context, pluginGitError("ref_exists", `A local branch named '${input.ref.branch}' already exists; add the worktree from it instead.`, phase));
    }
    plan = { op: "worktree-add-track", path: input.path, remote: input.ref.remote, branch: input.ref.branch };
    message = `Added worktree ${input.path} on ${input.ref.branch} (tracking ${refLabel(input.ref)}).`;
  }
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, message);
}

export async function checkoutRevision(context: ActionContext, input: { revision: string }): Promise<ActionResult> {
  const phase: GitPhase = "checkoutRevision";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);
  const verify = await runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.revision}^{commit}`],
    readOptions(context),
  );
  if (verify.code !== 0) {
    return fail(context, pluginGitError("ref_not_found", `'${input.revision}' is not a commit, branch or tag in this repository.`, phase));
  }
  const plan: GitPlan = { op: "switch-detach", revision: input.revision };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Checked out ${input.revision} (detached HEAD at ${verify.stdout.trim().slice(0, 7)}).`);
}

// ---------------------------------------------------------------------------
// Log actions: they name the sha the row showed, never a branch name that
// could have moved since. Conflicts leave a cherry-pick or revert in
// progress, which the popup's Abort concludes.
// ---------------------------------------------------------------------------

/** The commit a log row stands for, resolved to its full object name. */
async function resolveCommit(context: ActionContext, sha: string, phase: GitPhase): Promise<string | GitError> {
  const result = await runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`, "--"],
    readOptions(context),
  );
  const resolved = result.stdout.trim();
  if (result.code !== 0 || resolved === "") {
    return pluginGitError("ref_not_found", `'${sha}' is not a commit in this repository.`, phase, {
      hint: "The log may be out of date; refresh it.",
    });
  }
  return resolved;
}

const shortSha = (sha: string) => sha.slice(0, 7);

export async function cherryPick(context: ActionContext, input: { sha: string }): Promise<ActionResult> {
  const phase: GitPhase = "cherryPick";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);
  const sha = await resolveCommit(context, input.sha, phase);
  if (isError(sha)) return fail(context, sha);
  const plan: GitPlan = { op: "cherry-pick", sha };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  const line = parseCommitSummary(result.stdout);
  return succeed(context, line ? `Cherry-picked ${shortSha(sha)} as ${line.sha}: ${line.subject}` : `Cherry-picked ${shortSha(sha)}.`);
}

export async function revert(context: ActionContext, input: { sha: string }): Promise<ActionResult> {
  const phase: GitPhase = "revert";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);
  const sha = await resolveCommit(context, input.sha, phase);
  if (isError(sha)) return fail(context, sha);
  const plan: GitPlan = { op: "revert", sha };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  const line = parseCommitSummary(result.stdout);
  return succeed(context, line ? `Reverted ${shortSha(sha)} in ${line.sha}: ${line.subject}` : `Reverted ${shortSha(sha)}.`);
}

export async function resetTo(context: ActionContext, input: { sha: string; mode: ResetMode }): Promise<ActionResult> {
  const phase: GitPhase = "reset";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return fail(context, blocked);
  const head = await requireBranch(context, phase, "a reset");
  if (isError(head)) return fail(context, head);
  const sha = await resolveCommit(context, input.sha, phase);
  if (isError(sha)) return fail(context, sha);
  const plan: GitPlan = { op: "reset", mode: input.mode, sha };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Reset ${head.name} to ${shortSha(sha)} (--${input.mode}).`);
}

// ---------------------------------------------------------------------------
// Jobs: pre-flight now, run in the background, classify at the end.
// ---------------------------------------------------------------------------

export interface PreparedJob {
  plan: GitPlan;
  phase: GitPhase;
  /** Turns the finished run into a result; the caller reads the overview. */
  outcome: (run: GitRunResult) => { ok: true; message: string } | { ok: false; error: GitError };
  /** Human-readable command; equals the previewed one. */
  command: string;
  /** Text for git's stdin (a commit message); never an argument. */
  stdin?: string;
}

export function prepared(phase: GitPhase, plan: GitPlan, outcome: PreparedJob["outcome"], stdin?: string): PreparedJob {
  return { plan, phase, outcome, command: gitCommandPreview(plan), ...(stdin === undefined ? {} : { stdin }) };
}

/** Classifies a non-zero exit; `onSuccess` builds the message otherwise. */
export function classifyOr(phase: GitPhase, timeoutMs: number, onSuccess: (run: GitRunResult) => { ok: true; message: string } | { ok: false; error: GitError }): PreparedJob["outcome"] {
  return (run) => (run.code !== 0 ? { ok: false, error: failureFrom(phase, run, timeoutMs) } : onSuccess(run));
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

export async function prepareFetch(
  context: ActionContext,
  input: { remote: string | null; prune: boolean; timeoutMs: number },
): Promise<PreparedJob | GitError> {
  const phase: GitPhase = "fetch";
  const remotes = await listRemotes(context);
  if (remotes.length === 0) return pluginGitError("no_remote", "This repository has no remotes.", phase);
  if (input.remote !== null && !remotes.includes(input.remote)) {
    return pluginGitError("no_remote", `Remote '${input.remote}' is not configured.`, phase);
  }
  const plan: GitPlan = { op: "fetch", remote: input.remote, prune: input.prune };
  return prepared(phase, plan, classifyOr(phase, input.timeoutMs, (run) => ({
    ok: true,
    message: summarizeFetch(run.stderr) ?? `Fetched ${input.remote ?? "all remotes"}; already up to date.`,
  })));
}

const AUTOSTASH_CONFLICT = /resulted in conflicts/u;

export async function preparePull(
  context: ActionContext,
  input: { strategy: PullStrategy; autoStash: boolean; timeoutMs: number },
): Promise<PreparedJob | GitError> {
  const phase: GitPhase = "pull";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: true });
  if (blocked) return blocked;
  const head = await requireBranch(context, phase, "Update Project");
  if (isError(head)) return head;
  const upstream = await upstreamOf(context, head.name, await listRemotes(context));
  if (upstream === null) return pluginGitError("no_upstream", `Branch '${head.name}' has no upstream branch.`, phase);
  if (upstream.gone) {
    return pluginGitError("no_upstream", `The upstream of '${head.name}' (${upstream.name}) is gone.`, phase, {
      hint: "The remote branch was deleted. Push with 'set upstream' to recreate it, or track another branch.",
    });
  }
  const plan: GitPlan = { op: "pull", strategy: input.strategy, autoStash: input.autoStash };
  return prepared(phase, plan, classifyOr(phase, input.timeoutMs, (run) => {
    // git exits 0 when the pull succeeded but re-applying the autostash did not.
    if (input.autoStash && AUTOSTASH_CONFLICT.test(`${run.stderr}\n${run.stdout}`)) {
      return {
        ok: false,
        error: pluginGitError("conflict", "Updated, but re-applying your stashed changes conflicted.", phase, {
          hint: "Resolve the conflicts, then run `git stash drop`; or `git checkout -- .` and `git stash pop` later.",
          stderr: run.stderr.trim() || undefined,
        }),
      };
    }
    const line = summaryLine(run.stdout, "");
    return { ok: true, message: line ? `Update Project: ${line.replace(/\.$/u, "")}.` : `Updated ${head.name} from ${upstream.name}.` };
  }));
}

/**
 * Runs exactly the push the dialog previewed. The app derives the plan from
 * the overview it showed; the host re-derives it from git and refuses with a
 * typed error when the two disagree instead of pushing something else.
 */
export async function preparePush(
  context: ActionContext,
  input: {
    remote: string;
    setUpstream: boolean;
    expectedBranch: string;
    source: "head" | "branch";
    expectedSha: string | null;
    lease: string | null;
    timeoutMs: number;
  },
): Promise<PreparedJob | GitError> {
  const phase: GitPhase = "push";
  const invalid = await checkRefFormat(context, input.expectedBranch, phase);
  if (invalid) return invalid;
  const branch = input.expectedBranch;
  if (input.source === "head") {
    const head = await requireBranch(context, phase, "a push");
    if (isError(head)) return head;
    if (head.name !== branch) {
      return pluginGitError("head_changed", `The current branch is now '${head.name}', not '${branch}'. Nothing was pushed.`, phase);
    }
  } else if (!(await refExists(context, `refs/heads/${branch}`))) {
    return pluginGitError("ref_not_found", `Branch '${branch}' does not exist. Nothing was pushed.`, phase);
  }
  if (input.expectedSha !== null) {
    const sha = await refSha(context, `refs/heads/${branch}`);
    if (sha === null || !sha.startsWith(input.expectedSha)) {
      return pluginGitError("head_changed", `'${branch}' moved since the dialog was shown. Nothing was pushed.`, phase);
    }
  }
  const remotes = await listRemotes(context);
  if (!remotes.includes(input.remote)) {
    return pluginGitError("no_remote", remotes.length === 0 ? "This repository has no remotes." : `Remote '${input.remote}' is not configured.`, phase);
  }
  // HEAD is pushed as HEAD only when the dialog talked about the current branch.
  const head = await currentBranch(context);
  const source = input.source === "head" || (head.kind === "branch" && head.name === branch) ? null : branch;

  let plan: PushPlan;
  let target: string;
  if (input.setUpstream) {
    plan = { op: "push", remote: input.remote, branch: source, setUpstream: true };
    target = `${input.remote}/${branch}`;
  } else {
    const upstream = await upstreamOf(context, branch, remotes);
    if (upstream === null || upstream.gone || upstream.remote === null || upstream.branch === null) {
      const why = upstream === null ? "has no upstream branch" : upstream.gone ? `tracks ${upstream.name}, which is gone` : `tracks ${upstream.name}, which is not on a remote`;
      return pluginGitError("no_upstream", `Branch '${branch}' ${why}. Nothing was pushed.`, phase);
    }
    if (upstream.remote !== input.remote) {
      return pluginGitError("head_changed", `'${branch}' now tracks ${upstream.name}, not a branch on '${input.remote}'. Nothing was pushed.`, phase);
    }
    if (input.lease !== null) {
      const remoteSha = await refSha(context, `refs/remotes/${upstream.name}`);
      if (remoteSha === null || !remoteSha.startsWith(input.lease)) {
        return pluginGitError("head_changed", `${upstream.name} moved since the dialog was shown. Nothing was pushed.`, phase, {
          hint: "Fetch, look at what changed, then decide again.",
        });
      }
    }
    plan = { op: "push", remote: upstream.remote, branch: source, setUpstream: false, upstreamBranch: upstream.branch, lease: input.lease };
    target = upstream.name;
  }
  return prepared(phase, plan, classifyOr(phase, input.timeoutMs, (run) => {
    const upToDate = /Everything up-to-date/u.test(run.stderr);
    return {
      ok: true,
      message: upToDate
        ? `${branch} is already up to date on ${target}.`
        : plan.setUpstream
          ? `Pushed ${branch} to ${target} and set it as upstream.`
          : input.lease !== null
            ? `Force-pushed ${branch} to ${target} (with lease).`
            : `Pushed ${branch} to ${target}.`,
    };
  }));
}

/** "Update" on a branch that is not checked out: fetch its upstream into it, fast-forward only. */
export async function prepareUpdateBranch(
  context: ActionContext,
  input: { branch: string; timeoutMs: number },
): Promise<PreparedJob | GitError> {
  const phase: GitPhase = "updateBranch";
  const invalid = await checkRefFormat(context, input.branch, phase);
  if (invalid) return invalid;
  if (!(await refExists(context, `refs/heads/${input.branch}`))) {
    return pluginGitError("ref_not_found", `Branch '${input.branch}' does not exist.`, phase);
  }
  const head = await currentBranch(context);
  if (head.kind !== "detached" && head.name === input.branch) {
    return pluginGitError("busy", `'${input.branch}' is checked out; use Update Project.`, phase, { hint: "Update Project pulls the current branch." });
  }
  const upstream = await upstreamOf(context, input.branch, await listRemotes(context));
  if (upstream === null) return pluginGitError("no_upstream", `Branch '${input.branch}' has no upstream branch.`, phase);
  if (upstream.gone) return pluginGitError("no_upstream", `The upstream of '${input.branch}' (${upstream.name}) is gone.`, phase);
  if (upstream.remote === null || upstream.branch === null) {
    return pluginGitError("no_upstream", `'${input.branch}' tracks ${upstream.name}, which is not on a remote.`, phase);
  }
  const plan: GitPlan = { op: "fetch-branch", remote: upstream.remote, upstreamBranch: upstream.branch, branch: input.branch };
  return prepared(phase, plan, classifyOr(phase, input.timeoutMs, (run) => ({
    ok: true,
    message: /->/u.test(run.stderr) ? `Updated ${input.branch} from ${upstream.name}.` : `${input.branch} is already up to date with ${upstream.name}.`,
  })));
}

export async function prepareDeleteRemoteBranch(
  context: ActionContext,
  input: { remote: string; branch: string; timeoutMs: number },
): Promise<PreparedJob | GitError> {
  const phase: GitPhase = "deleteBranch";
  const invalid = await checkRefFormat(context, input.branch, phase);
  if (invalid) return invalid;
  const remotes = await listRemotes(context);
  if (!remotes.includes(input.remote)) {
    return pluginGitError("no_remote", remotes.length === 0 ? "This repository has no remotes." : `Remote '${input.remote}' is not configured.`, phase);
  }
  if (!(await refExists(context, `refs/remotes/${input.remote}/${input.branch}`))) {
    return pluginGitError("ref_not_found", `Remote branch '${input.remote}/${input.branch}' does not exist locally.`, phase);
  }
  const plan: GitPlan = { op: "delete-remote", remote: input.remote, branch: input.branch };
  return prepared(phase, plan, classifyOr(phase, input.timeoutMs, () => ({
    ok: true,
    message: `Deleted ${input.remote}/${input.branch} on the remote.`,
  })));
}
