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
/** A commit message travels as one RPC string and then on git's stdin. */
export const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
/** Changed files listed by the commit panel. */
export const CHANGES_LIMIT = 500;

/** Which side of a change a file diff shows: HEAD → index, or index → working tree. */
export const DIFF_SIDES = ["index", "worktree"] as const;
export type DiffSide = (typeof DIFF_SIDES)[number];

/** `git switch` and `--end-of-options` arrived in 2.24. */
export const MIN_GIT_VERSION = { major: 2, minor: 24 } as const;
