// Every action the popup can run: builds the plan, decides whether to ask
// first (with the exact command), calls the server, and reports the outcome
// in the status line. Network operations start a background job and wait
// for its result through `useJobs`.
import { useCallback, useRef, useState } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  ActionResult,
  BranchRef,
  ChangeEntry,
  CheckoutTarget,
  CommitInput,
  GitError,
  JobStart,
  JobSummary,
  LocalBranch,
  Overview,
  RemoteBranch,
} from "../contracts";
import type { rpcContract } from "../server";
import { isValidRemoteName } from "../shared/branch-name";
import { isPullStrategy, type PullStrategy } from "../shared/constants";
import {
  confirmTierFor,
  discardPlanFor,
  discardPlans,
  fullRef,
  gitCommandPreview,
  gitCommandsPreview,
  hasUncommittedChanges,
  pushIntentFor,
  refLabel,
  withLease,
  worktreePathFor,
  type BranchEntry,
  type ConfirmTier,
  type GitPlan,
} from "../shared/model";
import { unexpectedGitError } from "../lib/errors";

export type ActionStatus =
  | { kind: "idle" }
  | { kind: "busy"; text: string }
  | { kind: "ok"; text: string }
  | { kind: "error"; error: GitError };

export interface ConfirmRequest {
  title: string;
  description: string;
  tier: ConfirmTier;
  confirmLabel: string;
  /** Preview of the exact command(s) the host will run, one per line. */
  command: string;
  /** An optional switch that changes the command (force with lease). */
  toggle?: { label: string; command: string; tier: ConfirmTier };
}

interface PendingConfirm extends ConfirmRequest {
  run: (toggled: boolean) => Promise<void>;
}

interface UseVcsActionsOptions {
  threadId: string;
  overview: Overview | null;
  applyOverview: (overview: Overview) => void;
  /** Called after a successful checkout or checkout-creating action. */
  onCheckedOut: () => void;
  /** Waits for a started job; from `useJobs`. */
  waitForJob: (job: JobSummary) => Promise<ActionResult>;
  /**
   * No toasts: the caller shows `status` inline. The commit panel sits where
   * bb stacks its toasts, so a toast there would cover the form it reports on.
   */
  quiet?: boolean;
}

interface EffectiveSettings {
  strategy: PullStrategy;
  autoStash: boolean;
  confirmBeforePush: boolean;
  defaultRemote: string;
}

function readSettings(values: Record<string, string | number | boolean> | undefined): EffectiveSettings {
  const strategy = values?.updateStrategy;
  const remote = values?.defaultRemote;
  return {
    strategy: isPullStrategy(strategy) ? strategy : "ff-only",
    autoStash: values?.autoStash === true,
    confirmBeforePush: values?.confirmBeforePush !== false,
    defaultRemote: typeof remote === "string" && isValidRemoteName(remote) ? remote : "origin",
  };
}

const q = (name: string) => `'${name}'`;

/** The switch a popup entry needs: local by name, remote by tracking (or its local twin). */
function switchPlanFor(ref: BranchRef, overview: Overview): GitPlan {
  if (ref.kind === "local") return { op: "switch", name: ref.name };
  const hasLocal = overview.local.some((branch) => branch.name === ref.branch);
  return hasLocal ? { op: "switch", name: ref.branch } : { op: "switch-track", remote: ref.remote, branch: ref.branch };
}

export function toRef(entry: BranchEntry): BranchRef {
  return entry.kind === "local"
    ? { kind: "local", name: entry.branch.name }
    : { kind: "remote", remote: entry.branch.remote, branch: entry.branch.branch };
}

