// Turns a failed git invocation into a typed, user-readable error. Pure and
// table-driven so it can be unit-tested with one stderr sample per code and
// reused by the host (classification) and the app (copy for known codes).
import type { GitError, GitErrorCode } from "../contracts";

export type GitPhase =
  | "read"
  | "preflight"
  | "checkout"
  | "createBranch"
  | "fetch"
  | "pull"
  | "push"
  | "updateBranch"
  | "deleteBranch"
  | "renameBranch"
  | "merge"
  | "rebase"
  | "abort"
  | "setUpstream"
  | "worktree"
  | "checkoutRevision"
  | "compare"
  | "stage"
  | "discard"
  | "commit";

export interface GitFailureInput {
  phase: GitPhase;
  exitCode: number | null;
  stderr: string;
  stdout?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  /** Seconds the phase was allowed, for the timeout message. */
  deadlineSeconds?: number;
}

interface Rule {
  code: GitErrorCode;
  pattern: RegExp;
}

// Order matters: the first matching rule wins. Authentication is checked
// before network because git prints "Could not read from remote repository"
// for both.
const RULES: readonly Rule[] = [
  { code: "not_fully_merged", pattern: /is not fully merged/i },
  { code: "nothing_to_commit", pattern: /nothing to commit|no changes added to commit|nothing added to commit/i },
  { code: "index_locked", pattern: /index\.lock|Another git process seems to be running|cannot lock ref|Unable to create .*\.lock/i },
  { code: "operation_in_progress", pattern: /You have not concluded your merge|MERGE_HEAD exists|rebase in progress|rebase-merge|rebase-apply|interactive rebase already started|cherry-pick (?:or revert )?is already in progress|A cherry-pick or revert is already in progress|revert is already in progress|Please, commit your changes before you merge/i },
  { code: "dirty_worktree", pattern: /would be overwritten by (?:checkout|merge|rebase)|Your local changes to the following files|Please commit your changes or stash them|cannot pull with rebase: You have unstaged changes|You have unstaged changes|Cannot rebase: Your index contains uncommitted changes|Please commit or stash them/i },
  { code: "conflict", pattern: /CONFLICT \(|Automatic merge failed|could not apply|Resolve all conflicts|fix conflicts and then|Merge conflict in|error: could not apply/i },
  { code: "path_exists", pattern: /is already checked out at|already used by worktree at|is already used by worktree|destination path '.*' already exists/im },
  { code: "ref_exists", pattern: /a branch named '.*' already exists|already exists\.?$/im },
  { code: "invalid_ref_name", pattern: /is not a valid branch name|not a valid ref name|invalid branch name|check-ref-format|is not a valid refname|'.*' is not a valid/i },
  { code: "ref_not_found", pattern: /pathspec '.*' did not match|invalid reference: |unknown revision or path|Needed a single revision|not something we can merge|couldn't find remote ref|invalid upstream|fatal: ambiguous argument|ambiguous object name|refname '.*' is ambiguous|no such branch/i },
  { code: "no_upstream", pattern: /no tracking information|has no upstream branch|no upstream configured|There is no tracking information for the current branch|The current branch .* has no upstream branch|upstream branch of your current branch does not match|but no such ref was fetched/i },
  { code: "no_remote", pattern: /does not appear to be a git repository|No such remote|No remote repository specified|no remote configured|'.*' does not appear to be a git repository|No configured push destination/i },
  { code: "auth_required", pattern: /could not read Username|could not read Password|Permission denied \(publickey|terminal prompts disabled|Authentication failed|Host key verification failed|Invalid username or (?:password|token)|remote: Support for password authentication was removed|HTTP Basic: Access denied|Repository not found/i },
  { code: "network", pattern: /Could not resolve host|Connection refused|Connection timed out|unable to access|Network is unreachable|Failed to connect|Could not read from remote repository|Connection reset by peer|Operation timed out|The remote end hung up unexpectedly|early EOF/i },
  { code: "non_fast_forward", pattern: /\[rejected\]|non-fast-forward|fetch first|Updates were rejected|Not possible to fast-forward|Cannot fast-forward|not possible to fast-forward|Diverging branches can't be fast-forwarded|stale info/i },
  { code: "detached_head", pattern: /You are not currently on a branch|HEAD is detached|detached HEAD|HEAD does not point to a branch/i },
  { code: "not_a_repo", pattern: /not a git repository/i },
];

const HINTS: Partial<Record<GitErrorCode, Partial<Record<GitPhase | "any", string>>>> = {
  dirty_worktree: {
    pull: "Commit or stash your changes first, or turn on auto-stash in the plugin settings.",
    any: "Commit or stash your changes first.",
  },
  index_locked: {
    any: "Another git process is running in this worktree, or a stale .git/index.lock was left behind.",
  },
  operation_in_progress: {
    any: "Finish or abort the merge, rebase, cherry-pick or revert in progress first.",
  },
  ref_exists: { any: "Pick another name." },
  invalid_ref_name: {
    any: "Use letters, digits, '/', '.', '-' and '_' without spaces, '..' or a leading '-'.",
  },
  ref_not_found: { any: "Fetch first if the branch was created elsewhere." },
  no_upstream: {
    pull: "This branch does not track a remote branch yet. Push it first; Push sets the upstream.",
    push: "Push with 'set upstream' to create the remote branch.",
    any: "This branch has no upstream branch.",
  },
  no_remote: { any: "Add a remote to the repository first." },
  auth_required: {
    any: "Git could not authenticate without a terminal. Set up a credential helper or SSH agent on the machine that owns this worktree.",
  },
  network: { any: "Check the connection to the remote and try again." },
  non_fast_forward: {
    push: "Update Project first, then push again.",
    pull: "The branches diverged. Switch the update strategy to rebase or merge in the plugin settings.",
    any: "The branches diverged.",
  },
  conflict: {
    any: "Resolve the conflicts in the worktree and continue from a terminal, or use Abort in the popup to go back.",
  },
  not_fully_merged: {
    any: "The branch has commits that are not on any other branch. Delete anyway discards them.",
  },
  path_exists: {
    worktree: "Pick another directory, or the branch is already checked out in a worktree.",
    any: "Something with that name already exists.",
  },
  git_too_old: {
    any: "The plugin needs git 2.24 or newer on the machine that owns this worktree.",
  },
  detached_head: { any: "Check out a branch first." },
  busy: { any: "Another VCS action on this repository is still running." },
  timeout: {
    fetch: "Raise the job timeout in the plugin settings for large fetches.",
    pull: "Raise the job timeout in the plugin settings for large updates.",
    push: "Raise the job timeout in the plugin settings for large pushes.",
    any: "Try again.",
  },
  not_a_repo: { any: "Open a thread whose workspace is inside a git repository." },
  head_changed: { any: "The repository changed since the popup was opened. Open it again and retry." },
  nothing_to_commit: { any: "Tick the files to include; the checkbox stages them." },
};

const PHASE_VERB: Record<GitPhase, string> = {
  read: "Reading repository state",
  preflight: "Checking the repository",
  checkout: "Checkout",
  createBranch: "Creating the branch",
  fetch: "Fetch",
  pull: "Update Project",
  push: "Push",
  updateBranch: "Update",
  deleteBranch: "Delete",
  renameBranch: "Rename",
  merge: "Merge",
  rebase: "Rebase",
  abort: "Abort",
  setUpstream: "Tracked Branch",
  worktree: "New Worktree",
  checkoutRevision: "Checkout",
  compare: "Compare",
  stage: "Staging",
  discard: "Discard",
  commit: "Commit",
};

export function hintFor(code: GitErrorCode, phase: GitPhase): string | undefined {
  const entry = HINTS[code];
  return entry?.[phase] ?? entry?.any;
}

/**
 * The first meaningful stderr line, without git's "fatal: "/"error: " prefix.
 * Push output starts with "To <url>", which explains nothing; the rejection
 * line after it does.
 */
export function firstStderrLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && !candidate.startsWith("hint:"));
  const line = lines.find((candidate) => !/^To \S+$/u.test(candidate)) ?? lines[0];
  return (line ?? "").replace(/^(?:fatal|error|warning):\s*/iu, "").replace(/^!\s+/u, "");
}

/**
 * The last meaningful stderr line. A hook prints its progress first and its
 * verdict last ("hook working...", then "hook says no"), so for a commit
 * that is the line to quote.
 */
export function lastStderrLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && !candidate.startsWith("hint:"));
  return (lines.at(-1) ?? "").replace(/^(?:fatal|error|warning):\s*/iu, "").replace(/^!\s+/u, "");
}

