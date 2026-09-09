import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import type { LocalBranch, Overview, TagList } from "../contracts";
import type { JobProgress } from "../hooks/use-jobs";
import type { ActionStatus } from "../hooks/use-vcs-actions";
import {
  FAVOURITE_BONUS,
  blockingReason,
  entryKey,
  filterAndRank,
  groupBranches,
  quickActionsFor,
  type BranchEntry,
  type BranchMenuItemId,
  type QuickActionId,
} from "../shared/model";
import { BranchRow, type MenuExtra } from "./BranchRow";
import { NewBranchStep } from "./NewBranchStep";
import { QuickActions } from "./QuickActions";
import { RenameStep } from "./RenameStep";
import { RevisionStep } from "./RevisionStep";
import { StatusLine } from "./StatusLine";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import { PopoverContent } from "@/components/ui/popover";

type Step =
  | { kind: "list" }
  | { kind: "new-branch"; from: string | null }
  | { kind: "rename"; branch: LocalBranch }
  | { kind: "revision" };

interface BranchPopupProps {
  open: boolean;
  overview: Overview | null;
  loading: boolean;
  loadError: string | null;
  status: ActionStatus;
  busy: boolean;
  favourites: ReadonlySet<string>;
  jobProgress: JobProgress | null;
  /** A quick action requested from the command palette, run once ready. */
  pendingAction: QuickActionId | null;
  onPendingActionConsumed: () => void;
  onCheckout: (entry: BranchEntry) => void;
  onCreateBranch: (input: { name: string; startPoint: string | null; checkout: boolean }) => void;
  onRename: (branch: LocalBranch, to: string) => void;
  onCheckoutRevision: (revision: string) => void;
  onQuickAction: (id: QuickActionId) => void;
  /** Menu rows the popup does not handle itself. */
  onMenu: (itemId: BranchMenuItemId, entry: BranchEntry, extra?: MenuExtra) => void;
  onToggleFavourite: (entry: BranchEntry) => void;
  onCancelJob: (jobId: string) => void;
  onAbort: () => void;
  loadTags: () => Promise<TagList>;
}

