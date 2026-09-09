// Repository resolution, pre-flight checks and the overview read.
import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { GitError, LocalBranch, Operation, Overview, RemoteBranch, Upstream } from "../contracts";
import { isValidRemoteName } from "../shared/branch-name";
import { classifyGitFailure, firstStderrLine, hintFor, pluginGitError } from "../shared/git-errors";
import type { GitPhase } from "../shared/git-errors";
import {
  FOR_EACH_REF_FORMAT,
  parseForEachRef,
  parseGitVersion,
  parseRecentFromReflog,
  parseStatusV2,
  splitRemoteRef,
} from "../shared/parse";
import { gitReadOrNull, runGit } from "./git";
import { activeJobFor } from "./jobs";

export interface RepoInfo {
  /** The worktree root (`--show-toplevel`). */
  repoRoot: string;
  /** This worktree's git dir (absolute). */
  gitDir: string;
  /** The shared git dir (absolute), which is `gitDir` for a main worktree. */
  commonDir: string;
}

const LOCAL_LIMIT = 2000;
const REMOTE_LIMIT = 5000;
const REFLOG_LINES = 300;

// Only a successful read is cached: a cancelled or timed-out first read must
// not report "unknown git" for the worker's lifetime.
let cachedGitVersion: string | null = null;

export async function gitVersion(cwd: string, options: { signal?: AbortSignal; timeoutMs: number }): Promise<string | null> {
  if (cachedGitVersion !== null) return cachedGitVersion;
  if (options.signal?.aborted) return null;
  const raw = await gitReadOrNull(["--version"], { cwd, timeoutMs: options.timeoutMs, signal: options.signal });
  const parsed = raw === null ? null : parseGitVersion(raw);
  if (parsed !== null) cachedGitVersion = parsed;
  return parsed;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Deadline for each git command in this read. */
  timeoutMs: number;
}

