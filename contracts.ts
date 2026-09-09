// Single source of truth for every wire boundary of the plugin.
//
//   app.tsx  --rpcContract (keyed by threadId)-->  server.ts
//   server.ts --hostContract (keyed by repoPath)--> host.ts
//
// server.ts and host.ts import this at runtime; app.tsx imports only types.
// Only @get-bb/plugin-sdk and zod may be imported here: the host artifact
// build rejects private @bb/* packages.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PULL_STRATEGIES } from "./shared/constants";
import {
  MAX_BRANCH_NAME_LENGTH,
  isValidGitBranchName,
  isValidRefish,
  isValidRemoteName,
} from "./shared/branch-name";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const branchNameSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_NAME_LENGTH)
  .refine(isValidGitBranchName, { message: "Invalid git branch name" });

export const remoteNameSchema = z
  .string()
  .refine(isValidRemoteName, { message: "Invalid remote name" });

export const refishSchema = z
  .string()
  .refine(isValidRefish, { message: "Invalid revision" });

// ---------------------------------------------------------------------------
// Overview: everything the popup renders, produced by the host.
// ---------------------------------------------------------------------------

export const headSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string(), sha: z.string() }).strict(),
  z.object({ kind: z.literal("detached"), sha: z.string() }).strict(),
  z.object({ kind: z.literal("unborn"), name: z.string() }).strict(),
]);

export const OPERATIONS = ["none", "merge", "rebase", "cherry-pick", "revert"] as const;
export const operationSchema = z.enum(OPERATIONS);

const count = z.number().int().nonnegative();

export const localBranchSchema = z
  .object({
    name: z.string(),
    sha: z.string(),
    upstream: z.string().nullable(),
    ahead: count,
    behind: count,
    gone: z.boolean(),
    isCurrent: z.boolean(),
    worktreePath: z.string().nullable(),
    committedAt: count,
    subject: z.string(),
  })
  .strict();

export const remoteBranchSchema = z
  .object({
    /** Full short name, e.g. "origin/feature". */
    name: z.string(),
    remote: z.string(),
    branch: z.string(),
    sha: z.string(),
    hasLocal: z.boolean(),
    committedAt: count,
    subject: z.string(),
  })
  .strict();

export const overviewSchema = z
  .object({
    /** Set when the thread has no usable git worktree; lists are then empty. */
    unavailableReason: z.string().nullable(),
    repoRoot: z.string().nullable(),
    repoName: z.string().nullable(),
    gitVersion: z.string().nullable(),
    head: headSchema.nullable(),
    operation: operationSchema,
    indexLocked: z.boolean(),
    /**
     * The current branch's upstream. `remote`/`branch` are null when the
     * upstream is not `<configured remote>/<branch>` (a local upstream);
     * `gone` when the remote-tracking ref no longer exists.
     */
    upstream: z
      .object({
        name: z.string(),
        remote: z.string().nullable(),
        branch: z.string().nullable(),
        ahead: count,
        behind: count,
        gone: z.boolean(),
      })
      .strict()
      .nullable(),
    workingTree: z
      .object({ staged: count, unstaged: count, untracked: count, conflicted: count })
      .strict(),
    local: z.array(localBranchSchema),
    remote: z.array(remoteBranchSchema),
    /** Local branch names, most recently checked out first, current excluded. */
    recent: z.array(z.string()),
    remotes: z.array(z.string()),
    truncated: z.object({ local: z.boolean(), remote: z.boolean() }).strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Results: expected git outcomes are values, never thrown errors.
// ---------------------------------------------------------------------------

export const GIT_ERROR_CODES = [
  "dirty_worktree",
  "index_locked",
  "operation_in_progress",
  "ref_exists",
  "ref_not_found",
  "invalid_ref_name",
  "no_upstream",
  "no_remote",
  "auth_required",
  "network",
  "non_fast_forward",
  "conflict",
  "detached_head",
  "busy",
  "timeout",
  "cancelled",
  "not_a_repo",
  "head_changed",
  "git_failed",
] as const;
export const gitErrorCodeSchema = z.enum(GIT_ERROR_CODES);

export const gitErrorSchema = z
  .object({
    code: gitErrorCodeSchema,
    message: z.string(),
    hint: z.string().optional(),
    stderr: z.string().optional(),
  })
  .strict();

// `overview` is null on success only when the host ran out of time to read
// the repository afterwards; the app then refetches.
export const actionResultSchema = z.union([
  z.object({ ok: z.literal(true), message: z.string(), overview: overviewSchema.nullable() }).strict(),
  z
    .object({ ok: z.literal(false), error: gitErrorSchema, overview: overviewSchema.nullable() })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Action inputs
// ---------------------------------------------------------------------------

export const checkoutTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), name: branchNameSchema }).strict(),
  z
    .object({ kind: z.literal("remote"), remote: remoteNameSchema, branch: branchNameSchema })
    .strict(),
]);

