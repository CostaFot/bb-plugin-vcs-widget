import { useCallback, useState } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ActionResult, CheckoutTarget, GitError, Overview, PullStrategy } from "../contracts";
import { PULL_STRATEGIES } from "../contracts";
import type { rpcContract } from "../server";
import { isValidRemoteName } from "../shared/branch-name";
import {
  confirmTierFor,
  gitCommandPreview,
  hasUncommittedChanges,
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
  plan: GitPlan;
  tier: ConfirmTier;
  confirmLabel: string;
  /** Preview of the exact command the host will run. */
  command: string;
}

interface UseVcsActionsOptions {
  threadId: string;
  overview: Overview | null;
  applyOverview: (overview: Overview) => void;
  /** Called after a successful checkout or checkout-creating action. */
  onCheckedOut: () => void;
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
    strategy:
      typeof strategy === "string" && (PULL_STRATEGIES as readonly string[]).includes(strategy)
        ? (strategy as PullStrategy)
        : "ff-only",
    autoStash: values?.autoStash === true,
    confirmBeforePush: values?.confirmBeforePush !== false,
    defaultRemote: typeof remote === "string" && isValidRemoteName(remote) ? remote : "origin",
  };
}

export function useVcsActions({ threadId, overview, applyOverview, onCheckedOut }: UseVcsActionsOptions) {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const settings = readSettings(values);
  const [status, setStatus] = useState<ActionStatus>({ kind: "idle" });
  const [confirm, setConfirm] = useState<(ConfirmRequest & { run: () => Promise<void> }) | null>(null);
  const busy = status.kind === "busy";

  const execute = useCallback(
    async (
      busyText: string,
      call: () => Promise<ActionResult>,
      options: { closeOnSuccess?: boolean } = {},
    ): Promise<ActionResult | null> => {
      setStatus({ kind: "busy", text: busyText });
      try {
        const result = await call();
        if (result.overview !== null) applyOverview(result.overview);
        if (result.ok) {
          setStatus({ kind: "ok", text: result.message });
          toast.success(result.message);
          if (options.closeOnSuccess) onCheckedOut();
        } else {
          setStatus({ kind: "error", error: result.error });
          toast.error(result.error.message);
        }
        return result;
      } catch (cause) {
        const error = unexpectedGitError(cause);
        setStatus({ kind: "error", error });
        toast.error(error.message);
        return null;
      }
    },
    [applyOverview, onCheckedOut],
  );

  const checkout = useCallback(
    (target: CheckoutTarget) => {
      const name = target.kind === "local" ? target.name : `${target.remote}/${target.branch}`;
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
    () => execute("Fetching…", () => rpc.call("fetch", { threadId, remote: null, prune: null })),
    [execute, rpc, threadId],
  );

  const requestOrRun = useCallback(
    (request: ConfirmRequest, run: () => Promise<void>) => {
      if (request.tier === "none") {
        void run();
        return;
      }
      setConfirm({ ...request, run });
    },
    [],
  );

  const update = useCallback(() => {
    const plan: GitPlan = { op: "pull", strategy: settings.strategy, autoStash: settings.autoStash };
    const tier = confirmTierFor(plan, {
      hasUncommittedChanges: overview !== null && hasUncommittedChanges(overview),
      confirmBeforePush: settings.confirmBeforePush,
    });
    requestOrRun(
      {
        title: "Update Project",
        description:
          "You have uncommitted changes. Update Project will run the command below; git refuses to overwrite local changes, and auto-stash can be turned on in the plugin settings.",
        plan,
        tier,
        confirmLabel: "Update",
        command: gitCommandPreview(plan),
      },
      async () => {
        await execute("Updating project…", () =>
          rpc.call("pull", { threadId, strategy: null, autoStash: null }),
        );
      },
    );
  }, [execute, overview, requestOrRun, rpc, settings.autoStash, settings.confirmBeforePush, settings.strategy, threadId]);

  const push = useCallback(() => {
    const branch = overview?.head?.kind === "branch" ? overview.head.name : "HEAD";
    const setUpstream = overview?.upstream === null || overview?.upstream === undefined;
    const plan: GitPlan = { op: "push", remote: settings.defaultRemote, setUpstream };
    const tier = confirmTierFor(plan, {
      hasUncommittedChanges: overview !== null && hasUncommittedChanges(overview),
      confirmBeforePush: settings.confirmBeforePush,
    });
    requestOrRun(
      {
        title: setUpstream ? `Push ${branch} and set upstream` : `Push ${branch}`,
        description: setUpstream
          ? `${branch} has no upstream yet. This creates ${settings.defaultRemote}/${branch} and tracks it.`
          : `Push ${branch} to ${overview?.upstream?.name ?? settings.defaultRemote}.`,
        plan,
        tier,
        confirmLabel: "Push",
        command: gitCommandPreview(plan),
      },
      async () => {
        await execute("Pushing…", () => rpc.call("push", { threadId, remote: null, setUpstream }));
      },
    );
  }, [execute, overview, requestOrRun, rpc, settings.confirmBeforePush, settings.defaultRemote, threadId]);

  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const acceptConfirm = useCallback(() => {
    const pending = confirm;
    setConfirm(null);
    if (pending) void pending.run();
  }, [confirm]);

  const clearStatus = useCallback(() => setStatus({ kind: "idle" }), []);

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
    cancelConfirm,
    acceptConfirm,
    clearStatus,
  };
}