function firstMatchingLine(text: string, pattern: RegExp): string | undefined {
  const line = text
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith("hint:") && pattern.test(candidate));
  return line?.replace(/^(?:fatal|error|warning):\s*/iu, "").replace(/^!\s+/u, "");
}

export function classifyGitFailure(input: GitFailureInput): GitError {
  const stderr = input.stderr ?? "";
  const stderrTail = stderr.length > 2048 ? stderr.slice(-2048) : stderr;
  const verb = PHASE_VERB[input.phase];

  if (input.cancelled) {
    return { code: "cancelled", message: `${verb} was cancelled.`, stderr: stderrTail };
  }
  if (input.timedOut) {
    const seconds = input.deadlineSeconds;
    return {
      code: "timeout",
      message:
        seconds === undefined
          ? `${verb} timed out and was stopped.`
          : `${verb} took longer than ${seconds} s and was stopped.`,
      hint: hintFor("timeout", input.phase),
      stderr: stderrTail,
    };
  }

  const haystack = `${stderr}\n${input.stdout ?? ""}`;
  const rule = RULES.find((candidate) => candidate.pattern.test(haystack));
  const code: GitErrorCode = rule?.code ?? "git_failed";
  // The line that decided the code explains more than whatever came first
  // ("CONFLICT (content): ..." over "Auto-merging a.txt").
  const decisive = rule === undefined ? undefined : firstMatchingLine(haystack, rule.pattern);
  const fallback = input.phase === "commit" ? lastStderrLine(stderr) : firstStderrLine(stderr);
  const detail = decisive ?? (fallback || firstStderrLine(input.stdout ?? ""));
  const message = detail
    ? `${verb} failed: ${detail}`
    : `${verb} failed${input.exitCode === null ? "" : ` (exit ${input.exitCode})`}.`;
  const hint = hintFor(code, input.phase);
  return {
    code,
    message,
    ...(hint === undefined ? {} : { hint }),
    ...(stderrTail.length > 0 ? { stderr: stderrTail } : {}),
  };
}

/** Errors the plugin raises itself, before or instead of running git. */
export function pluginGitError(
  code: GitErrorCode,
  message: string,
  phase: GitPhase,
  extra?: { hint?: string; stderr?: string },
): GitError {
  const hint = extra?.hint ?? hintFor(code, phase);
  return {
    code,
    message,
    ...(hint === undefined ? {} : { hint }),
    ...(extra?.stderr === undefined ? {} : { stderr: extra.stderr }),
  };
}