export async function resolveRepo(
  repoPath: string,
  options: ReadOptions,
): Promise<RepoInfo | { error: GitError }> {
  const { signal, timeoutMs } = options;
  if (!isAbsolute(repoPath)) {
    return { error: pluginGitError("not_a_repo", "The thread environment has no absolute workspace path.", "read") };
  }
  try {
    const info = await stat(repoPath);
    if (!info.isDirectory()) {
      return { error: pluginGitError("not_a_repo", "The workspace path is not a directory.", "read") };
    }
  } catch {
    return { error: pluginGitError("not_a_repo", "The workspace path does not exist on this machine.", "read") };
  }
  const result = await runGit(
    ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
    { cwd: repoPath, timeoutMs, signal },
  );
  if (result.code !== 0) {
    const classified = classifyGitFailure({ phase: "read", exitCode: result.code, stderr: result.stderr, timedOut: result.timedOut, cancelled: result.cancelled });
    if (classified.code !== "git_failed") return { error: classified };
    // Keep git's own words: "must be run in a work tree" (bare repository) or
    // "dubious ownership" (safe.directory) send the user somewhere useful.
    const detail = firstStderrLine(result.stderr);
    const message = /not a git repository/iu.test(result.stderr)
      ? "The thread workspace is not inside a git repository."
      : detail
        ? `The thread workspace cannot be used as a git worktree: ${detail}`
        : "The thread workspace is not inside a git repository.";
    return { error: { ...classified, code: "not_a_repo", message, hint: hintFor("not_a_repo", "read") } };
  }
  const [toplevel = "", gitDir = "", commonDir = ""] = result.stdout.split("\n").map((line) => line.trim());
  if (toplevel === "") {
    return { error: pluginGitError("not_a_repo", "The thread workspace is not inside a git worktree.", "read") };
  }
  // `--git-common-dir` prints a relative path (".git") in a main worktree;
  // it is relative to the cwd, not the toplevel.
  return {
    repoRoot: toplevel,
    gitDir: resolve(repoPath, gitDir),
    commonDir: resolve(repoPath, commonDir),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectOperation(gitDir: string): Promise<Operation> {
  if (await exists(join(gitDir, "MERGE_HEAD"))) return "merge";
  if ((await exists(join(gitDir, "rebase-merge"))) || (await exists(join(gitDir, "rebase-apply")))) return "rebase";
  if (await exists(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (await exists(join(gitDir, "REVERT_HEAD"))) return "revert";
  return "none";
}

export async function isIndexLocked(gitDir: string): Promise<boolean> {
  return exists(join(gitDir, "index.lock"));
}

/**
 * Refuses a mutation the repository is not ready for. Returns null when the
 * action may proceed.
 */
export async function preflight(
  repo: RepoInfo,
  phase: GitPhase,
  options: { touchesIndex: boolean; requireNoOperation: boolean },
): Promise<GitError | null> {
  if (options.touchesIndex && (await isIndexLocked(repo.gitDir))) {
    return pluginGitError("index_locked", "The repository index is locked.", phase);
  }
  if (options.requireNoOperation) {
    const operation = await detectOperation(repo.gitDir);
    if (operation !== "none") {
      return pluginGitError("operation_in_progress", `A ${operation} is in progress in this worktree.`, phase);
    }
  }
  return null;
}

export async function readOverview(
  repo: RepoInfo,
  options: ReadOptions & { recentLimit: number },
): Promise<Overview> {
  const cwd = repo.repoRoot;
  const read = { cwd, timeoutMs: options.timeoutMs, signal: options.signal };
  const [
    version,
    headsRaw,
    remotesRaw,
    statusRaw,
    reflogRaw,
    remoteListRaw,
    operation,
    indexLocked,
  ] = await Promise.all([
    gitVersion(cwd, read),
    runGit(["for-each-ref", "--sort=-committerdate", `--count=${LOCAL_LIMIT}`, `--format=${FOR_EACH_REF_FORMAT}`, "refs/heads"], read),
    runGit(["for-each-ref", "--sort=-committerdate", `--count=${REMOTE_LIMIT}`, `--format=${FOR_EACH_REF_FORMAT}`, "refs/remotes"], read),
    runGit(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], read),
    // The trailing "--" keeps a file called HEAD in the worktree from making
    // the revision ambiguous.
    gitReadOrNull(["reflog", "show", "--format=%gs", `-n`, String(REFLOG_LINES), "HEAD", "--"], read),
    gitReadOrNull(["remote"], read),
    detectOperation(repo.gitDir),
    isIndexLocked(repo.gitDir),
  ]);

  const failed = [headsRaw, remotesRaw, statusRaw].find((result) => result.code !== 0);
  if (failed) {
    const error = classifyGitFailure({ phase: "read", exitCode: failed.code, stderr: failed.stderr, timedOut: failed.timedOut, cancelled: failed.cancelled });
    throw new OverviewReadError(error);
  }

  const remotes = (remoteListRaw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const status = parseStatusV2(statusRaw.stdout);
  const headRows = parseForEachRef(headsRaw.stdout);
  const remoteRows = parseForEachRef(remotesRaw.stdout).filter((row) => row.symref === null);

  const local: LocalBranch[] = headRows.map((row) => ({
    name: row.name,
    sha: row.sha,
    upstream: row.upstream,
    ahead: row.ahead,
    behind: row.behind,
    gone: row.gone,
    isCurrent: !status.detached && row.name === status.head,
    // The current worktree's own path is not "another worktree".
    worktreePath: row.worktreePath !== null && resolve(row.worktreePath) !== resolve(repo.repoRoot) ? row.worktreePath : null,
    committedAt: row.committedAt,
    subject: row.subject,
  }));
  const localNames = new Set(local.map((branch) => branch.name));

  const remote: RemoteBranch[] = [];
  for (const row of remoteRows) {
    const split = splitRemoteRef(row.name, remotes);
    if (split === null) continue;
    remote.push({
      name: row.name,
      remote: split.remote,
      branch: split.branch,
      sha: row.sha,
      hasLocal: localNames.has(split.branch),
      committedAt: row.committedAt,
      subject: row.subject,
    });
  }

  const head: Overview["head"] = status.detached
    ? { kind: "detached", sha: status.oid ?? "" }
    : status.head === null
      ? null
      : status.oid === null
        ? { kind: "unborn", name: status.head }
        : { kind: "branch", name: status.head, sha: status.oid };

  const currentName = head?.kind === "branch" || head?.kind === "unborn" ? head.name : null;
  const currentLocal = currentName === null ? undefined : local.find((branch) => branch.name === currentName);
  // `status` keeps printing branch.upstream after the remote-tracking ref is
  // deleted; for-each-ref's "[gone]" on the local row is the truth.
  const upstream: Upstream | null =
    status.upstream === null
      ? null
      : {
          name: status.upstream,
          ...upstreamParts(status.upstream, remotes),
          ahead: status.ahead || currentLocal?.ahead || 0,
          behind: status.behind || currentLocal?.behind || 0,
          gone: currentLocal?.gone ?? false,
        };

  return {
    unavailableReason: null,
    repoRoot: repo.repoRoot,
    repoName: basename(repo.repoRoot),
    gitVersion: version,
    head,
    operation,
    indexLocked,
    upstream,
    workingTree: {
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      conflicted: status.conflicted,
    },
    local,
    remote,
    recent: parseRecentFromReflog(reflogRaw ?? "", {
      current: currentName,
      existing: localNames,
      limit: options.recentLimit,
    }),
    remotes,
    truncated: { local: headRows.length >= LOCAL_LIMIT, remote: remoteRows.length >= REMOTE_LIMIT },
    activeJob: activeJobFor(repo.commonDir),
  };
}

/**
 * Splits `origin/feature` into a configured remote and its branch. A local
 * upstream (`main`, or `.`-remote tracking) has no remote to push to.
 */
export function upstreamParts(name: string, remotes: readonly string[]): { remote: string | null; branch: string | null } {
  const match = [...remotes]
    .filter((remote) => isValidRemoteName(remote))
    .sort((a, b) => b.length - a.length)
    .find((remote) => name.startsWith(`${remote}/`) && name.length > remote.length + 1);
  return match ? { remote: match, branch: name.slice(match.length + 1) } : { remote: null, branch: null };
}

export class OverviewReadError extends Error {
  constructor(readonly gitError: GitError) {
    super(gitError.message);
    this.name = "OverviewReadError";
  }
}
