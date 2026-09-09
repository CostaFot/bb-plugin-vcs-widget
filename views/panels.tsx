// Thread panel tabs: "Compare with" (commits on either side, changed files)
// and "Show Diff with Working Tree". Both are read-only and render bb's own
// diff viewer for the selected file.
import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Diff as Diff, useRpc } from "@get-bb/plugin-sdk/app";
import type { Commit, CompareResult, FileChange, PatchResult, WorkingTreeDiff } from "../contracts";
import { useRepositoryChanges } from "../hooks/use-repository-changes";
import { errorMessage } from "../lib/errors";
import type { rpcContract } from "../server";
import { refLabel } from "../shared/model";
import { parseCompareParams, parseDiffParams } from "../shared/panel-params";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface PanelProps {
  threadId: string;
  params: unknown;
}

function Empty({ children }: { children: string }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>;
}

function formatWhen(unix: number): string {
  if (unix <= 0) return "";
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CommitList({ title, commits, count, truncated }: { title: string; commits: Commit[]; count: number; truncated: boolean }) {
  return (
    <section className="min-w-0">
      <h3 className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {title} <span className="tabular-nums">({count})</span>
      </h3>
      {commits.length === 0 ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">None.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {commits.map((commit) => (
            <li key={commit.sha} className="flex items-baseline gap-2 px-3 py-1 text-xs" title={commit.sha}>
              <span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span>
              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
              <span className="shrink-0 truncate text-muted-foreground">{commit.author}</span>
              <span className="shrink-0 text-muted-foreground">{formatWhen(commit.committedAt)}</span>
            </li>
          ))}
          {truncated ? <li className="px-3 py-1 text-xs text-muted-foreground">Only the first {commits.length} shown.</li> : null}
        </ul>
      )}
    </section>
  );
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
  onSelect: (path: string) => void;
}) {
  if (files.length === 0) return <Empty>No file differs.</Empty>;
  return (
    <ul className="divide-y divide-border/60" role="listbox" aria-label="Changed files">
      {files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            role="option"
            aria-selected={selected === file.path}
            className={cn("flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent", selected === file.path && "bg-accent")}
            onClick={() => onSelect(file.path)}
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
      {truncated ? <li className="px-3 py-1 text-xs text-muted-foreground">Only the first {files.length} files shown.</li> : null}
    </ul>
  );
}

function PatchView({ patch }: { patch: PatchResult | null | "loading" }) {
  if (patch === null) return <Empty>Select a file to see its diff.</Empty>;
  if (patch === "loading") return <Empty>Reading diff…</Empty>;
  if (!patch.ok) return <p className="p-4 text-sm text-destructive">{patch.error.message}</p>;
  if (patch.binary) return <Empty>Binary file.</Empty>;
  if (patch.patch.trim() === "") return <Empty>No textual difference.</Empty>;
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="vcs-patch">
      {patch.truncated ? <p className="px-3 py-1 text-xs text-muted-foreground">Diff truncated at 1 MiB.</p> : null}
      <Diff patch={patch.patch} path={patch.path} view="unified" overflow="scroll" />
    </div>
  );
}

/** Shared frame: a scrollable top with lists, a diff below. */
function Frame({ header, top, patch }: { header: React.ReactNode; top: React.ReactNode; patch: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">{header}</header>
      <div className="min-h-0 shrink-0 basis-2/5 overflow-auto border-b border-border">{top}</div>
      <div className="flex min-h-0 flex-1 flex-col">{patch}</div>
    </div>
  );
}

