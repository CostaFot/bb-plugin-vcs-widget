import { useCallback, useEffect, useState } from "react";
import { useOverview } from "../hooks/use-overview";
import { useSidebarThread } from "../hooks/use-sidebar-thread";
import { useVcsActions } from "../hooks/use-vcs-actions";
import { OPEN_EVENT, isOpenEventDetail } from "../lib/events";
import { headLabel, type QuickActionId } from "../shared/model";
import { BranchPopup } from "./BranchPopup";
import type { BranchEntry } from "./BranchRow";
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

/**
 * The thread-header control: a 28 px branch button that opens the Git
 * branches popup. Mounted once per visible pane, so all state lives here.
 */
export function BranchButton({ threadId, isCompactViewport }: BranchButtonProps) {
  const sidebar = useSidebarThread(threadId);
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [pendingAction, setPendingAction] = useState<QuickActionId | null>(null);

  const { overview, loading, error, applyOverview } = useOverview({
    threadId,
    environmentId: sidebar.environmentId,
    enabled: everOpened,
  });

  const close = useCallback(() => setOpen(false), []);
  const actions = useVcsActions({ threadId, overview, applyOverview, onCheckedOut: close });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isOpenEventDetail(detail) || detail.threadId !== threadId) return;
      setEverOpened(true);
      setOpen(true);
      if (detail.action) setPendingAction(detail.action);
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
  }, [threadId]);

  // A confirm dialog replaces the popup, as IntelliJ's push dialog does.
  useEffect(() => {
    if (actions.confirm !== null) setOpen(false);
  }, [actions.confirm]);

  // A thread without an environment has nothing to show.
  if (sidebar.status === "ready" && sidebar.found && sidebar.environmentId === null) return null;

  const label = headLabel(overview, sidebar.branchName);
  const title = [overview?.repoName ?? sidebar.environmentName, sidebar.hostName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" on ");

  const onCheckout = (entry: BranchEntry) => {
    void actions.checkout(
      entry.kind === "local"
        ? { kind: "local", name: entry.branch.name }
        : { kind: "remote", remote: entry.branch.remote, branch: entry.branch.branch },
    );
  };

  const onQuickAction = (id: QuickActionId) => {
    switch (id) {
      case "update":
        actions.update();
        return;
      case "fetch":
        void actions.fetch();
        return;
      case "push":
        actions.push();
        return;
      case "new-branch":
        return; // handled inside the popup
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setEverOpened(true);
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
          overview={overview}
          loading={loading}
          loadError={error}
          status={actions.status}
          busy={actions.busy}
          pendingAction={pendingAction}
          onPendingActionConsumed={() => setPendingAction(null)}
          onCheckout={onCheckout}
          onCreateBranch={(input) => void actions.createBranch(input)}
          onQuickAction={onQuickAction}
        />
      </Popover>
      <ConfirmStep request={actions.confirm} onCancel={actions.cancelConfirm} onConfirm={actions.acceptConfirm} />
    </>
  );
}
