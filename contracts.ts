// Single source of truth for every wire boundary of the plugin.
//
//   app.tsx  --rpcContract (keyed by threadId)-->  server.ts
//   server.ts --hostContract (keyed by repoPath)--> host.ts
//   host.ts  --hostSignals (jobEvent, changed)-->  server.ts
//
// server.ts and host.ts import this at runtime; app.tsx imports only types.
// Only @get-bb/plugin-sdk and zod may be imported here: the host artifact
// build rejects private @bb/* packages.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DIFF_SIDES,
  JOB_KINDS,
  MAX_COMMIT_MESSAGE_BYTES,
  MAX_PATHS_PER_CALL,
  MAX_PATH_BYTES_PER_CALL,
  PULL_STRATEGIES,
} from "./shared/constants";
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

/** An abbreviated or full object name. */
export const shaSchema = z.string().regex(/^[0-9a-f]{4,64}$/u, { message: "Invalid object name" });

/** A repository-relative path as git prints it; the host passes it after `--`. */
export const repoFilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0"), {
    message: "Invalid repository path",
  });

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

export const jobKindSchema = z.enum(JOB_KINDS);

/** What every client can learn about a running job from the overview. */
export const jobSummarySchema = z
  .object({
    jobId: z.string().min(1),
    kind: jobKindSchema,
    command: z.string(),
    startedAt: count,
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
    /** The background job holding this repository, if any. */
    activeJob: jobSummarySchema.nullable(),
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
  "not_fully_merged",
  "path_exists",
  "git_too_old",
  "nothing_to_commit",
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

const failure = z.object({ ok: z.literal(false), error: gitErrorSchema }).strict();

// ---------------------------------------------------------------------------
// Jobs: network operations that outlive one host call.
// ---------------------------------------------------------------------------

export const jobEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), command: z.string() }).strict(),
  z.object({ kind: z.literal("output"), line: z.string() }).strict(),
  z.object({ kind: z.literal("finished"), result: actionResultSchema }).strict(),
]);

export const jobStateSchema = jobSummarySchema
  .extend({
    status: z.enum(["running", "finished"]),
    finishedAt: count.nullable(),
    /** The last lines git printed (progress is off, so this is short). */
    output: z.array(z.string()),
    result: actionResultSchema.nullable(),
  })
  .strict();

/** Answer to a job-starting call: the job, or a pre-flight failure. */
export const jobStartSchema = z.union([
  jobSummarySchema.extend({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: gitErrorSchema, overview: overviewSchema.nullable() }).strict(),
]);

const jobTimeoutMs = z.number().int().min(1_000).max(3_600_000);

/** Host -> server events; the server republishes them on realtime. */
export const hostSignals = {
  jobEvent: {
    payload: z.object({ jobId: z.string().min(1), repoRoot: z.string(), event: jobEventSchema }).strict(),
  },
  changed: {
    payload: z.object({ repoRoot: z.string(), reason: z.string() }).strict(),
  },
} satisfies ExperimentalHostSignals;

// ---------------------------------------------------------------------------
// Read payloads for the panels and the revision step
// ---------------------------------------------------------------------------

export const commitSchema = z
  .object({ sha: z.string(), shortSha: z.string(), author: z.string(), committedAt: count, subject: z.string() })
  .strict();

export const fileChangeSchema = z
  .object({
    path: z.string(),
    /** Set for a rename or copy. */
    oldPath: z.string().nullable(),
    additions: count,
    deletions: count,
    binary: z.boolean(),
  })
  .strict();

export const compareResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      base: z.string(),
      target: z.string(),
      aheadCount: count,
      behindCount: count,
      /** Commits only on `target`, newest first. */
      ahead: z.array(commitSchema),
      /** Commits only on `base`, newest first. */
      behind: z.array(commitSchema),
      /** `base...target`: what merging target into base would change. */
      files: z.array(fileChangeSchema),
      truncated: z.object({ ahead: z.boolean(), behind: z.boolean(), files: z.boolean() }).strict(),
    })
    .strict(),
  failure,
]);