export function ComparePanel({ threadId, params }: PanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const parsed = parseCompareParams(params);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<PatchResult | null | "loading">(null);
  const generation = useRef(0);

  const refetch = useCallback(() => {
    if (parsed === null) return;
    const mine = ++generation.current;
    rpc.call("compare", { threadId, base: parsed.base, target: parsed.target }).then(
      (next) => {
        if (mine !== generation.current) return;
        setResult(next);
        setError(null);
      },
      (cause) => {
        if (mine === generation.current) setError(errorMessage(cause));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are plain data
  }, [rpc, threadId, JSON.stringify(parsed)]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRepositoryChanges(threadId, refetch);

  useEffect(() => {
    if (parsed === null || selected === null) {
      setPatch(null);
      return;
    }
    let cancelled = false;
    setPatch("loading");
    rpc.call("comparePatch", { threadId, base: parsed.base, target: parsed.target, path: selected }).then(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are plain data
  }, [rpc, threadId, selected, result, JSON.stringify(parsed)]);

  if (parsed === null) {
    return <Empty>Open this tab from a branch's context menu: Compare with the current branch.</Empty>;
  }
  const base = refLabel(parsed.base);
  const target = refLabel(parsed.target);
  return (
    <Frame
      header={
        <>
          <Icon name="GitMerge" className="size-4 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">
            {base} <span className="text-muted-foreground">⇄</span> {target}
          </span>
          {result?.ok ? (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="vcs-compare-counts">
              {target} +{result.aheadCount} · {base} +{result.behindCount}
            </span>
          ) : null}
        </>
      }
      top={
        error !== null ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : result === null ? (
          <Empty>Comparing…</Empty>
        ) : !result.ok ? (
          <p className="p-4 text-sm text-destructive">{result.error.message}</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <CommitList title={`Only on ${target}`} commits={result.ahead} count={result.aheadCount} truncated={result.truncated.ahead} />
              <CommitList title={`Only on ${base}`} commits={result.behind} count={result.behindCount} truncated={result.truncated.behind} />
            </div>
            <h3 className="border-t border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Files changed by {target} since the merge base ({result.files.length})
            </h3>
            <FileList files={result.files} truncated={result.truncated.files} selected={selected} onSelect={setSelected} />
          </>
        )
      }
      patch={<PatchView patch={patch} />}
    />
  );
}

export function DiffPanel({ threadId, params }: PanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const parsed = parseDiffParams(params);
  const [result, setResult] = useState<WorkingTreeDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<PatchResult | null | "loading">(null);
  const generation = useRef(0);

  const refetch = useCallback(() => {
    if (parsed === null) return;
    const mine = ++generation.current;
    rpc.call("diffWorkingTree", { threadId, ref: parsed.ref }).then(
      (next) => {
        if (mine !== generation.current) return;
        setResult(next);
        setError(null);
      },
      (cause) => {
        if (mine === generation.current) setError(errorMessage(cause));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are plain data
  }, [rpc, threadId, JSON.stringify(parsed)]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRepositoryChanges(threadId, refetch);

  useEffect(() => {
    if (parsed === null || selected === null) {
      setPatch(null);
      return;
    }
    let cancelled = false;
    setPatch("loading");
    rpc.call("diffWorkingTreePatch", { threadId, ref: parsed.ref, path: selected }).then(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are plain data
  }, [rpc, threadId, selected, result, JSON.stringify(parsed)]);

  if (parsed === null) {
    return <Empty>Open this tab from a branch's context menu: Show Diff with Working Tree.</Empty>;
  }
  const ref = refLabel(parsed.ref);
  return (
    <Frame
      header={
        <>
          <Icon name="FileDiff" className="size-4 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">
            Working tree <span className="text-muted-foreground">vs</span> {ref}
          </span>
          {result?.ok ? <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{result.files.length} file(s)</span> : null}
        </>
      }
      top={
        error !== null ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : result === null ? (
          <Empty>Comparing…</Empty>
        ) : !result.ok ? (
          <p className="p-4 text-sm text-destructive">{result.error.message}</p>
        ) : (
          <FileList files={result.files} truncated={result.truncated} selected={selected} onSelect={setSelected} />
        )
      }
      patch={<PatchView patch={patch} />}
    />
  );
}