export function useVcsActions({ threadId, overview, applyOverview, onCheckedOut, waitForJob, quiet = false }: UseVcsActionsOptions) {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const settings = readSettings(values);
  const [status, setStatus] = useState<ActionStatus>({ kind: "idle" });
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const busy = status.kind === "busy";
  // One mutation at a time per pane, whatever path asked for it.
  const inFlight = useRef(false);
  const currentName = overview?.head?.kind === "branch" ? overview.head.name : null;

  const report = useCallback(
    (result: ActionResult, options: { closeOnSuccess?: boolean }) => {
      if (result.overview !== null) applyOverview(result.overview);
      if (result.ok) {
        setStatus({ kind: "ok", text: result.message });
        if (!quiet) toast.success(result.message);
        if (options.closeOnSuccess) onCheckedOut();
      } else {
        setStatus({ kind: "error", error: result.error });
        if (!quiet) toast.error(result.error.message);
      }
    },
    [applyOverview, onCheckedOut, quiet],
  );

  const execute = useCallback(
    async (
      busyText: string,
      call: () => Promise<ActionResult>,
      options: { closeOnSuccess?: boolean } = {},
    ): Promise<ActionResult | null> => {
      if (inFlight.current) {
        toast.error("Another VCS action is still running.");
        return null;
      }
      inFlight.current = true;
      setStatus({ kind: "busy", text: busyText });
      try {
        const result = await call();
        report(result, options);
        return result;
      } catch (cause) {
        const error = unexpectedGitError(cause);
        setStatus({ kind: "error", error });
        if (!quiet) toast.error(error.message);
        return null;
      } finally {
        inFlight.current = false;
      }
    },
    [quiet, report],
  );

  /** Starts a job on the host and waits for its result. */
  const executeJob = useCallback(
    async (busyText: string, start: () => Promise<JobStart>): Promise<ActionResult | null> => {
      if (inFlight.current) {
        toast.error("Another VCS action is still running.");
        return null;
      }
      inFlight.current = true;
      setStatus({ kind: "busy", text: busyText });
      try {
        const started = await start();
        if (!started.ok) {
          const failed: ActionResult = { ok: false, error: started.error, overview: started.overview };
          report(failed, {});
          return failed;
        }
        const result = await waitForJob(started);
        report(result, {});
        return result;
      } catch (cause) {
        const error = unexpectedGitError(cause);
        setStatus({ kind: "error", error });
        if (!quiet) toast.error(error.message);
        return null;
      } finally {
        inFlight.current = false;
      }
    },
    [quiet, report, waitForJob],
  );

  const requestOrRun = useCallback((request: ConfirmRequest, run: (toggled: boolean) => Promise<void>) => {
    if (request.tier === "none") {
      void run(false);
      return;
    }
    setConfirm({ ...request, run });
  }, []);

  const tierContext = useCallback(
    () => ({
      hasUncommittedChanges: overview !== null && hasUncommittedChanges(overview),
      confirmBeforePush: settings.confirmBeforePush,
    }),
    [overview, settings.confirmBeforePush],
  );

  // -------------------------------------------------------------------------
  // Milestone 1 actions
  // -------------------------------------------------------------------------

  const checkout = useCallback(
    (target: CheckoutTarget) => {
      const name = refLabel(target);
      return execute(`Checking out ${name}…`, () => rpc.call("checkout", { threadId, target }), {
        closeOnSuccess: true,
      });
    },
    [execute, rpc, threadId],
  );

  const createBranch = useCallback(
    (input: { name: string; startPoint: string | null; checkout: boolean }) =>
      execute(`Creating ${input.name}…`, () => rpc.call("createBranch", { threadId, ...input }), {
        closeOnSuccess: input.checkout,
      }),
    [execute, rpc, threadId],
  );

  const fetch = useCallback(
    () => executeJob("Fetching…", () => rpc.call("fetch", { threadId, remote: null, prune: null })),
    [executeJob, rpc, threadId],
  );

  const update = useCallback(() => {
    const plan: GitPlan = { op: "pull", strategy: settings.strategy, autoStash: settings.autoStash };
    requestOrRun(
      {
        title: "Update Project",
        description:
          "You have uncommitted changes. Update Project will run the command below; git refuses to overwrite local changes, and auto-stash can be turned on in the plugin settings.",
        tier: confirmTierFor(plan, tierContext()),
        confirmLabel: "Update",
        command: gitCommandPreview(plan),
      },
      async () => {
        await executeJob("Updating project…", () => rpc.call("pull", { threadId, strategy: null, autoStash: null }));
      },
    );
  }, [executeJob, requestOrRun, rpc, settings.autoStash, settings.strategy, threadId, tierContext]);

  /** Push from a given overview: the current branch, or `branch` by its own ref. */
  const pushWith = useCallback(
    (view: Overview, branch?: LocalBranch) => {
      const intent = pushIntentFor(view, settings.defaultRemote, branch);
      if (intent === null) {
        toast.error("Check out a branch first.");
        return;
      }
      const { plan, target } = intent;
      const name = intent.branch;
      const description =
        intent.reason === "tracked"
          ? `Push ${name} to ${target}.`
          : intent.reason === "gone"
            ? `The upstream ${intent.upstreamName ?? ""} no longer exists. This creates ${target} and tracks it.`
            : intent.reason === "local-upstream"
              ? `${name} tracks ${intent.upstreamName ?? "a local branch"}, which is not on a remote. This creates ${target} and tracks it.`
              : `${name} has no upstream yet. This creates ${target} and tracks it.`;
      const leased = withLease(plan, intent.remoteSha);
      const canLease = !plan.setUpstream && intent.remoteSha !== null;
      requestOrRun(
        {
          title: plan.setUpstream ? `Push ${name} and set upstream` : `Push ${name}`,
          description,
          tier: confirmTierFor(plan, tierContext()),
          confirmLabel: "Push",
          command: gitCommandPreview(plan),
          ...(canLease
            ? {
                toggle: {
                  label: `Force with lease: overwrite ${target} only if it is still at ${intent.remoteSha}`,
                  command: gitCommandPreview(leased),
                  tier: confirmTierFor(leased, tierContext()),
                },
              }
            : {}),
        },
        async (toggled) => {
          await executeJob(toggled ? `Force-pushing ${name}…` : `Pushing ${name}…`, () =>
            rpc.call("push", {
              threadId,
              remote: plan.remote,
              setUpstream: plan.setUpstream,
              expectedBranch: name,
              source: plan.branch === null ? "head" : "branch",
              expectedSha: intent.sha,
              lease: toggled && canLease ? intent.remoteSha : null,
            }),
          );
        },
      );
    },
    [executeJob, requestOrRun, rpc, settings.defaultRemote, threadId, tierContext],
  );

  /** Push the current branch, or `branch` by its own ref, from the overview on screen. */
  const push = useCallback(
    (branch?: LocalBranch) => {
      if (overview !== null) pushWith(overview, branch);
    },
    [overview, pushWith],
  );

  // -------------------------------------------------------------------------
  // Milestone 2 actions
  // -------------------------------------------------------------------------

  const updateBranch = useCallback(
    (branch: LocalBranch) => {
      if (branch.isCurrent) {
        update();
        return;
      }
      void executeJob(`Updating ${branch.name}…`, () => rpc.call("updateBranch", { threadId, branch: branch.name }));
    },
    [executeJob, rpc, threadId, update],
  );

  const checkoutAndUpdate = useCallback(
    async (branch: LocalBranch) => {
      const switched = await execute(`Checking out ${branch.name}…`, () =>
        rpc.call("checkout", { threadId, target: { kind: "local", name: branch.name } }),
      );
      if (switched?.ok) update();
    },
    [execute, rpc, threadId, update],
  );

  const deleteBranch = useCallback(
    (branch: LocalBranch) => {
      const name = branch.name;
      const plan: GitPlan = { op: "delete-local", name, force: false };
      requestOrRun(
        {
          title: `Delete ${name}`,
          description: `Delete the local branch ${q(name)}. Git refuses when it has commits that are not merged anywhere; you will be asked again then.`,
          tier: confirmTierFor(plan, tierContext()),
          confirmLabel: "Delete",
          command: gitCommandPreview(plan),
        },
        async () => {
          const result = await execute(`Deleting ${name}…`, () => rpc.call("deleteBranch", { threadId, name, force: false }));
          if (result === null || result.ok || result.error.code !== "not_fully_merged") return;
          const forced: GitPlan = { op: "delete-local", name, force: true };
          setConfirm({
            title: `Delete ${name} anyway?`,
            description: `${q(name)} has commits that are not on any other branch. Deleting it discards them.`,
            tier: "destructive",
            confirmLabel: "Delete anyway",
            command: gitCommandPreview(forced),
            run: async () => {
              await execute(`Deleting ${name}…`, () => rpc.call("deleteBranch", { threadId, name, force: true }));
            },
          });
        },
      );
    },
    [execute, requestOrRun, rpc, threadId, tierContext],
  );

  const deleteRemoteBranch = useCallback(
    (branch: RemoteBranch) => {
      const plan: GitPlan = { op: "delete-remote", remote: branch.remote, branch: branch.branch };
      requestOrRun(
        {
          title: `Delete ${branch.name} on ${branch.remote}`,
          description: `Delete the branch ${q(branch.branch)} on the remote ${q(branch.remote)}. Other clones lose it on their next fetch with prune.`,
          tier: confirmTierFor(plan, tierContext()),
          confirmLabel: "Delete on remote",
          command: gitCommandPreview(plan),
        },
        async () => {
          await executeJob(`Deleting ${branch.name}…`, () =>
            rpc.call("deleteRemoteBranch", { threadId, remote: branch.remote, branch: branch.branch }),
          );
        },
      );
    },
    [executeJob, requestOrRun, rpc, threadId, tierContext],
  );

  const renameBranch = useCallback(
    (from: string, to: string) =>
      execute(`Renaming ${from}…`, () => rpc.call("renameBranch", { threadId, from, to })),
    [execute, rpc, threadId],
  );

  const merge = useCallback(
    (ref: BranchRef) => {
      const label = refLabel(ref);
      const plan: GitPlan = { op: "merge", ref: fullRef(ref) };
      requestOrRun(
        {
          title: `Merge ${label} into ${currentName ?? "the current branch"}`,
          description: "Conflicts leave the merge in progress; the popup then offers Abort.",
          tier: confirmTierFor(plan, tierContext()),
          confirmLabel: "Merge",
          command: gitCommandPreview(plan),
        },
        async () => {
          await execute(`Merging ${label}…`, () => rpc.call("merge", { threadId, ref }));
        },
      );
    },
    [currentName, execute, requestOrRun, rpc, threadId, tierContext],
  );

  /** Rebase the current branch onto `onto`; with `checkoutFirst`, switch to that branch first and rebase it. */
  const rebase = useCallback(
    (onto: BranchRef, checkoutFirst: BranchRef | null) => {
      if (overview === null) return;
      const ontoLabel = refLabel(onto);
      const plans: GitPlan[] = [
        ...(checkoutFirst === null ? [] : [switchPlanFor(checkoutFirst, overview)]),
        { op: "rebase", onto: fullRef(onto) },
      ];
      const rebased = checkoutFirst === null ? (currentName ?? "the current branch") : refLabel(checkoutFirst);
      requestOrRun(
        {
          title: checkoutFirst === null ? `Rebase ${rebased} onto ${ontoLabel}` : `Checkout ${rebased} and rebase onto ${ontoLabel}`,
          description: "Rewrites the rebased branch's commits. Conflicts leave the rebase in progress; the popup then offers Abort.",
          tier: "confirm",
          confirmLabel: "Rebase",
          command: gitCommandsPreview(plans),
        },
        async () => {
          await execute(`Rebasing ${rebased}…`, () => rpc.call("rebase", { threadId, onto, checkoutFirst }), {
            closeOnSuccess: checkoutFirst !== null,
          });
        },
      );
    },
    [currentName, execute, overview, requestOrRun, rpc, threadId],
  );

  const abortOperation = useCallback(() => {
    if (overview === null || overview.operation === "none") return;
    const plan: GitPlan = { op: "abort", operation: overview.operation };
    requestOrRun(
      {
        title: `Abort the ${overview.operation}`,
        description: `Returns the worktree to the state before the ${overview.operation} started. Conflict resolutions made so far are discarded.`,
        tier: confirmTierFor(plan, tierContext()),
        confirmLabel: "Abort",
        command: gitCommandPreview(plan),
      },
      async () => {
        await execute(`Aborting the ${overview.operation}…`, () => rpc.call("abortOperation", { threadId }));
      },
    );
  }, [execute, overview, requestOrRun, rpc, threadId, tierContext]);

  const setUpstream = useCallback(
    (branch: LocalBranch, upstream: { remote: string; branch: string } | null) =>
      execute(`Updating the tracked branch of ${branch.name}…`, () =>
        rpc.call("setUpstream", { threadId, branch: branch.name, upstream }),
      ),
    [execute, rpc, threadId],
  );

  const addWorktree = useCallback(
    (entry: BranchEntry) => {
      if (overview === null || overview.repoRoot === null) return;
      const ref = toRef(entry);
      const branchName = ref.kind === "local" ? ref.name : ref.branch;
      const path = worktreePathFor(overview.repoRoot, branchName);
      const plan: GitPlan =
        ref.kind === "local"
          ? { op: "worktree-add", path, branch: ref.name }
          : { op: "worktree-add-track", path, remote: ref.remote, branch: ref.branch };
      requestOrRun(
        {
          title: `New worktree from ${refLabel(ref)}`,
          description: `Creates ${path} next to the repository with ${q(branchName)} checked out. Open it as a new bb environment to work there.`,
          tier: confirmTierFor(plan, tierContext()),
          confirmLabel: "Add worktree",
          command: gitCommandPreview(plan),
        },
        async () => {
          await execute(`Adding worktree…`, () => rpc.call("addWorktree", { threadId, ref, path }));
        },
      );
    },
    [execute, overview, requestOrRun, rpc, threadId, tierContext],
  );

  const checkoutRevision = useCallback(
    (revision: string) => {
      const plan: GitPlan = { op: "switch-detach", revision };
      requestOrRun(
        {
          title: `Checkout ${revision}`,
          description: "Leaves HEAD detached at that commit. Create a branch from it to keep new commits.",
          tier: confirmTierFor(plan, tierContext()),
          confirmLabel: "Checkout",
          command: gitCommandPreview(plan),
        },
        async () => {
          await execute(`Checking out ${revision}…`, () => rpc.call("checkoutRevision", { threadId, revision }), {
            closeOnSuccess: true,
          });
        },
      );
    },
    [execute, requestOrRun, rpc, threadId, tierContext],
  );

  // -------------------------------------------------------------------------
  // Milestone 3: the commit panel
  // -------------------------------------------------------------------------

  const stage = useCallback(
    (paths: string[]) => execute("Staging…", () => rpc.call("stage", { threadId, paths })),
    [execute, rpc, threadId],
  );

  const unstage = useCallback(
    (paths: string[]) => execute("Unstaging…", () => rpc.call("unstage", { threadId, paths })),
    [execute, rpc, threadId],
  );

  const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;

  /** Discard is always destructive: the dialog lists every command by category. */
  const discard = useCallback(
    (entries: readonly ChangeEntry[]) => {
      const plan = discardPlanFor(entries);
      const plans = discardPlans(plan);
      if (plans.length === 0) {
        toast.error(plan.skipped.length > 0 ? "Conflicted files cannot be discarded; resolve them first." : "Nothing to discard.");
        return;
      }
      const total = plan.restore.length + plan.remove.length + plan.clean.length;
      const parts = [
        plan.restore.length > 0 ? `revert ${files(plan.restore.length)} to HEAD` : null,
        plan.remove.length > 0 ? `unstage ${files(plan.remove.length)} new to git (kept on disk)` : null,
        plan.clean.length > 0 ? `delete ${files(plan.clean.length)} git does not track` : null,
      ].filter((part): part is string => part !== null);
      requestOrRun(
        {
          title: `Discard changes in ${files(total)}`,
          description: `This will ${parts.join(", ")}.${plan.skipped.length > 0 ? " Conflicted files are skipped." : ""} Reverted edits and deleted files cannot be recovered.`,
          tier: "destructive",
          confirmLabel: "Discard",
          command: gitCommandsPreview(plans),
        },
        async () => {
          await execute("Discarding…", () =>
            rpc.call("discard", { threadId, restore: plan.restore, remove: plan.remove, clean: plan.clean }),
          );
        },
      );
    },
    [execute, requestOrRun, rpc, threadId],
  );

  /**
   * Commit the index as a job; an amend asks first. With `andPush` the
   * existing push flow follows on the overview the commit reported, so the
   * push dialog names the new sha.
   */
  const commit = useCallback(
    (input: CommitInput, options: { andPush: boolean; onDone?: (result: ActionResult) => void }) => {
      const plan: GitPlan = { op: "commit", amend: input.amend, signoff: input.signoff, noVerify: input.noVerify };
      requestOrRun(
        {
          title: "Amend the last commit",
          description:
            "Replaces HEAD with a new commit holding its changes plus what is staged, under this message. If HEAD was pushed already, the next push needs force with lease.",
          tier: confirmTierFor(plan, tierContext()),
          confirmLabel: "Amend",
          command: gitCommandPreview(plan),
        },
        async () => {
          const result = await executeJob(input.amend ? "Amending…" : "Committing…", () => rpc.call("commit", { threadId, ...input }));
          if (result === null) return;
          options.onDone?.(result);
          if (!result.ok || !options.andPush) return;
          let view = result.overview;
          if (view === null) {
            try {
              view = await rpc.call("overview", { threadId });
            } catch (cause) {
              toast.error(`Committed, but the repository could not be read for the push: ${unexpectedGitError(cause).message}`);
              return;
            }
            applyOverview(view);
          }
          pushWith(view);
        },
      );
    },
    [applyOverview, executeJob, pushWith, requestOrRun, rpc, threadId, tierContext],
  );

  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const acceptConfirm = useCallback(
    (toggled: boolean) => {
      const pending = confirm;
      setConfirm(null);
      if (pending) void pending.run(toggled);
    },
    [confirm],
  );

  const clearStatus = useCallback(() => setStatus((current) => (current.kind === "busy" ? current : { kind: "idle" })), []);

  return {
    status,
    busy,
    confirm,
    settings,
    checkout,
    createBranch,
    fetch,
    update,
    push,
    updateBranch,
    checkoutAndUpdate,
    deleteBranch,
    deleteRemoteBranch,
    renameBranch,
    merge,
    rebase,
    abortOperation,
    setUpstream,
    addWorktree,
    checkoutRevision,
    stage,
    unstage,
    discard,
    commit,
    cancelConfirm,
    acceptConfirm,
    clearStatus,
  };
}
