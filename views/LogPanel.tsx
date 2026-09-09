// The git log as a thread panel tab: a virtualised list of commits over the
// refs the filter selects, and a drawer below it with the selected commit,
// the files it changed and bb's diff viewer for one of them. Every mutation
// in the row's context menu goes through useVcsActions, so it asks first
// with the exact command.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_Diff as Diff, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BranchRef, CommitDetails, FileChange, LogCommit, LogFilter, PatchResult } from "../contracts";
import { useJobs } from "../hooks/use-jobs";
import { useLog } from "../hooks/use-log";
import { useOverview } from "../hooks/use-overview";
import { useSidebarThread } from "../hooks/use-sidebar-thread";
import { useVcsActions } from "../hooks/use-vcs-actions";
import { errorMessage } from "../lib/errors";
import type { rpcContract } from "../server";
import { LOG_ROW_HEIGHT } from "../shared/constants";
import { refLabel, type CommitMenuItemId } from "../shared/model";
import { PANEL_ACTION, parseLogParams } from "../shared/panel-params";
import { visibleRange } from "../shared/virtual";
import { CommitRow, type CommitMenuExtra } from "./CommitRow";
import { ConfirmStep } from "./ConfirmStep";
import { NewBranchStep } from "./NewBranchStep";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface PanelProps {
  threadId: string;
  params: unknown;
}

/** How long the filter box waits before it asks the host again. */
const FILTER_DEBOUNCE_MS = 250;

function Empty({ children }: { children: string }) {
  return <p className="px-3 py-4 text-sm text-muted-foreground">{children}</p>;
}

function formatWhen(unix: number): string {
  if (unix <= 0) return "";
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The filter as one select value, and back. */
function filterValue(filter: LogFilter): string {
  switch (filter.kind) {
    case "all":
      return "all";
    case "head":
      return "head";
    case "ref":
      return `ref:${refLabel(filter.ref)}`;
  }
}

function FileList({
  files,
  truncated,
  selected,
  onSelect,
}: {
  files: FileChange[];
  truncated: boolean;
  selected: string | null;
  onSelect: (file: FileChange) => void;
}) {
  if (files.length === 0) return <p className="px-3 py-1 text-xs text-muted-foreground">This commit changes no file.</p>;
  return (
    <ul className="divide-y divide-border/60" aria-label="Files in this commit">
      {files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            aria-pressed={selected === file.path}
            className={cn("flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent", selected === file.path && "bg-accent")}
            onClick={() => onSelect(file)}
            data-path={file.path}
          >
            <Icon name="FileDiff" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {file.oldPath ? `${file.oldPath} → ` : ""}
              {file.path}
            </span>
            {file.binary ? (
              <span className="text-muted-foreground">binary</span>
            ) : (
              <span className="shrink-0 tabular-nums">
                <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{" "}
                <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
              </span>
            )}
          </button>
        </li>
      ))}
      {truncated ? <li className="px-3 py-1 text-xs text-muted-foreground">Only the first {files.length} files are listed.</li> : null}
    </ul>
  );
}

