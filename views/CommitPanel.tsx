// The commit dialog as a thread panel tab: the working tree and the index
// as a checklist (the checkbox is the staged state), bb's diff viewer for
// the selected file, the message, and Commit / Commit and Push. Every
// mutation goes through useVcsActions, so discards and amends ask first with
// the exact command and the commit runs as a job on the host.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { experimental_Diff as Diff, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChangeEntry, FileDiff } from "../contracts";
import { useChanges } from "../hooks/use-changes";
import { useJobs } from "../hooks/use-jobs";
import { useOverview } from "../hooks/use-overview";
import { useSidebarThread } from "../hooks/use-sidebar-thread";
import { useVcsActions } from "../hooks/use-vcs-actions";
import { errorMessage } from "../lib/errors";
import type { rpcContract } from "../server";
import type { DiffSide } from "../shared/constants";
import { commitBlockedReason, diffSidesFor, headLabel, isStaged, stageState, statusLetter } from "../shared/model";
import { ConfirmStep } from "./ConfirmStep";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface PanelProps {
  threadId: string;
  params: unknown;
}

/** IntelliJ's colours for the status letter. */
const LETTER_CLASS: Record<string, string> = {
  M: "text-blue-600 dark:text-blue-400",
  T: "text-blue-600 dark:text-blue-400",
  R: "text-blue-600 dark:text-blue-400",
  A: "text-green-600 dark:text-green-400",
  C: "text-green-600 dark:text-green-400",
  D: "text-muted-foreground line-through",
  "?": "text-amber-700 dark:text-amber-400",
  U: "text-red-600 dark:text-red-400",
};

/** The paths one row stands for: a staged rename is two index entries. */
function pathsOf(entry: ChangeEntry): string[] {
  return entry.index === "R" && entry.oldPath !== null ? [entry.path, entry.oldPath] : [entry.path];
}

function Empty({ children }: { children: string }) {
  return <p className="px-3 py-4 text-sm text-muted-foreground">{children}</p>;
}

interface RowProps {
  entry: ChangeEntry;
  selected: boolean;
  disabled: boolean;
  onToggle: (entry: ChangeEntry) => void;
  onSelect: (entry: ChangeEntry) => void;
  onDiscard: (entry: ChangeEntry) => void;
}