export { PULL_STRATEGIES };
export const pullStrategySchema = z.enum(PULL_STRATEGIES);

/**
 * Push is the one action whose previewed command must equal the executed one.
 * `expectedBranch` is the branch the dialog named; `setUpstream` false means
 * "push HEAD to the upstream that existed when the dialog was shown", and the
 * host refuses (typed) rather than improvising when either no longer holds.
 */
const pushFields = {
  setUpstream: z.boolean(),
  expectedBranch: branchNameSchema,
};

const createBranchFields = {
  name: branchNameSchema,
  /** null = HEAD. */
  startPoint: refishSchema.nullable(),
  checkout: z.boolean(),
};

// ---------------------------------------------------------------------------
// Browser -> server. Every input carries the thread; the server resolves the
// environment and the settings-backed defaults (null means "use the setting").
// ---------------------------------------------------------------------------

const threadInput = z.object({ threadId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  overview: {
    input: threadInput.strict(),
    output: overviewSchema,
  },
  checkout: {
    input: threadInput.extend({ target: checkoutTargetSchema }).strict(),
    output: actionResultSchema,
  },
  createBranch: {
    input: threadInput.extend(createBranchFields).strict(),
    output: actionResultSchema,
  },
  fetch: {
    input: threadInput
      .extend({ remote: remoteNameSchema.nullable(), prune: z.boolean().nullable() })
      .strict(),
    output: actionResultSchema,
  },
  pull: {
    input: threadInput
      .extend({ strategy: pullStrategySchema.nullable(), autoStash: z.boolean().nullable() })
      .strict(),
    output: actionResultSchema,
  },
  push: {
    /** remote null = the default-remote setting (only meaningful with setUpstream). */
    input: threadInput.extend({ remote: remoteNameSchema.nullable(), ...pushFields }).strict(),
    output: actionResultSchema,
  },
});

// ---------------------------------------------------------------------------
// Server -> host. Every input carries the absolute worktree path bb recorded
// for the environment; defaults are already resolved.
// ---------------------------------------------------------------------------

const repoInput = z.object({ repoPath: z.string().min(1).max(16_384) });

export const hostContract = defineRpcContract({
  overview: {
    input: repoInput.extend({ recentLimit: z.number().int().min(0).max(50) }).strict(),
    output: overviewSchema,
  },
  checkout: {
    input: repoInput.extend({ target: checkoutTargetSchema }).strict(),
    output: actionResultSchema,
  },
  createBranch: {
    input: repoInput.extend(createBranchFields).strict(),
    output: actionResultSchema,
  },
  fetch: {
    /** remote null = every remote (`--all`). */
    input: repoInput.extend({ remote: remoteNameSchema.nullable(), prune: z.boolean() }).strict(),
    output: actionResultSchema,
  },
  pull: {
    input: repoInput.extend({ strategy: pullStrategySchema, autoStash: z.boolean() }).strict(),
    output: actionResultSchema,
  },
  push: {
    input: repoInput.extend({ remote: remoteNameSchema, ...pushFields }).strict(),
    output: actionResultSchema,
  },
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Head = z.infer<typeof headSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type LocalBranch = z.infer<typeof localBranchSchema>;
export type RemoteBranch = z.infer<typeof remoteBranchSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type GitErrorCode = z.infer<typeof gitErrorCodeSchema>;
export type GitError = z.infer<typeof gitErrorSchema>;
export type ActionResult = z.infer<typeof actionResultSchema>;
export type CheckoutTarget = z.infer<typeof checkoutTargetSchema>;
export type PullStrategy = z.infer<typeof pullStrategySchema>;
export type Upstream = NonNullable<Overview["upstream"]>;

/** An overview for a thread without a usable repository. */
export function unavailableOverview(reason: string): Overview {
  return {
    unavailableReason: reason,
    repoRoot: null,
    repoName: null,
    gitVersion: null,
    head: null,
    operation: "none",
    indexLocked: false,
    upstream: null,
    workingTree: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    local: [],
    remote: [],
    recent: [],
    remotes: [],
    truncated: { local: false, remote: false },
  };
}
