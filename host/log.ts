// The log panel's host side: one page of commits over the selected refs, one
// commit in full with the files it changed, and one file's patch inside that
// commit. Reads only; the log's mutations (cherry-pick, revert, reset) live
// in host/actions.ts with every other mutation.
import type { CommitDetails, GitError, LogFilter, LogPage, PatchResult } from "../contracts";
import { LOG_PAGE_SIZE } from "../shared/constants";
import { fullRef } from "../shared/model";
import { COMMIT_DETAILS_FORMAT, LOG_PAGE_FORMAT, parseCommitDetails, parseLogPage, parseNumstat } from "../shared/parse";
import { readOptions, type ActionContext } from "./actions";
import { FILE_LIMIT } from "./compare";
import { capPatch, hasNul, readFailure, showOrEmpty } from "./diff-text";
import { runGit, type GitRunResult } from "./git";

/** A walk that starts at HEAD before the first commit; an empty log, not a failure. */
const NO_COMMITS = /bad revision 'HEAD'|does not have any commits yet|unknown revision or path/iu;

/** Which revisions the walk starts from. `all` needs none: the flags are the walk. */
function revisionArgs(filter: LogFilter): string[] {
  switch (filter.kind) {
    case "all":
      return ["--branches", "--remotes"];
    case "head":
      return ["--end-of-options", "HEAD"];
    case "ref":
      return ["--end-of-options", fullRef(filter.ref)];
  }
}

export async function readLog(
  context: ActionContext,
  input: { filter: LogFilter; grep: string | null; skip: number },
): Promise<LogPage> {
  const result = await runGit(
    [
      "log",
      // Children before parents, whatever the clock says: commits made in
      // the same second (or with a skewed clock) would otherwise interleave.
      "--topo-order",
      // Full ref names in %D, so the app never has to guess whether
      // "origin/main" is a remote-tracking branch or a local one.
      "--decorate=full",
      `--format=${LOG_PAGE_FORMAT}`,
      "-n",
      // One more than the page, to learn whether another page exists.
      String(LOG_PAGE_SIZE + 1),
      ...(input.skip > 0 ? [`--skip=${input.skip}`] : []),
      // --fixed-strings: the filter box is a literal substring search, never
      // a regular expression the user did not write.
      ...(input.grep === null ? [] : [`--grep=${input.grep}`, "--fixed-strings", "--regexp-ignore-case"]),
      ...revisionArgs(input.filter),
      "--",
    ],
    readOptions(context),
  );
  if (result.code !== 0) {
    if (NO_COMMITS.test(result.stderr)) return { ok: true, commits: [], skip: input.skip, hasMore: false };
    return { ok: false, error: readFailure(result) };
  }
  const commits = parseLogPage(result.stdout);
  return {
    ok: true,
    commits: commits.slice(0, LOG_PAGE_SIZE),
    skip: input.skip,
    hasMore: commits.length > LOG_PAGE_SIZE,
  };
}

const isError = (value: unknown): value is GitError => typeof value === "object" && value !== null && "code" in value;

const notFound = (sha: string): GitError => ({
  code: "ref_not_found",
  message: `'${sha}' is not a commit in this repository.`,
  hint: "The log may be out of date; refresh it.",
});

/**
 * The commit a log row stands for and its first parent. Anything git cannot
 * resolve is "not a commit here": the row came from a log that may be stale,
 * or from a request that made the sha up.
 */
async function resolveCommit(context: ActionContext, sha: string): Promise<{ sha: string; parent: string | null } | GitError> {
  const result = await runGit(
    ["rev-list", "--max-count=1", "--parents", "--end-of-options", `${sha}^{commit}`, "--"],
    readOptions(context),
  );
  if (result.timedOut || result.cancelled) return readFailure(result);
  const [resolved, parent] = result.stdout.trim().split(" ");
  if (result.code !== 0 || resolved === undefined || resolved === "") return notFound(sha);
  return { sha: resolved, parent: parent ?? null };
}

/** `git show` of a commit is not a diff, so the files come from a second command. */
export async function commitDetails(context: ActionContext, input: { sha: string }): Promise<CommitDetails> {
  const read = readOptions(context);
  const resolved = await resolveCommit(context, input.sha);
  if (isError(resolved)) return { ok: false, error: resolved };
  const shown = await runGit(
    ["show", "--no-patch", "--decorate=full", `--format=${COMMIT_DETAILS_FORMAT}`, "--end-of-options", resolved.sha, "--"],
    read,
  );
  if (shown.code !== 0) return { ok: false, error: readFailure(shown) };
  const commit = parseCommitDetails(shown.stdout);
  if (commit === null) return { ok: false, error: notFound(input.sha) };
  const parent = commit.parents[0] ?? null;
  // A merge is diffed against its first parent, the way `git show` does it.
  const files = await runGit(
    parent === null
      ? ["diff-tree", "--no-commit-id", "--numstat", "-z", "-M", "-r", "--root", "--end-of-options", commit.sha, "--"]
      : ["diff", "--numstat", "-z", "-M", "--end-of-options", parent, commit.sha, "--"],
    read,
  );
  if (files.code !== 0) return { ok: false, error: readFailure(files) };
  const changed = parseNumstat(files.stdout);
  return {
    ok: true,
    commit,
    files: changed.slice(0, FILE_LIMIT),
    truncated: changed.length > FILE_LIMIT,
    againstParent: parent,
  };
}

/**
 * One file's patch inside a commit, against its first parent (the empty tree
 * for the initial commit), plus both complete sides so bb's viewer can expand
 * context. `oldPath` joins the pathspec, or a rename would look like an add.
 */
export async function commitPatch(
  context: ActionContext,
  input: { sha: string; path: string; oldPath: string | null },
): Promise<PatchResult> {
  const resolved = await resolveCommit(context, input.sha);
  if (isError(resolved)) return { ok: false, error: resolved };
  const { sha, parent } = resolved;
  const paths = input.oldPath === null || input.oldPath === input.path ? [input.path] : [input.oldPath, input.path];
  const result: GitRunResult = await runGit(
    parent === null
      ? ["--literal-pathspecs", "show", "--no-color", "--no-ext-diff", "-M", "--format=", "--end-of-options", sha, "--", ...paths]
      : ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "-M", "--end-of-options", parent, sha, "--", ...paths],
    readOptions(context),
  );
  if (result.code !== 0) return { ok: false, error: readFailure(result) };
  const { patch, truncated, binary } = capPatch(result.stdout);
  let contents: Extract<PatchResult, { ok: true }>["contents"] = null;
  if (!binary && !truncated && patch !== "") {
    const oldPath = input.oldPath ?? input.path;
    const [oldText, newText] = await Promise.all([
      parent === null ? Promise.resolve("") : showOrEmpty(context, `${parent}:${oldPath}`),
      showOrEmpty(context, `${sha}:${input.path}`),
    ]);
    if (oldText !== null && newText !== null && !hasNul(oldText) && !hasNul(newText)) {
      contents = { old: { path: oldPath, content: oldText }, new: { path: input.path, content: newText } };
    }
  }
  return { ok: true, path: input.path, patch, truncated, binary, contents };
}
