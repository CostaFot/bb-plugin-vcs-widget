// Read-only views for the panel tabs and the revision step: commits on
// either side of two branches, changed files, one file's patch, tags. Output
// is capped so a huge repository cannot exceed bb's host payload limits.
import type { BranchRef, CompareResult, GitError, PatchResult, TagList, WorkingTreeDiff } from "../contracts";
import { classifyGitFailure } from "../shared/git-errors";
import { fullRef, refLabel } from "../shared/model";
import { LOG_FORMAT, TAG_FORMAT, parseLeftRightCount, parseLog, parseNumstat, parseTags } from "../shared/parse";
import { runGit, type GitRunResult } from "./git";
import type { ActionContext } from "./actions";

export const COMMIT_LIMIT = 200;
export const FILE_LIMIT = 500;
export const TAG_LIMIT = 500;
export const PATCH_LIMIT_BYTES = 1024 * 1024;

function readOptions(context: ActionContext) {
  return { cwd: context.repo.repoRoot, timeoutMs: context.budget.deadlineFor("read"), signal: context.signal };
}

function readFailure(result: GitRunResult): GitError {
  return classifyGitFailure({
    phase: "compare",
    exitCode: result.code,
    stderr: result.stderr,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
  });
}

async function verifyRef(context: ActionContext, ref: BranchRef): Promise<string | GitError> {
  const full = fullRef(ref);
  const result = await runGit(["show-ref", "--verify", "--quiet", full], readOptions(context));
  if (result.code !== 0) {
    return { code: "ref_not_found", message: `Branch '${refLabel(ref)}' does not exist${ref.kind === "remote" ? " locally" : ""}.` };
  }
  return full;
}

const isError = (value: string | GitError): value is GitError => typeof value !== "string";

export async function compare(context: ActionContext, input: { base: BranchRef; target: BranchRef }): Promise<CompareResult> {
  const base = await verifyRef(context, input.base);
  if (isError(base)) return { ok: false, error: base };
  const target = await verifyRef(context, input.target);
  if (isError(target)) return { ok: false, error: target };
  const read = readOptions(context);
  const [countRaw, aheadRaw, behindRaw, filesRaw] = await Promise.all([
    runGit(["rev-list", "--left-right", "--count", "--end-of-options", `${base}...${target}`, "--"], read),
    runGit(["log", `--format=${LOG_FORMAT}`, `-n`, String(COMMIT_LIMIT), "--end-of-options", `${base}..${target}`, "--"], read),
    runGit(["log", `--format=${LOG_FORMAT}`, `-n`, String(COMMIT_LIMIT), "--end-of-options", `${target}..${base}`, "--"], read),
    runGit(["diff", "--numstat", "-z", "-M", "--end-of-options", `${base}...${target}`, "--"], read),
  ]);
  const failed = [countRaw, aheadRaw, behindRaw, filesRaw].find((result) => result.code !== 0);
  if (failed) return { ok: false, error: readFailure(failed) };
  const counts = parseLeftRightCount(countRaw.stdout);
  const files = parseNumstat(filesRaw.stdout);
  return {
    ok: true,
    base: refLabel(input.base),
    target: refLabel(input.target),
    aheadCount: counts.right,
    behindCount: counts.left,
    ahead: parseLog(aheadRaw.stdout),
    behind: parseLog(behindRaw.stdout),
    files: files.slice(0, FILE_LIMIT),
    truncated: { ahead: counts.right > COMMIT_LIMIT, behind: counts.left > COMMIT_LIMIT, files: files.length > FILE_LIMIT },
  };
}

async function patchFor(context: ActionContext, revisionArgs: string[], path: string): Promise<PatchResult> {
  const result = await runGit(["diff", "-M", "--no-color", "--end-of-options", ...revisionArgs, "--", path], readOptions(context));
  if (result.code !== 0) return { ok: false, error: readFailure(result) };
  const raw = result.stdout;
  const truncated = Buffer.byteLength(raw, "utf8") > PATCH_LIMIT_BYTES;
  const patch = truncated ? Buffer.from(raw, "utf8").subarray(0, PATCH_LIMIT_BYTES).toString("utf8") : raw;
  return {
    ok: true,
    path,
    patch,
    truncated,
    binary: /^Binary files .* differ$/mu.test(raw) || /^GIT binary patch$/mu.test(raw),
  };
}

export async function comparePatch(
  context: ActionContext,
  input: { base: BranchRef; target: BranchRef; path: string },
): Promise<PatchResult> {
  const base = await verifyRef(context, input.base);
  if (isError(base)) return { ok: false, error: base };
  const target = await verifyRef(context, input.target);
  if (isError(target)) return { ok: false, error: target };
  return patchFor(context, [`${base}...${target}`], input.path);
}

export async function diffWorkingTree(context: ActionContext, input: { ref: BranchRef }): Promise<WorkingTreeDiff> {
  const ref = await verifyRef(context, input.ref);
  if (isError(ref)) return { ok: false, error: ref };
  const result = await runGit(["diff", "--numstat", "-z", "-M", "--end-of-options", ref, "--"], readOptions(context));
  if (result.code !== 0) return { ok: false, error: readFailure(result) };
  const files = parseNumstat(result.stdout);
  return { ok: true, ref: refLabel(input.ref), files: files.slice(0, FILE_LIMIT), truncated: files.length > FILE_LIMIT };
}

export async function diffWorkingTreePatch(context: ActionContext, input: { ref: BranchRef; path: string }): Promise<PatchResult> {
  const ref = await verifyRef(context, input.ref);
  if (isError(ref)) return { ok: false, error: ref };
  return patchFor(context, [ref], input.path);
}

export async function listTags(context: ActionContext): Promise<TagList> {
  const result = await runGit(
    ["for-each-ref", "--sort=-creatordate", `--count=${TAG_LIMIT + 1}`, `--format=${TAG_FORMAT}`, "refs/tags"],
    readOptions(context),
  );
  if (result.code !== 0) return { ok: false, error: readFailure(result) };
  const tags = parseTags(result.stdout);
  return { ok: true, tags: tags.slice(0, TAG_LIMIT), truncated: tags.length > TAG_LIMIT };
}
