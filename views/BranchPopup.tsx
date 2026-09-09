import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Overview } from "../contracts";
import type { ActionStatus } from "../hooks/use-vcs-actions";
import {
  filterAndRank,
  groupBranches,
  quickActionsFor,
  type BranchMenuItemId,
  type QuickActionId,
} from "../shared/model";
import { BranchRow, type BranchEntry } from "./BranchRow";
import { NewBranchStep } from "./NewBranchStep";
import { QuickActions } from "./QuickActions";
import { StatusLine } from "./StatusLine";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import { PopoverContent } from "@/components/ui/popover";

type Step = { kind: "list" } | { kind: "new-branch"; from: string | null };

interface BranchPopupProps {
  open: boolean;
  overview: Overview | null;
  loading: boolean;
  loadError: string | null;
  status: ActionStatus;
  busy: boolean;
  /** A quick action requested from the command palette, run once ready. */
  pendingAction: QuickActionId | null;
  onPendingActionConsumed: () => void;
  onCheckout: (entry: BranchEntry) => void;
  onCreateBranch: (input: { name: string; startPoint: string | null; checkout: boolean }) => void;
  onQuickAction: (id: QuickActionId) => void;
}

export function BranchPopup({
  open,
  overview,
  loading,
  loadError,
  status,
  busy,
  pendingAction,
  onPendingActionConsumed,
  onCheckout,
  onCreateBranch,
  onQuickAction,
}: BranchPopupProps) {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>({ kind: "list" });
  const inputRef = useRef<HTMLInputElement>(null);

  // The popup stays mounted while closed; a reopen starts from a clean list.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setStep({ kind: "list" });
    }
  }, [open]);

  const groups = useMemo(() => (overview ? groupBranches(overview) : null), [overview]);
  const recent = useMemo(() => (groups ? filterAndRank(groups.recent, query) : []), [groups, query]);
  const local = useMemo(() => (groups ? filterAndRank(groups.local, query) : []), [groups, query]);
  const remote = useMemo(() => (groups ? filterAndRank(groups.remote, query) : []), [groups, query]);
  const unavailable = overview?.unavailableReason ?? null;

  const runQuickAction = (id: QuickActionId) => {
    if (id === "new-branch") {
      setStep({ kind: "new-branch", from: null });
      return;
    }
    onQuickAction(id);
  };

  // A palette request obeys the same guards as a click on the row.
  useEffect(() => {
    if (pendingAction === null || overview === null) return;
    onPendingActionConsumed();
    const action = quickActionsFor(overview).find((candidate) => candidate.id === pendingAction);
    if (action === undefined || action.disabled || busy) {
      toast.error(action?.reason ?? "Another VCS action is still running.");
      return;
    }
    runQuickAction(pendingAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per request
  }, [pendingAction, overview]);

  const onMenu = (itemId: BranchMenuItemId, entry: BranchEntry) => {
    switch (itemId) {
      case "checkout":
        onCheckout(entry);
        return;
      case "new-branch-from":
        setStep({ kind: "new-branch", from: entry.branch.name });
        return;
      case "copy-name":
        void navigator.clipboard?.writeText(entry.branch.name).then(
          () => toast.success(`Copied ${entry.branch.name}`),
          () => toast.error("Could not copy the branch name."),
        );
        return;
    }
  };

  const rowDisabled = busy || unavailable !== null;

  return (
    <PopoverContent
      align="start"
      sideOffset={6}
      className="w-[26rem] max-w-[calc(100vw-1rem)] p-0"
      mobileTitle="Git branches"
      autoFocusRef={inputRef}
      data-testid="vcs-branch-popup"
      onEscapeKeyDown={(event) => {
        // Radix dismisses on Escape at the document level before any input
        // handler runs; in the New Branch step Escape goes back to the list.
        if (step.kind === "new-branch") {
          event.preventDefault();
          setStep({ kind: "list" });
        }
      }}
    >
      {step.kind === "new-branch" ? (
        <NewBranchStep
          from={step.from}
          busy={busy}
          onCancel={() => setStep({ kind: "list" })}
          onCreate={({ name, checkout }) => {
            onCreateBranch({ name, startPoint: step.from, checkout });
            setStep({ kind: "list" });
          }}
        />
      ) : (
        <Command shouldFilter={false} loop className="rounded-md">
          <CommandInput
            ref={inputRef}
            placeholder="Search for branches and actions"
            aria-label="Search for branches and actions"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[min(60vh,28rem)]">
            {unavailable !== null ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{unavailable}</p>
            ) : (
              <>
                <CommandEmpty>
                  {overview === null ? "Reading repository…" : `Nothing matches “${query}”.`}
                </CommandEmpty>
                <QuickActions overview={overview} query={query} busy={busy} onAction={runQuickAction} />
                {overview && groups ? (
                  <>
                    {recent.length > 0 ? (
                      <CommandGroup heading="Recent">
                        {recent.map((branch) => (
                          <BranchRow
                            key={`recent:${branch.name}`}
                            value={`recent:${branch.name}`}
                            entry={{ kind: "local", branch }}
                            overview={overview}
                            disabled={rowDisabled}
                            onSelect={onCheckout}
                            onMenu={onMenu}
                          />
                        ))}
                      </CommandGroup>
                    ) : null}
                    {local.length > 0 ? (
                      <CommandGroup heading={overview.truncated.local ? "Local (truncated)" : "Local"}>
                        {local.map((branch) => (
                          <BranchRow
                            key={`local:${branch.name}`}
                            value={`local:${branch.name}`}
                            entry={{ kind: "local", branch }}
                            overview={overview}
                            disabled={rowDisabled}
                            onSelect={onCheckout}
                            onMenu={onMenu}
                          />
                        ))}
                      </CommandGroup>
                    ) : null}
                    {remote.length > 0 ? (
                      <CommandGroup heading={overview.truncated.remote ? "Remote (truncated)" : "Remote"}>
                        {remote.map((branch) => (
                          <BranchRow
                            key={`remote:${branch.name}`}
                            value={`remote:${branch.name}`}
                            entry={{ kind: "remote", branch }}
                            overview={overview}
                            disabled={rowDisabled}
                            onSelect={onCheckout}
                            onMenu={onMenu}
                          />
                        ))}
                      </CommandGroup>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </CommandList>
          <StatusLine status={status} overview={overview} loading={loading} loadError={loadError} />
        </Command>
      )}
    </PopoverContent>
  );
}
