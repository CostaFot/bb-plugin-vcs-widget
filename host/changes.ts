// The commit panel's host side: what the working tree and the index hold,
// one file's patch with both complete sides, staging, unstaging, discarding,
// and the commit itself as a background job (hooks may run for longer than
// one host call). Every path command runs under --literal-pathspecs so a
// path from `git status` can never turn into a glob or pathspec magic.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ActionResult, ChangesResult, CommitInput, DiscardInput, FileDiff, GitError, Head } from "../contracts";
import { CHANGES_LIMIT, type DiffSide } from "../shared/constants";
import { classifyGitFailure, pluginGitError, type GitPhase } from "../shared/git-errors";
import { discardPlans, type GitPlan } from "../shared/model";
import { parseCommitSummary, parseStatusEntries, parseStatusV2 } from "../shared/parse";
import {
  classifyOr,
  currentBranch,
  fail,
  failureFrom,
  prepared,
  readOptions,
  runPlan,
  succeed,
  type ActionContext,
  type PreparedJob,
} from "./actions";
import { capPatch, hasNul, readFailure, showOrEmpty, SIDE_LIMIT_BYTES } from "./diff-text";
import { gitReadOrNull, runGit } from "./git";
import { detectOperation, isIndexLocked, preflight } from "./repo";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readChanges(context: ActionContext): Promise<ChangesResult> {
  const read = readOptions(context);
  const [statusRaw, logRaw, operation, indexLocked] = await Promise.all([
    runGit(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], read),
    // "HEAD --": a file called HEAD in the worktree must not make the
    // revision ambiguous; an unborn branch has no HEAD and yields null.
    gitReadOrNull(["log", "-1", "--format=%H%x00%h%x00%B", "HEAD", "--"], read),
    detectOperation(context.repo.gitDir),
    isIndexLocked(context.repo.gitDir),
  ]);
  if (statusRaw.code !== 0) return { ok: false, error: readFailure(statusRaw) };
  const summary = parseStatusV2(statusRaw.stdout);
  const entries = parseStatusEntries(statusRaw.stdout);
  const head: Head | null = summary.detached
    ? { kind: "detached", sha: summary.oid ?? "" }
    : summary.head === null
      ? null
      : summary.oid === null
        ? { kind: "unborn", name: summary.head }
        : { kind: "branch", name: summary.head, sha: summary.oid };
  let lastCommit: Extract<ChangesResult, { ok: true }>["lastCommit"] = null;
  if (logRaw !== null) {
    const [sha = "", shortSha = "", ...rest] = logRaw.split("\0");
    const message = rest.join("\0").replace(/\n+$/u, "");
    if (sha !== "") lastCommit = { sha, shortSha, subject: message.split("\n")[0] ?? "", message };
  }
  return {
    ok: true,
    head,
    operation,
    indexLocked,
    files: entries.slice(0, CHANGES_LIMIT),
    truncated: entries.length > CHANGES_LIMIT,
    lastCommit,
  };
}

async function worktreeFile(context: ActionContext, path: string): Promise<string | null> {
  const absolute = join(context.repo.repoRoot, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return "";
    if (info.size > SIDE_LIMIT_BYTES) return null;
    return await readFile(absolute, "utf8");
  } catch {
    return ""; // deleted in the worktree
  }
}

/**
 * The patch for one file on one side (HEAD → index, or index → working
 * tree) plus, when textual and small, both complete sides so bb's viewer
 * can expand context. An untracked file diffs against /dev/null.
 */