export const patchResultSchema = z.union([
  z.object({ ok: z.literal(true), path: z.string(), patch: z.string(), truncated: z.boolean(), binary: z.boolean() }).strict(),
  failure,
]);

export const workingTreeDiffSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      ref: z.string(),
      files: z.array(fileChangeSchema),
      truncated: z.boolean(),
    })
    .strict(),
  failure,
]);

/**
 * One row of the commit panel: a porcelain v2 status entry. `index` and
 * `worktree` are the two status letters (`.` unchanged, M, T, A, D, R, C; U
 * and the pairs AA, DD, AU... on a conflicted entry; `?` in `worktree` for
 * an untracked file).
 */
export const changeEntrySchema = z
  .object({
    path: z.string().min(1),
    /** The original path of a rename or copy. */
    oldPath: z.string().nullable(),
    index: z.string().length(1),
    worktree: z.string().length(1),
    kind: z.enum(["tracked", "untracked", "conflicted"]),
  })
  .strict();

export const changesResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      head: headSchema.nullable(),
      operation: operationSchema,
      indexLocked: z.boolean(),
      files: z.array(changeEntrySchema),
      truncated: z.boolean(),
      /** HEAD, for the amend toggle; null on an unborn branch. */
      lastCommit: z.object({ sha: z.string(), shortSha: z.string(), subject: z.string(), message: z.string() }).strict().nullable(),
    })
    .strict(),
  failure,
]);

export const diffSideSchema = z.enum(DIFF_SIDES);

const fileContentSchema = z.object({ path: z.string(), content: z.string() }).strict();

export const fileDiffSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      path: z.string(),
      side: diffSideSchema,
      patch: z.string(),
      truncated: z.boolean(),
      binary: z.boolean(),
      /**
       * Both complete sides, when textual and small enough; the diff viewer
       * can then expand context between hunks. Null otherwise.
       */
      contents: z.object({ old: fileContentSchema, new: fileContentSchema }).strict().nullable(),
    })
    .strict(),
  failure,
]);

export const tagSchema = z
  .object({ name: z.string(), sha: z.string(), createdAt: count, subject: z.string() })
  .strict();

export const tagListSchema = z.union([
  z.object({ ok: z.literal(true), tags: z.array(tagSchema), truncated: z.boolean() }).strict(),
  failure,
]);

// ---------------------------------------------------------------------------
// Action inputs
// ---------------------------------------------------------------------------

/** A branch as the popup lists it: local by name, or remote by remote and branch. */
export const branchRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), name: branchNameSchema }).strict(),
  z
    .object({ kind: z.literal("remote"), remote: remoteNameSchema, branch: branchNameSchema })
    .strict(),
]);
export const checkoutTargetSchema = branchRefSchema;

export { PULL_STRATEGIES };
export const pullStrategySchema = z.enum(PULL_STRATEGIES);

/**
 * Push is the one action whose previewed command must equal the executed one.
 * `expectedBranch` is the branch the dialog named. With `source` "head" the
 * host refuses (typed) when HEAD is no longer on it; with "branch" the host
 * pushes `refs/heads/<expectedBranch>` whatever HEAD is. `setUpstream` false
 * means "push to the upstream that existed when the dialog was shown", and
 * the host refuses rather than improvising when it no longer holds. `lease`
 * is the remote sha the dialog saw and turns into
 * `--force-with-lease=refs/heads/<upstream>:<lease>`; plain `--force` does
 * not exist.
 */
const pushFields = {
  setUpstream: z.boolean(),
  expectedBranch: branchNameSchema,
  source: z.enum(["head", "branch"]).default("head"),
  /** The local sha the dialog saw; null skips the check. */
  expectedSha: shaSchema.nullable().default(null),
  lease: shaSchema.nullable().default(null),
};