function Row({ entry, selected, disabled, onToggle, onSelect, onDiscard }: RowProps) {
  const state = stageState(entry);
  const letter = statusLetter(entry);
  const conflicted = entry.kind === "conflicted";
  return (
    <li
      className={cn("group flex items-center gap-2 px-2 py-0.5 text-xs hover:bg-accent", selected && "bg-accent")}
      data-path={entry.path}
      data-stage={state}
    >
      <Checkbox
        checked={conflicted ? false : state === "staged" ? true : state === "partial" ? "indeterminate" : false}
        aria-label={conflicted ? `Mark ${entry.path} resolved` : state === "unstaged" ? `Stage ${entry.path}` : `Unstage ${entry.path}`}
        disabled={disabled}
        onCheckedChange={() => onToggle(entry)}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
        aria-pressed={selected}
        onClick={() => onSelect(entry)}
        title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
      >
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", LETTER_CLASS[letter] ?? "")} aria-label={`status ${letter}`}>
          {letter}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", state === "partial" && "italic")}>
          {entry.oldPath ? <span className="text-muted-foreground">{entry.oldPath} → </span> : null}
          {entry.path}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Discard changes in ${entry.path}`}
        title={conflicted ? "Resolve the conflict first." : entry.kind === "untracked" ? "Delete the file" : "Revert to HEAD"}
        disabled={disabled || conflicted}
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-0 group-hover:opacity-100"
        onClick={() => onDiscard(entry)}
      >
        <Icon name="RotateCcw" className="size-3.5" />
      </button>
    </li>
  );
}

interface GroupProps {
  title: string;
  entries: ChangeEntry[];
  selected: string | null;
  disabled: boolean;
  /** The header checkbox: stage all, or unstage all when everything is staged. */
  onToggleAll: (entries: ChangeEntry[], stageThem: boolean) => void;
  onToggle: (entry: ChangeEntry) => void;
  onSelect: (entry: ChangeEntry) => void;
  onDiscard: (entry: ChangeEntry) => void;
}

function Group({ title, entries, selected, disabled, onToggleAll, onToggle, onSelect, onDiscard }: GroupProps) {
  if (entries.length === 0) return null;
  const allStaged = entries.every((entry) => stageState(entry) === "staged");
  const noneStaged = entries.every((entry) => stageState(entry) === "unstaged");
  return (
    <section aria-label={title}>
      <header className="flex items-center gap-2 px-2 py-1 text-[11px] font-medium text-muted-foreground">
        <Checkbox
          checked={allStaged ? true : noneStaged ? false : "indeterminate"}
          aria-label={allStaged ? `Unstage all in ${title}` : `Stage all in ${title}`}
          disabled={disabled}
          onCheckedChange={() => onToggleAll(entries, !allStaged)}
        />
        <span>{title}</span>
        <span className="tabular-nums">({entries.length})</span>
      </header>
      <ul>
        {entries.map((entry) => (
          <Row
            key={entry.path}
            entry={entry}
            selected={selected === entry.path}
            disabled={disabled}
            onToggle={onToggle}
            onSelect={onSelect}
            onDiscard={onDiscard}
          />
        ))}
      </ul>
    </section>
  );
}

function DiffView({ diff }: { diff: FileDiff | "loading" | null }) {
  if (diff === null) return <Empty>Select a file to see its diff.</Empty>;
  if (diff === "loading") return <Empty>Reading diff…</Empty>;
  if (!diff.ok) return <p className="p-4 text-sm text-destructive">{diff.error.message}</p>;
  if (diff.binary) return <Empty>Binary file.</Empty>;
  if (diff.patch.trim() === "") return <Empty>No textual difference on this side.</Empty>;
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="vcs-patch">
      {diff.truncated ? <p className="px-3 py-1 text-xs text-muted-foreground">Diff truncated at 1 MiB.</p> : null}
      <Diff
        patch={diff.patch}
        path={diff.path}
        view="unified"
        overflow="scroll"
        {...(diff.contents === null ? {} : { experimental_fullFileContents: diff.contents })}
      />
    </div>
  );
}

export function CommitPanel({ threadId }: PanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = useSidebarThread(threadId);
  const { changes, loading, error, refetch } = useChanges(threadId);
  const { overview, applyOverview } = useOverview({ threadId, environmentId: sidebar.environmentId, enabled: true });
  const jobs = useJobs(threadId);
  // Quiet: the status line under the buttons reports every outcome, and bb's
  // toasts would stack right over this form.
  const actions = useVcsActions({ threadId, overview, applyOverview, onCheckedOut: () => undefined, waitForJob: jobs.waitFor, quiet: true });

  const [selected, setSelected] = useState<string | null>(null);
  const [sideChoice, setSideChoice] = useState<DiffSide | null>(null);
  const [diff, setDiff] = useState<FileDiff | "loading" | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [runHooks, setRunHooks] = useState(true);
  // The message Amend filled in, so turning it off can clear it again.
  const prefilled = useRef<string | null>(null);

  const files = useMemo(() => (changes?.ok ? changes.files : []), [changes]);
  const groups = useMemo(
    () => ({
      changes: files.filter((entry) => entry.kind === "tracked"),
      untracked: files.filter((entry) => entry.kind === "untracked"),
      conflicts: files.filter((entry) => entry.kind === "conflicted"),
    }),
    [files],
  );
  const stagedCount = files.filter(isStaged).length;
  const entry = files.find((candidate) => candidate.path === selected) ?? null;
  const sides = entry === null ? [] : diffSidesFor(entry);
  const side: DiffSide | null = sideChoice !== null && sides.includes(sideChoice) ? sideChoice : (sides[0] ?? null);

  useEffect(() => {
    if (entry === null || side === null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff("loading");
    rpc.call("diffFile", { threadId, path: entry.path, oldPath: entry.oldPath, side }).then(
      (next) => {
        if (!cancelled) setDiff(next);
      },
      (cause) => {
        if (!cancelled) setDiff({ ok: false, error: { code: "git_failed", message: errorMessage(cause) } });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch when the list changed, whatever entry object it produced
  }, [rpc, threadId, entry?.path, entry?.oldPath, side, changes]);

  const blocked = commitBlockedReason(overview, changes);
  const busy = actions.busy;
  const disabled = busy || blocked !== null;
  const lastCommit = changes?.ok ? changes.lastCommit : null;
  const head = changes?.ok ? changes.head : null;
  const label = headLabel(overview, sidebar.branchName);

  const toggle = useCallback(
    (target: ChangeEntry) => {
      const state = stageState(target);
      if (target.kind === "conflicted" || state === "unstaged") void actions.stage(pathsOf(target));
      else void actions.unstage(pathsOf(target));
    },
    [actions],
  );
  const toggleAll = useCallback(
    (entries: ChangeEntry[], stageThem: boolean) => {
      const paths = entries
        .filter((candidate) => (stageThem ? stageState(candidate) !== "staged" : stageState(candidate) !== "unstaged"))
        .flatMap(pathsOf);
      if (paths.length === 0) return;
      if (stageThem) void actions.stage(paths);
      else void actions.unstage(paths);
    },
    [actions],
  );

  const toggleAmend = (on: boolean) => {
    setAmend(on);
    if (on && message.trim() === "" && lastCommit !== null) {
      setMessage(lastCommit.message);
      prefilled.current = lastCommit.message;
    } else if (!on && prefilled.current !== null && message === prefilled.current) {
      setMessage("");
      prefilled.current = null;
    }
  };

  const canCommit = !disabled && message.trim().length > 0 && (amend || stagedCount > 0) && head !== null;
  const canPush = canCommit && overview !== null && overview.remotes.length > 0 && overview.head?.kind === "branch";

  const submit = (andPush: boolean) => {
    if (!canCommit) return;
    actions.commit(
      { message, amend, signoff, noVerify: !runHooks },
      {
        andPush,
        onDone: (result) => {
          if (!result.ok) return;
          setMessage("");
          setAmend(false);
          prefilled.current = null;
        },
      },
    );
  };

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit(false);
    }
  };

  const status = actions.status;
  const progress = jobs.progress;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm" data-testid="vcs-commit-panel">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="Check" className="size-4 text-muted-foreground" />
        <span className="font-medium">Commit</span>
        <span className="min-w-0 truncate text-muted-foreground" data-testid="vcs-commit-branch">
          {label}
        </span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="vcs-commit-counts">
          {changes?.ok ? `${stagedCount} staged · ${files.length - stagedCount} unstaged` : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" aria-label="Refresh" onClick={refetch} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </header>

      <div className="min-h-0 shrink-0 basis-2/5 overflow-auto border-b border-border" aria-label="Changed files">
        {error !== null ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : changes === null ? (
          <Empty>Reading the working tree…</Empty>
        ) : !changes.ok ? (
          <p className="p-4 text-sm text-destructive">{changes.error.message}</p>
        ) : files.length === 0 ? (
          <Empty>Nothing to commit: the working tree is clean.</Empty>
        ) : (
          <>
            <Group title="Conflicts" entries={groups.conflicts} selected={selected} disabled={busy} onToggleAll={toggleAll} onToggle={toggle} onSelect={(next) => setSelected(next.path)} onDiscard={(target) => actions.discard([target])} />
            <Group title="Changes" entries={groups.changes} selected={selected} disabled={busy} onToggleAll={toggleAll} onToggle={toggle} onSelect={(next) => setSelected(next.path)} onDiscard={(target) => actions.discard([target])} />
            <Group title="Unversioned files" entries={groups.untracked} selected={selected} disabled={busy} onToggleAll={toggleAll} onToggle={toggle} onSelect={(next) => setSelected(next.path)} onDiscard={(target) => actions.discard([target])} />
            {changes.truncated ? <p className="px-2 py-1 text-xs text-muted-foreground">Only the first {files.length} files are listed.</p> : null}
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {entry !== null ? (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium">{entry.path}</span>
            {sides.length > 1 ? (
              <div role="group" aria-label="Diff side" className="flex gap-1">
                <Button type="button" size="sm" className="h-6 px-2 text-xs" variant={side === "index" ? "secondary" : "ghost"} onClick={() => setSideChoice("index")} aria-pressed={side === "index"}>
                  Staged
                </Button>
                <Button type="button" size="sm" className="h-6 px-2 text-xs" variant={side === "worktree" ? "secondary" : "ghost"} onClick={() => setSideChoice("worktree")} aria-pressed={side === "worktree"}>
                  Unstaged
                </Button>
              </div>
            ) : (
              <span className="text-muted-foreground">{side === "index" ? "Staged" : entry.kind === "untracked" ? "Untracked" : "Unstaged"}</span>
            )}
          </div>
        ) : null}
        <DiffView diff={diff} />
      </div>

      <form
        className="shrink-0 space-y-2 border-t border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(false);
        }}
      >
        <Textarea
          aria-label="Commit message"
          placeholder={amend ? "Amended commit message" : "Commit message"}
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onMessageKeyDown}
          disabled={busy}
          className="min-h-[3.5rem] resize-y font-mono text-xs"
          data-testid="vcs-commit-message"
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <label className="flex items-center gap-1.5">
            <Checkbox checked={amend} onCheckedChange={(value) => toggleAmend(value === true)} disabled={busy || lastCommit === null} aria-label="Amend" />
            Amend
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox checked={signoff} onCheckedChange={(value) => setSignoff(value === true)} disabled={busy} aria-label="Sign-off" />
            Sign-off
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox checked={runHooks} onCheckedChange={(value) => setRunHooks(value === true)} disabled={busy} aria-label="Run Git hooks" />
            Run Git hooks
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={!canCommit} data-testid="vcs-commit-button">
            {amend ? "Amend" : "Commit"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!canPush} onClick={() => submit(true)} data-testid="vcs-commit-push-button">
            {amend ? "Amend and Push" : "Commit and Push"}
          </Button>
          {progress !== null && busy ? (
            <Button type="button" size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={() => void jobs.cancel(progress.jobId)}>
              Cancel
            </Button>
          ) : null}
        </div>
        <div role="status" aria-live="polite" className="text-xs">
          {blocked !== null ? (
            <p className="text-muted-foreground">{blocked}</p>
          ) : changes?.ok && files.length > 0 && stagedCount === 0 && !amend ? (
            <p className="text-muted-foreground">Nothing is staged: tick the files to include.</p>
          ) : null}
          {changes?.ok && changes.operation !== "none" && blocked === null ? (
            <p className="text-muted-foreground">A {changes.operation} is in progress; this commit concludes it.</p>
          ) : null}
          {status.kind === "busy" ? (
            <p className="flex items-center gap-1.5 text-muted-foreground" data-testid="vcs-commit-busy">
              <Icon name="Loading" className="size-3 animate-spin" />
              <span className="min-w-0 flex-1 truncate">
                {status.text}
                {progress?.lastLine ? <span className="ml-2 font-mono text-[11px]">{progress.lastLine}</span> : null}
              </span>
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
              {status.error.stderr ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">Details</summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] text-foreground">{status.error.stderr}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </form>
      <ConfirmStep request={actions.confirm} onCancel={actions.cancelConfirm} onConfirm={actions.acceptConfirm} />
    </div>
  );
}
