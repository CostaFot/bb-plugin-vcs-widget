import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BranchRef } from "../contracts";
import { useFavourites } from "../hooks/use-favourites";
import { useJobs } from "../hooks/use-jobs";
import { useOverview } from "../hooks/use-overview";
import { useSidebarThread } from "../hooks/use-sidebar-thread";
import { toRef, useVcsActions } from "../hooks/use-vcs-actions";
import { OPEN_EVENT, takeOpenRequest } from "../lib/events";
import type { rpcContract } from "../server";
import { entryKey, headLabel, refLabel, type BranchEntry, type BranchMenuItemId, type QuickActionId } from "../shared/model";
import { BranchPopup } from "./BranchPopup";
import type { MenuExtra } from "./BranchRow";
import { ConfirmStep } from "./ConfirmStep";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface BranchButtonProps {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}

/** Panel tabs this plugin registers in app.tsx. */
export const PANEL_ACTION = { compare: "compare", diff: "diff", commit: "commit" } as const;

/**
 * The thread-header control: a 28 px branch button that opens the Git
 * branches popup. Mounted once per visible pane, so all state lives here.
 */
export function BranchButton({ threadId, isCompactViewport }: BranchButtonProps) {
  const sidebar = useSidebarThread(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [pendingAction, setPendingAction] = useState<QuickActionId | null>(null);

  // Hidden and archived threads are not in bb's sidebar list, so their label
  // can only come from the overview.
  const offSidebar = sidebar.status === "ready" && !sidebar.found;
  const enabled = everOpened || offSidebar;
  const { overview, loading, error, refetch, applyOverview } = useOverview({
    threadId,
    environmentId: sidebar.environmentId,
    enabled,
  });
  const favourites = useFavourites({ threadId, environmentId: sidebar.environmentId, enabled: everOpened });
  const jobs = useJobs(threadId);

  const close = useCallback(() => setOpen(false), []);
  const actions = useVcsActions({ threadId, overview, applyOverview, onCheckedOut: close, waitForJob: jobs.waitFor });

  const everOpenedRef = useRef(everOpened);
  everOpenedRef.current = everOpened;
  const clearStatus = actions.clearStatus;
  const refetchFavourites = favourites.refetch;
  const openPopup = useCallback(() => {
    // Reopening: forget the last action's outcome and read the repository
    // again, so a lock or an external checkout shows without an action.
    clearStatus();
    if (everOpenedRef.current) {
      void refetch();
      void refetchFavourites();
    }
    setEverOpened(true);
    setOpen(true);
  }, [clearStatus, refetch, refetchFavourites]);

  const openPanel = useCallback(
    (actionId: string, title: string, params: Record<string, unknown>) => {
      setOpen(false);
      const opened = navigate.openThreadPanel({ actionId, title, params: params as never });
      if (!opened) toast.error("The side panel is not available here.");
    },
    [navigate],
  );

  useEffect(() => {
    const handler = () => {
      const request = takeOpenRequest(threadId);
      if (request === null) return;
      // The commit dialog is a panel tab; the palette row goes straight
      // there instead of flashing the popup.
      if (request.action === "commit") {
        openPanel(PANEL_ACTION.commit, "Commit", {});
        return;
      }
      openPopup();
      if (request.action) setPendingAction(request.action);
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
  }, [openPanel, openPopup, threadId]);

  // A confirm dialog replaces the popup, as IntelliJ's push dialog does.
  useEffect(() => {
    if (actions.confirm !== null) setOpen(false);
  }, [actions.confirm]);

  const loadTags = useCallback(() => rpc.call("listTags", { threadId }), [rpc, threadId]);

  // A thread without an environment has nothing to show.
  if (sidebar.status === "ready" && sidebar.found && sidebar.environmentId === null) return null;

  const label = headLabel(overview, sidebar.found ? sidebar.branchName : loading ? "…" : "Branches");
  const title = [overview?.repoName ?? sidebar.environmentName, sidebar.hostName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" on ");
  const current: BranchRef | null = overview?.head?.kind === "branch" ? { kind: "local", name: overview.head.name } : null;

  const onCheckout = (entry: BranchEntry) => {
    void actions.checkout(toRef(entry));
  };

  const onQuickAction = (id: QuickActionId) => {
    switch (id) {
      case "update":
        actions.update();
        return;
      case "commit":
        openPanel(PANEL_ACTION.commit, "Commit", {});
        return;
      case "fetch":
        void actions.fetch();
        return;
      case "push":
        actions.push();
        return;
      case "new-branch":
      case "checkout-revision":
        return; // handled inside the popup
    }
  };

  const onMenu = (itemId: BranchMenuItemId, entry: BranchEntry, extra?: MenuExtra) => {
    const ref = toRef(entry);
    const label = refLabel(ref);
    switch (itemId) {
      case "checkout-rebase":
        if (current !== null) actions.rebase(current, ref);
        return;
      case "checkout-update":
        if (entry.kind === "local") void actions.checkoutAndUpdate(entry.branch);
        return;
      case "compare":
        if (current !== null) openPanel(PANEL_ACTION.compare, `${current.name} ⇄ ${label}`, { base: current, target: ref });
        return;
      case "diff-working-tree":
        openPanel(PANEL_ACTION.diff, `Working tree vs ${label}`, { ref });
        return;
      case "rebase":
        actions.rebase(ref, null);
        return;
      case "merge":
        actions.merge(ref);
        return;
      case "new-worktree":
        actions.addWorktree(entry);
        return;
      case "update":
        if (entry.kind === "local") actions.updateBranch(entry.branch);
        return;
      case "push":
        if (entry.kind === "local") actions.push(entry.branch);
        return;
      case "tracked-branch":
        if (entry.kind === "local" && extra?.upstream !== undefined) void actions.setUpstream(entry.branch, extra.upstream);
        return;
      case "delete":
        if (entry.kind === "local") actions.deleteBranch(entry.branch);
        else actions.deleteRemoteBranch(entry.branch);
        return;
      default:
        return;
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) openPopup();
          else setOpen(false);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={title ? `Git branch: ${label} (${title})` : `Git branch: ${label}`}
            aria-haspopup="dialog"
            data-testid="vcs-branch-button"
            className={cn(
              "h-7 max-w-64 gap-1.5 border-border/70 bg-transparent px-2 font-normal",
              isCompactViewport && "w-7 px-0",
            )}
          >
            <Icon name="GitBranch" className="size-3.5 shrink-0" />
            {isCompactViewport ? null : (
              <>
                <span className="truncate text-xs">{label}</span>
                <Icon name="ChevronDown" className="size-3 shrink-0 opacity-60" />
              </>
            )}
          </Button>
        </PopoverTrigger>
        <BranchPopup
          open={open}
          overview={overview}
          loading={loading}
          loadError={error}
          status={actions.status}
          busy={actions.busy}
          favourites={favourites.names}
          jobProgress={jobs.progress}
          pendingAction={pendingAction}
          onPendingActionConsumed={() => setPendingAction(null)}
          onCheckout={onCheckout}
          onCreateBranch={(input) => void actions.createBranch(input)}
          onRename={(branch, to) => void actions.renameBranch(branch.name, to)}
          onCheckoutRevision={actions.checkoutRevision}
          onQuickAction={onQuickAction}
          onMenu={onMenu}
          onToggleFavourite={(entry) => void favourites.toggle(entryKey(entry))}
          onCancelJob={(jobId) => void jobs.cancel(jobId)}
          onAbort={actions.abortOperation}
          loadTags={loadTags}
        />
      </Popover>
      <ConfirmStep request={actions.confirm} onCancel={actions.cancelConfirm} onConfirm={actions.acceptConfirm} />
    </>
  );
}