const createBranchFields = {
  name: branchNameSchema,
  /** null = HEAD. */
  startPoint: refishSchema.nullable(),
  checkout: z.boolean(),
};

const deleteBranchFields = { name: branchNameSchema, force: z.boolean() };
const renameBranchFields = { from: branchNameSchema, to: branchNameSchema };
const mergeFields = { ref: branchRefSchema };
const rebaseFields = { onto: branchRefSchema, checkoutFirst: branchRefSchema.nullable() };
const setUpstreamFields = {
  branch: branchNameSchema,
  upstream: z.object({ remote: remoteNameSchema, branch: branchNameSchema }).strict().nullable(),
};
const addWorktreeFields = { ref: branchRefSchema, path: z.string().min(1).max(4096) };
const checkoutRevisionFields = { revision: refishSchema };
const compareFields = { base: branchRefSchema, target: branchRefSchema };
const comparePatchFields = { ...compareFields, path: repoFilePathSchema };
const diffWorkingTreeFields = { ref: branchRefSchema };
const diffWorkingTreePatchFields = { ...diffWorkingTreeFields, path: repoFilePathSchema };
const updateBranchFields = { branch: branchNameSchema };
const deleteRemoteBranchFields = { remote: remoteNameSchema, branch: branchNameSchema };
const jobFields = { jobId: z.string().min(1).max(128) };

const pathBytes = (paths: readonly string[]) => paths.reduce((total, path) => total + path.length + 1, 0);
const withinArgv = (paths: readonly string[]) => pathBytes(paths) <= MAX_PATH_BYTES_PER_CALL;

/** Paths for one `git add` / `reset` / `restore`: they travel on argv, so they are capped. */
export const pathListSchema = z
  .array(repoFilePathSchema)
  .max(MAX_PATHS_PER_CALL)
  .refine(withinArgv, { message: "Too many paths for one call" });
const stageFields = { paths: pathListSchema.refine((paths) => paths.length > 0, { message: "No paths" }) };
/**
 * Discard, per category the app derived from the status letters: paths in
 * HEAD are restored, new files leave the index (kept on disk), untracked
 * files are deleted. The host runs exactly these three commands.
 */
const discardFields = {
  restore: pathListSchema,
  remove: pathListSchema,
  clean: pathListSchema,
};
const commitMessageSchema = z
  .string()
  .min(1)
  .max(MAX_COMMIT_MESSAGE_BYTES)
  .refine((message) => message.trim().length > 0, { message: "Empty commit message" })
  .refine((message) => !message.includes("\0"), { message: "Invalid commit message" });
const commitFields = {
  message: commitMessageSchema,
  amend: z.boolean(),
  signoff: z.boolean(),
  /** Skip the pre-commit and commit-msg hooks (`--no-verify`). */
  noVerify: z.boolean(),
};
/** `oldPath` (a rename's original) joins the pathspec so the patch shows the rename. */
const diffFileFields = { path: repoFilePathSchema, oldPath: repoFilePathSchema.nullable(), side: diffSideSchema };

// ---------------------------------------------------------------------------
// Browser -> server. Every input carries the thread; the server resolves the
// environment and the settings-backed defaults (null means "use the setting").
// ---------------------------------------------------------------------------