export async function diffFile(
  context: ActionContext,
  input: { path: string; oldPath: string | null; side: DiffSide },
): Promise<FileDiff> {
  const read = readOptions(context);
  const paths = input.oldPath === null || input.oldPath === input.path ? [input.path] : [input.oldPath, input.path];
  const sideArgs = input.side === "index" ? ["--cached"] : [];
  let result = await runGit(
    ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "-M", ...sideArgs, "--", ...paths],
    read,
  );
  if (result.code !== 0) return { ok: false, error: readFailure(result) };
  let untracked = false;
  if (input.side === "worktree" && result.stdout === "") {
    const tracked = await runGit(["--literal-pathspecs", "ls-files", "--", input.path], read);
    if (tracked.code === 0 && tracked.stdout.trim() === "") {
      const exists = await stat(join(context.repo.repoRoot, input.path)).then((info) => info.isFile(), () => false);
      if (exists) {
        untracked = true;
        // Exit 1 means "differs", which a new file always does.
        result = await runGit(["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", input.path], read);
        if (result.code !== 0 && result.code !== 1) return { ok: false, error: readFailure(result) };
      }
    }
  }
  const { patch, truncated, binary } = capPatch(result.stdout);
  let contents: Extract<FileDiff, { ok: true }>["contents"] = null;
  if (!binary && !truncated && patch !== "") {
    const oldPath = input.oldPath ?? input.path;
    const [oldText, newText] =
      input.side === "index"
        ? await Promise.all([showOrEmpty(context, `HEAD:${oldPath}`), showOrEmpty(context, `:${input.path}`)])
        : await Promise.all([untracked ? Promise.resolve("") : showOrEmpty(context, `:${input.path}`), worktreeFile(context, input.path)]);
    if (oldText !== null && newText !== null && !hasNul(oldText) && !hasNul(newText)) {
      contents = { old: { path: oldPath, content: oldText }, new: { path: input.path, content: newText } };
    }
  }
  return { ok: true, path: input.path, side: input.side, patch, truncated, binary, contents };
}

// ---------------------------------------------------------------------------
// Index mutations: never during an index lock, allowed during a merge
// (staging is how a conflict gets resolved).
// ---------------------------------------------------------------------------

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;

export async function stage(context: ActionContext, paths: readonly string[]): Promise<ActionResult> {
  const phase: GitPhase = "stage";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return fail(context, blocked);
  const plan: GitPlan = { op: "stage", paths };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Staged ${files(paths.length)}.`);
}

export async function unstage(context: ActionContext, paths: readonly string[]): Promise<ActionResult> {
  const phase: GitPhase = "stage";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return fail(context, blocked);
  const plan: GitPlan = { op: "unstage", paths };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Unstaged ${files(paths.length)}.`);
}

/** Runs the previewed discard commands in order; the first failure stops the rest. */
export async function discard(context: ActionContext, input: DiscardInput): Promise<ActionResult> {
  const phase: GitPhase = "discard";
  const plans = discardPlans(input);
  if (plans.length === 0) return fail(context, pluginGitError("git_failed", "Nothing to discard.", phase));
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return fail(context, blocked);
  for (const plan of plans) {
    const { result, deadlineMs } = await runPlan(context, plan, "mutate");
    if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  }
  const total = input.restore.length + input.remove.length + input.clean.length;
  const parts = [
    input.restore.length > 0 ? `reverted ${files(input.restore.length)}` : null,
    input.remove.length > 0 ? `unstaged ${files(input.remove.length)} (kept on disk)` : null,
    input.clean.length > 0 ? `deleted ${files(input.clean.length)}` : null,
  ].filter((part): part is string => part !== null);
  return succeed(context, `Discarded changes in ${files(total)}: ${parts.join(", ")}.`);
}

// ---------------------------------------------------------------------------
// Commit: a job, because hooks can take longer than one host call.
// ---------------------------------------------------------------------------

export async function prepareCommit(
  context: ActionContext,
  input: CommitInput & { timeoutMs: number },
): Promise<PreparedJob | GitError> {
  const phase: GitPhase = "commit";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return blocked;
  const status = await runGit(["status", "--porcelain=v2", "-z"], readOptions(context));
  if (status.code !== 0) return failureFrom(phase, status, 0);
  const summary = parseStatusV2(status.stdout);
  if (summary.conflicted > 0) {
    return pluginGitError("conflict", `${files(summary.conflicted)} still conflicted; resolve and stage them first.`, phase);
  }
  const head = await currentBranch(context);
  if (input.amend && head.kind === "unborn") {
    return pluginGitError("ref_not_found", "There is no commit to amend yet.", phase, { hint: "Make the first commit without Amend." });
  }
  if (!input.amend && summary.staged === 0) {
    return pluginGitError("nothing_to_commit", "Nothing is staged.", phase);
  }
  const plan: GitPlan = { op: "commit", amend: input.amend, signoff: input.signoff, noVerify: input.noVerify };
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  return prepared(
    phase,
    plan,
    classifyOr(phase, input.timeoutMs, (run) => {
      const line = parseCommitSummary(run.stdout);
      return {
        ok: true,
        message: line
          ? `${input.amend ? "Amended" : "Committed"} ${line.sha}: ${line.subject}`
          : input.amend
            ? "Amended the last commit."
            : "Committed.",
      };
    }),
    message,
  );
}