export function LogPanel({ threadId, params }: PanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const sidebar = useSidebarThread(threadId);
  const { overview, applyOverview } = useOverview({ threadId, environmentId: sidebar.environmentId, enabled: true });
  const jobs = useJobs(threadId);
  // Quiet like the commit panel: the status line under the list reports, and
  // bb stacks its toasts over the panel.
  const actions = useVcsActions({ threadId, overview, applyOverview, onCheckedOut: () => undefined, waitForJob: jobs.waitFor, quiet: true });

  const [filter, setFilter] = useState<LogFilter>(() => parseLogParams(params).filter);
  const [query, setQuery] = useState("");
  const [grep, setGrep] = useState("");
  const log = useLog({ threadId, filter, grep });

  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<CommitDetails | "loading" | null>(null);
  const [file, setFile] = useState<FileChange | null>(null);
  const [patch, setPatch] = useState<PatchResult | "loading" | null>(null);
  // The New Branch form, over the panel, with the commit as its start point.
  const [branchFrom, setBranchFrom] = useState<LogCommit | null>(null);

  // The list is virtualised: fixed-height rows between two spacers.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setGrep(query), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const commits = log.commits;
  const rowWindow = visibleRange({ scrollTop, viewportHeight, rowHeight: LOG_ROW_HEIGHT, count: commits.length });
  const rows = commits.slice(rowWindow.start, rowWindow.end);
  const commit = useMemo(() => commits.find((candidate) => candidate.sha === selected) ?? null, [commits, selected]);

  // A new filter or a refetch may drop the selected commit.
  useEffect(() => {
    if (selected !== null && !log.loading && commits.length > 0 && !commits.some((candidate) => candidate.sha === selected)) {
      setSelected(null);
      setFile(null);
    }
  }, [commits, log.loading, selected]);

  useEffect(() => {
    if (selected === null) {
      setDetails(null);
      return;
    }
    let cancelled = false;
    setDetails("loading");
    rpc.call("commitDetails", { threadId, sha: selected }).then(
      (next) => {
        if (!cancelled) setDetails(next);
      },
      (cause) => {
        if (!cancelled) setDetails({ ok: false, error: { code: "git_failed", message: errorMessage(cause) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, selected]);

  useEffect(() => {
    if (selected === null || file === null) {
      setPatch(null);
      return;
    }
    let cancelled = false;
    setPatch("loading");
    rpc.call("commitPatch", { threadId, sha: selected, path: file.path, oldPath: file.oldPath }).then(
      (next) => {
        if (!cancelled) setPatch(next);
      },
      (cause) => {
        if (!cancelled) setPatch({ ok: false, error: { code: "git_failed", message: errorMessage(cause) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, selected, file]);

  const options = useMemo(() => {
    const local = (overview?.local ?? []).map((branch) => ({ value: `ref:${branch.name}`, label: branch.name, ref: { kind: "local" as const, name: branch.name } }));
    const remote = (overview?.remote ?? []).map((branch) => ({
      value: `ref:${branch.name}`,
      label: branch.name,
      ref: { kind: "remote" as const, remote: branch.remote, branch: branch.branch },
    }));
    return { local, remote };
  }, [overview]);

  const onFilterChange = (value: string) => {
    setFile(null);
    if (value === "all" || value === "head") {
      setFilter({ kind: value });
      return;
    }
    const match = [...options.local, ...options.remote].find((option) => option.value === value);
    if (match) setFilter({ kind: "ref", ref: match.ref });
  };

  const current: BranchRef | null = overview?.head?.kind === "branch" ? { kind: "local", name: overview.head.name } : null;

  const onMenu = useCallback(
    (itemId: CommitMenuItemId, target: LogCommit, extra?: CommitMenuExtra) => {
      switch (itemId) {
        case "checkout-revision":
          actions.checkoutRevision(target.sha);
          return;
        case "new-branch-from":
          setBranchFrom(target);
          return;
        case "cherry-pick":
          actions.cherryPick(target);
          return;
        case "revert":
          actions.revert(target);
          return;
        case "reset":
          if (extra?.mode !== undefined) actions.resetTo(target, extra.mode);
          return;
        case "compare": {
          if (current === null) return;
          const opened = navigate.openThreadPanel({
            actionId: PANEL_ACTION.compare,
            title: `${current.name} ⇄ ${target.shortSha}`,
            params: { base: current, target: { kind: "revision", revision: target.sha } } as never,
          });
          if (!opened) toast.error("The side panel is not available here.");
          return;
        }
        case "copy-hash":
          void navigator.clipboard?.writeText(target.sha).then(
            () => toast.success(`Copied ${target.shortSha}.`),
            () => toast.error("Could not copy the revision number."),
          );
          return;
      }
    },
    [actions, current, navigate],
  );

  const status = actions.status;
  const filterId = `vcs-log-filter-${threadId}`;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm" data-testid="vcs-log-panel">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="Clock" className="size-4 shrink-0 text-muted-foreground" />
        <label className="sr-only" htmlFor={filterId}>
          Branch filter
        </label>
        <select
          id={filterId}
          className="h-6 min-w-20 max-w-36 rounded border border-border bg-transparent px-1 text-xs"
          value={filterValue(filter)}
          onChange={(event) => onFilterChange(event.target.value)}
          data-testid="vcs-log-filter"
        >
          <option value="all">All branches</option>
          <option value="head">Current branch</option>
          {options.local.length > 0 ? (
            <optgroup label="Local">
              {options.local.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {options.remote.length > 0 ? (
            <optgroup label="Remote">
              {options.remote.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <Input
          aria-label="Filter commit messages"
          placeholder="Filter messages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-6 min-w-24 flex-1 text-xs"
          data-testid="vcs-log-search"
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="vcs-log-count">
          {commits.length}
          {log.hasMore ? "+" : ""}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          aria-label="Refresh"
          onClick={log.refetch}
          disabled={log.loading}
        >
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", log.loading && "animate-spin")} />
        </Button>
      </header>

      <div
        ref={listRef}
        className="min-h-0 shrink-0 basis-2/5 overflow-auto border-b border-border"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        aria-label="Commits"
        data-testid="vcs-log-list"
      >
        {log.error !== null ? (
          <p className="p-4 text-sm text-destructive">{log.error}</p>
        ) : log.failure !== null ? (
          <div className="p-4 text-sm text-destructive">
            <p>{log.failure.message}</p>
            {log.failure.hint ? <p className="text-muted-foreground">{log.failure.hint}</p> : null}
          </div>
        ) : commits.length === 0 ? (
          <Empty>{log.loading ? "Reading the log…" : grep.trim() === "" ? "No commit yet." : "No commit matches this filter."}</Empty>
        ) : (
          <>
            <div style={{ height: rowWindow.topPadding }} />
            {rows.map((entry) => (
              <CommitRow
                key={entry.sha}
                commit={entry}
                overview={overview}
                selected={entry.sha === selected}
                onSelect={(next) => {
                  setSelected(next.sha);
                  setFile(null);
                }}
                onMenu={onMenu}
              />
            ))}
            <div style={{ height: rowWindow.bottomPadding }} />
            {log.hasMore ? (
              <div className="p-2">
                <Button type="button" variant="outline" size="sm" className="h-6 w-full text-xs" onClick={log.loadMore} disabled={log.loadingMore} data-testid="vcs-log-more">
                  {log.loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {file !== null ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
              <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1 text-xs" onClick={() => setFile(null)} data-testid="vcs-log-back">
                <Icon name="ChevronLeft" className="size-3.5" />
                Back
              </Button>
              <span className="min-w-0 flex-1 truncate font-medium">{file.path}</span>
              {commit !== null ? <span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span> : null}
            </div>
            <PatchView patch={patch} />
          </>
        ) : commit === null ? (
          <Empty>Select a commit to see what it changed.</Empty>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto" data-testid="vcs-log-details">
            <Details details={details} selectedPath={file} onSelectFile={setFile} />
          </div>
        )}
      </div>

      <div role="status" aria-live="polite" className="shrink-0 border-t border-border px-3 py-1 text-xs">
        {status.kind === "busy" ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Icon name="Loading" className="size-3 animate-spin" />
            {status.text}
          </p>
        ) : status.kind === "ok" ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Icon name="Check" className="size-3" />
            {status.text}
          </p>
        ) : status.kind === "error" ? (
          <div className="text-destructive">
            <p>{status.error.message}</p>
            {status.error.hint ? <p className="text-muted-foreground">{status.error.hint}</p> : null}
          </div>
        ) : (
          <p className="text-muted-foreground">Right-click a commit for checkout, branch, cherry-pick, revert and reset.</p>
        )}
      </div>
      <Dialog open={branchFrom !== null} onOpenChange={(open) => (open ? undefined : setBranchFrom(null))}>
        <DialogContent className="max-w-sm p-0">
          <DialogTitle className="sr-only">New branch</DialogTitle>
          {branchFrom === null ? null : (
            <NewBranchStep
              from={branchFrom.shortSha}
              busy={actions.busy}
              onCancel={() => setBranchFrom(null)}
              onCreate={({ name, checkout }) => {
                const startPoint = branchFrom.sha;
                setBranchFrom(null);
                void actions.createBranch({ name, startPoint, checkout });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmStep request={actions.confirm} onCancel={actions.cancelConfirm} onConfirm={actions.acceptConfirm} />
    </div>
  );
}

function Details({
  details,
  selectedPath,
  onSelectFile,
}: {
  details: CommitDetails | "loading" | null;
  selectedPath: FileChange | null;
  onSelectFile: (file: FileChange) => void;
}) {
  if (details === null || details === "loading") return <Empty>Reading the commit…</Empty>;
  if (!details.ok) {
    return (
      <div className="p-4 text-sm text-destructive">
        <p>{details.error.message}</p>
        {details.error.hint ? <p className="text-muted-foreground">{details.error.hint}</p> : null}
      </div>
    );
  }
  const shown = details.commit;
  return (
    <>
      <div className="space-y-1 border-b border-border px-3 py-2 text-xs">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-muted-foreground" data-testid="vcs-log-sha">
            {shown.sha}
          </span>
          {shown.parents.length > 1 ? <span className="text-muted-foreground">merge of {shown.parents.length} parents</span> : null}
        </div>
        <p className="text-muted-foreground">
          {shown.author} &lt;{shown.authorEmail}&gt; · {formatWhen(shown.authoredAt)}
        </p>
        {shown.committer !== shown.author || shown.committedAt !== shown.authoredAt ? (
          <p className="text-muted-foreground">
            committed by {shown.committer} · {formatWhen(shown.committedAt)}
          </p>
        ) : null}
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">{shown.message}</pre>
      </div>
      <h3 className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {details.againstParent === null ? "Files added by the first commit" : "Files changed"}{" "}
        <span className="tabular-nums">({details.files.length})</span>
      </h3>
      <FileList files={details.files} truncated={details.truncated} selected={selectedPath?.path ?? null} onSelect={onSelectFile} />
    </>
  );
}

function PatchView({ patch }: { patch: PatchResult | "loading" | null }) {
  if (patch === null) return <Empty>Select a file to see its diff.</Empty>;
  if (patch === "loading") return <Empty>Reading diff…</Empty>;
  if (!patch.ok) return <p className="p-4 text-sm text-destructive">{patch.error.message}</p>;
  if (patch.binary) return <Empty>Binary file.</Empty>;
  if (patch.patch.trim() === "") return <Empty>This commit does not change that file.</Empty>;
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="vcs-patch">
      {patch.truncated ? <p className="px-3 py-1 text-xs text-muted-foreground">Diff truncated at 1 MiB.</p> : null}
      <Diff
        patch={patch.patch}
        path={patch.path}
        view="unified"
        overflow="scroll"
        {...(patch.contents === null ? {} : { experimental_fullFileContents: patch.contents })}
      />
    </div>
  );
}