const threadInput = z.object({ threadId: z.string().min(1) });
const favouriteNames = z.object({ names: z.array(z.string()) }).strict();

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
    output: jobStartSchema,
  },
  pull: {
    input: threadInput
      .extend({ strategy: pullStrategySchema.nullable(), autoStash: z.boolean().nullable() })
      .strict(),
    output: jobStartSchema,
  },
  push: {
    /** remote null = the default-remote setting (only meaningful with setUpstream). */
    input: threadInput.extend({ remote: remoteNameSchema.nullable(), ...pushFields }).strict(),
    output: jobStartSchema,
  },
  updateBranch: {
    input: threadInput.extend(updateBranchFields).strict(),
    output: jobStartSchema,
  },
  deleteRemoteBranch: {
    input: threadInput.extend(deleteRemoteBranchFields).strict(),
    output: jobStartSchema,
  },
  jobGet: {
    input: threadInput.extend(jobFields).strict(),
    output: jobStateSchema.nullable(),
  },
  jobCancel: {
    input: threadInput.extend(jobFields).strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  deleteBranch: {
    input: threadInput.extend(deleteBranchFields).strict(),
    output: actionResultSchema,
  },
  renameBranch: {
    input: threadInput.extend(renameBranchFields).strict(),
    output: actionResultSchema,
  },
  merge: {
    input: threadInput.extend(mergeFields).strict(),
    output: actionResultSchema,
  },
  rebase: {
    input: threadInput.extend(rebaseFields).strict(),
    output: actionResultSchema,
  },
  abortOperation: {
    input: threadInput.strict(),
    output: actionResultSchema,
  },
  setUpstream: {
    input: threadInput.extend(setUpstreamFields).strict(),
    output: actionResultSchema,
  },
  addWorktree: {
    input: threadInput.extend(addWorktreeFields).strict(),
    output: actionResultSchema,
  },
  checkoutRevision: {
    input: threadInput.extend(checkoutRevisionFields).strict(),
    output: actionResultSchema,
  },
  listTags: {
    input: threadInput.strict(),
    output: tagListSchema,
  },
  compare: {
    input: threadInput.extend(compareFields).strict(),
    output: compareResultSchema,
  },
  comparePatch: {
    input: threadInput.extend(comparePatchFields).strict(),
    output: patchResultSchema,
  },
  diffWorkingTree: {
    input: threadInput.extend(diffWorkingTreeFields).strict(),
    output: workingTreeDiffSchema,
  },
  diffWorkingTreePatch: {
    input: threadInput.extend(diffWorkingTreePatchFields).strict(),
    output: patchResultSchema,
  },
  favourites: {
    input: threadInput.strict(),
    output: favouriteNames,
  },
  setFavourite: {
    input: threadInput.extend({ name: z.string().min(1).max(512), favourite: z.boolean() }).strict(),
    output: favouriteNames,
  },
  changes: {
    input: threadInput.strict(),
    output: changesResultSchema,
  },
  diffFile: {
    input: threadInput.extend(diffFileFields).strict(),
    output: fileDiffSchema,
  },
  stage: {
    input: threadInput.extend(stageFields).strict(),
    output: actionResultSchema,
  },
  unstage: {
    input: threadInput.extend(stageFields).strict(),
    output: actionResultSchema,
  },
  discard: {
    input: threadInput.extend(discardFields).strict(),
    output: actionResultSchema,
  },
  commit: {
    input: threadInput.extend(commitFields).strict(),
    output: jobStartSchema,
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
    input: repoInput
      .extend({ remote: remoteNameSchema.nullable(), prune: z.boolean(), timeoutMs: jobTimeoutMs })
      .strict(),
    output: jobStartSchema,
  },
  pull: {
    input: repoInput
      .extend({ strategy: pullStrategySchema, autoStash: z.boolean(), timeoutMs: jobTimeoutMs })
      .strict(),
    output: jobStartSchema,
  },
  push: {
    input: repoInput.extend({ remote: remoteNameSchema, ...pushFields, timeoutMs: jobTimeoutMs }).strict(),
    output: jobStartSchema,
  },
  updateBranch: {
    input: repoInput.extend({ ...updateBranchFields, timeoutMs: jobTimeoutMs }).strict(),
    output: jobStartSchema,
  },
  deleteRemoteBranch: {
    input: repoInput.extend({ ...deleteRemoteBranchFields, timeoutMs: jobTimeoutMs }).strict(),
    output: jobStartSchema,
  },
  jobGet: {
    input: repoInput.extend(jobFields).strict(),
    output: jobStateSchema.nullable(),
  },
  jobCancel: {
    input: repoInput.extend(jobFields).strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  deleteBranch: {
    input: repoInput.extend(deleteBranchFields).strict(),
    output: actionResultSchema,
  },
  renameBranch: {
    input: repoInput.extend(renameBranchFields).strict(),
    output: actionResultSchema,
  },
  merge: {
    input: repoInput.extend(mergeFields).strict(),
    output: actionResultSchema,
  },
  rebase: {
    input: repoInput.extend(rebaseFields).strict(),
    output: actionResultSchema,
  },
  abortOperation: {
    input: repoInput.strict(),
    output: actionResultSchema,
  },
  setUpstream: {
    input: repoInput.extend(setUpstreamFields).strict(),
    output: actionResultSchema,
  },
  addWorktree: {
    input: repoInput.extend(addWorktreeFields).strict(),
    output: actionResultSchema,
  },
  checkoutRevision: {
    input: repoInput.extend(checkoutRevisionFields).strict(),
    output: actionResultSchema,
  },
  listTags: {
    input: repoInput.strict(),
    output: tagListSchema,
  },
  compare: {
    input: repoInput.extend(compareFields).strict(),
    output: compareResultSchema,
  },
  comparePatch: {
    input: repoInput.extend(comparePatchFields).strict(),
    output: patchResultSchema,
  },
  diffWorkingTree: {
    input: repoInput.extend(diffWorkingTreeFields).strict(),
    output: workingTreeDiffSchema,
  },
  diffWorkingTreePatch: {
    input: repoInput.extend(diffWorkingTreePatchFields).strict(),
    output: patchResultSchema,
  },
  changes: {
    input: repoInput.strict(),
    output: changesResultSchema,
  },
  diffFile: {
    input: repoInput.extend(diffFileFields).strict(),
    output: fileDiffSchema,
  },
  stage: {
    input: repoInput.extend(stageFields).strict(),
    output: actionResultSchema,
  },
  unstage: {
    input: repoInput.extend(stageFields).strict(),
    output: actionResultSchema,
  },
  discard: {
    input: repoInput.extend(discardFields).strict(),
    output: actionResultSchema,
  },
  commit: {
    input: repoInput.extend({ ...commitFields, timeoutMs: jobTimeoutMs }).strict(),
    output: jobStartSchema,
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
export type BranchRef = z.infer<typeof branchRefSchema>;
export type CheckoutTarget = BranchRef;
export type PullStrategy = z.infer<typeof pullStrategySchema>;
export type Upstream = NonNullable<Overview["upstream"]>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type JobStart = z.infer<typeof jobStartSchema>;
export type Commit = z.infer<typeof commitSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type CompareResult = z.infer<typeof compareResultSchema>;
export type PatchResult = z.infer<typeof patchResultSchema>;
export type WorkingTreeDiff = z.infer<typeof workingTreeDiffSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type TagList = z.infer<typeof tagListSchema>;
export type ChangeEntry = z.infer<typeof changeEntrySchema>;
export type ChangesResult = z.infer<typeof changesResultSchema>;
export type FileDiff = z.infer<typeof fileDiffSchema>;
export type DiscardInput = { restore: string[]; remove: string[]; clean: string[] };
export type CommitInput = { message: string; amend: boolean; signoff: boolean; noVerify: boolean };
export type HostSignals = typeof hostSignals;
export type JobEventSignal = z.infer<HostSignals["jobEvent"]["payload"]>;
export type ChangedSignal = z.infer<HostSignals["changed"]["payload"]>;

/** What the server publishes on the `job` realtime channel. */
export interface JobRealtimePayload {
  /** null when the server did not start this job itself (it restarted meanwhile). */
  environmentId: string | null;
  hostId: string;
  jobId: string;
  event: JobEvent;
}

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
    activeJob: null,
  };
}