export function BranchPopup({
  open,
  overview,
  loading,
  loadError,
  status,
  busy,
  favourites,
  jobProgress,
  pendingAction,
  onPendingActionConsumed,
  onCheckout,
  onCreateBranch,
  onRename,
  onCheckoutRevision,
  onQuickAction,
  onMenu,
  onToggleFavourite,
  onCancelJob,
  onAbort,
  loadTags,
}: BranchPopupProps) {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>({ kind: "list" });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The popup stays mounted while closed; a reopen starts from a clean list.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setStep({ kind: "list" });
    }
  }, [open]);

  const groups = useMemo(() => (overview ? groupBranches(overview, favourites) : null), [overview, favourites]);
  const bonus = useCallback(
    (kind: "local" | "remote") => (item: { name: string }) => (favourites.has(`${kind}:${item.name}`) ? FAVOURITE_BONUS : 0),
    [favourites],
  );
  const favouriteRows = useMemo(() => {
    if (!groups) return [];
    const named = groups.favourites.map((entry) => ({ name: entry.branch.name, entry }));
    return filterAndRank(named, query).map((row) => row.entry);
  }, [groups, query]);
  const recent = useMemo(() => (groups ? filterAndRank(groups.recent, query, bonus("local")) : []), [groups, query, bonus]);
  const local = useMemo(() => (groups ? filterAndRank(groups.local, query, bonus("local")) : []), [groups, query, bonus]);
  const remote = useMemo(() => (groups ? filterAndRank(groups.remote, query, bonus("remote")) : []), [groups, query, bonus]);
  const unavailable = overview?.unavailableReason ?? null;

  const runQuickAction = (id: QuickActionId) => {
    if (id === "new-branch") {
      setStep({ kind: "new-branch", from: null });
      return;
    }
    if (id === "checkout-revision") {
      setStep({ kind: "revision" });
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

  const handleMenu = (itemId: BranchMenuItemId, entry: BranchEntry, extra?: MenuExtra) => {
    switch (itemId) {
      case "checkout":
        onCheckout(entry);
        return;
      case "new-branch-from":
        setStep({ kind: "new-branch", from: entry.branch.name });
        return;
      case "rename":
        if (entry.kind === "local") setStep({ kind: "rename", branch: entry.branch });
        return;
      case "favourite":
        onToggleFavourite(entry);
        return;
      case "copy-name":
        void navigator.clipboard?.writeText(entry.branch.name).then(
          () => toast.success(`Copied ${entry.branch.name}`),
          () => toast.error("Could not copy the branch name."),
        );
        return;
      default:
        onMenu(itemId, entry, extra);
    }
  };

  // F2 renames the highlighted local branch, as in IntelliJ.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "F2" || overview === null) return;
    const selected = listRef.current?.querySelector('[cmdk-item][data-selected="true"][data-branch-kind="local"]');
    const name = selected?.getAttribute("data-branch-name");
    const branch = name ? overview.local.find((candidate) => candidate.name === name) : undefined;
    if (branch === undefined) return;
    event.preventDefault();
    setStep({ kind: "rename", branch });
  };

  const rowDisabled = busy || unavailable !== null;
  const back = () => setStep({ kind: "list" });
  // A disabled cmdk row loses its context menu (pointer-events), so a row
  // stays clickable while an operation or job blocks the repository and
  // Enter/click explain instead of running.
  const selectRow = (entry: BranchEntry) => {
    const reason = overview === null ? null : blockingReason(overview);
    if (reason !== null) {
      toast.error(reason);
      return;
    }
    onCheckout(entry);
  };

  const row = (entry: BranchEntry, prefix: string) => (
    <BranchRow
      key={`${prefix}:${entryKey(entry)}`}
      value={`${prefix}:${entryKey(entry)}`}
      entry={entry}
      overview={overview!}
      disabled={rowDisabled}
      favourite={favourites.has(entryKey(entry))}
      onSelect={selectRow}
      onMenu={handleMenu}
    />
  );

  return (
    <PopoverContent
      align="start"
      sideOffset={6}
      className="w-[28rem] max-w-[calc(100vw-1rem)] p-0"
      mobileTitle="Git branches"
      autoFocusRef={inputRef}
      data-testid="vcs-branch-popup"
      onEscapeKeyDown={(event) => {
        // Radix dismisses on Escape at the document level before any input
        // handler runs; in a form step Escape goes back to the list.
        if (step.kind !== "list") {
          event.preventDefault();
          back();
        }
      }}
    >
      {step.kind === "new-branch" ? (
        <NewBranchStep
          from={step.from}
          busy={busy}
          onCancel={back}
          onCreate={({ name, checkout }) => {
            onCreateBranch({ name, startPoint: step.from, checkout });
            back();
          }}
        />
      ) : step.kind === "rename" ? (
        <RenameStep
          from={step.branch.name}
          busy={busy}
          onCancel={back}
          onRename={(to) => {
            onRename(step.branch, to);
            back();
          }}
        />
      ) : step.kind === "revision" ? (
        <RevisionStep
          busy={busy}
          loadTags={loadTags}
          onCancel={back}
          onCheckout={(revision) => {
            onCheckoutRevision(revision);
            back();
          }}
        />
      ) : (
        <Command shouldFilter={false} loop className="rounded-md" onKeyDown={onListKeyDown}>
          <CommandInput
            ref={inputRef}
            placeholder="Search for branches and actions"
            aria-label="Search for branches and actions"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList ref={listRef} className="max-h-[min(60vh,28rem)]">
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
                    {favouriteRows.length > 0 ? (
                      <CommandGroup heading="Favourites">{favouriteRows.map((entry) => row(entry, "fav"))}</CommandGroup>
                    ) : null}
                    {recent.length > 0 ? (
                      <CommandGroup heading="Recent">
                        {recent.map((branch) => row({ kind: "local", branch }, "recent"))}
                      </CommandGroup>
                    ) : null}
                    {local.length > 0 ? (
                      <CommandGroup heading={overview.truncated.local ? "Local (truncated)" : "Local"}>
                        {local.map((branch) => row({ kind: "local", branch }, "local"))}
                      </CommandGroup>
                    ) : null}
                    {remote.length > 0 ? (
                      <CommandGroup heading={overview.truncated.remote ? "Remote (truncated)" : "Remote"}>
                        {remote.map((branch) => row({ kind: "remote", branch }, "remote"))}
                      </CommandGroup>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </CommandList>
          <StatusLine
            status={status}
            overview={overview}
            loading={loading}
            loadError={loadError}
            jobProgress={jobProgress}
            onCancelJob={onCancelJob}
            onAbort={onAbort}
          />
        </Command>
      )}
    </PopoverContent>
  );
}
