// Values the browser bundle needs that must not drag zod (contracts.ts) or
// server code into app.js. contracts.ts and server/* import from here too.

export const PULL_STRATEGIES = ["ff-only", "rebase", "merge"] as const;
export type PullStrategy = (typeof PULL_STRATEGIES)[number];

export function isPullStrategy(value: unknown): value is PullStrategy {
  return typeof value === "string" && (PULL_STRATEGIES as readonly string[]).includes(value);
}

/** Realtime channel the app listens on; payload `{ environmentId?, hostId?, reason }`. */
export const CHANGED_CHANNEL = "changed";

export interface ChangedPayload {
  /** Absent when the server cannot map the change to an environment (everyone refetches). */
  environmentId?: string;
  hostId?: string;
  reason: string;
}

/** Realtime channel for background job progress; payload is a `JobRealtimePayload`. */
export const JOB_CHANNEL = "job";

/**
 * Host work that runs as a background job instead of inside one host call:
 * network operations, and commit because hooks can take longer than 30 s.
 */
export const JOB_KINDS = ["fetch", "pull", "push", "updateBranch", "deleteRemoteBranch", "commit"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

/** Default and bounds of the `jobTimeoutSeconds` setting. */
export const JOB_TIMEOUT_SECONDS = { default: 600, min: 30, max: 3600 } as const;

/** Paths per stage / unstage / discard call, and the bytes they may add up to (argv, not stdin). */
export const MAX_PATHS_PER_CALL = 500;
export const MAX_PATH_BYTES_PER_CALL = 256 * 1024;

/** What one path list costs on argv: the path plus its NUL separator. */
export function pathListBytes(paths: readonly string[]): number {
  return paths.reduce((total, path) => total + path.length + 1, 0);
}

/**
 * Whether a path list fits one call, by the same two caps the contract
 * enforces. The app asks before it offers a whole-group action, so a discard
 * of hundreds of long paths says so instead of failing validation.
 */
export function fitsPathList(paths: readonly string[]): boolean {
  return paths.length <= MAX_PATHS_PER_CALL && pathListBytes(paths) <= MAX_PATH_BYTES_PER_CALL;
}
/** A commit message travels as one RPC string and then on git's stdin. */
export const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
/** Changed files listed by the commit panel. */
export const CHANGES_LIMIT = 500;

/** Commits per log page; the host reads one more to learn whether another page exists. */
export const LOG_PAGE_SIZE = 100;
/** How far "Load more" may walk with `--skip`. */
export const LOG_MAX_SKIP = 10_000;
/** Longest message filter the log accepts; it travels as one `--grep` argument. */
export const MAX_LOG_GREP_LENGTH = 200;
/** Log rows are a fixed height so the list can be virtualised without measuring. */
export const LOG_ROW_HEIGHT = 26;

/** How `git reset` moves the current branch: index and worktree, index only, neither. */
export const RESET_MODES = ["soft", "mixed", "hard"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/** Which side of a change a file diff shows: HEAD → index, or index → working tree. */
export const DIFF_SIDES = ["index", "worktree"] as const;
export type DiffSide = (typeof DIFF_SIDES)[number];

/**
 * The commit panel's two agent buttons: what each one says to the human and
 * what it sends to the thread's agent, as if the human had typed it.
 *
 * The messages are fixed and the caller names a variant, never the text —
 * these two lines are the whole of what the plugin can say to an agent, and
 * a repository that needs other words is a setting for later. Label and
 * message differ on purpose: the button is read beside "Commit" and
 * "Commit and Push", where "Agent" is the word that separates them, while
 * the message is read in the thread's transcript, where "LGTM - Commit"
 * carries the human's verdict along with the instruction.
 */
export const AGENT_ACTIONS = {
  commit: { label: "Agent Commit", message: "LGTM - Commit" },
  "commit-push": { label: "Agent Commit & Push", message: "LGTM - Commit & Push" },
} as const;

export type AgentActionVariant = keyof typeof AGENT_ACTIONS;

/** The variants in button order, so the contract and the panel cannot drift. */
export const AGENT_ACTION_VARIANTS = ["commit", "commit-push"] as const satisfies readonly AgentActionVariant[];

/** `git switch` and `--end-of-options` arrived in 2.24. */
export const MIN_GIT_VERSION = { major: 2, minor: 24 } as const;
