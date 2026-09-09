import type { Overview } from "../contracts";
import type { JobProgress } from "../hooks/use-jobs";
import type { ActionStatus } from "../hooks/use-vcs-actions";
import { MIN_GIT_VERSION } from "../shared/constants";
import { gitTooOld } from "../shared/model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface StatusLineProps {
  status: ActionStatus;
  overview: Overview | null;
  loading: boolean;
  loadError: string | null;
  /** The job this pane is waiting for. */
  jobProgress: JobProgress | null;
  onCancelJob: (jobId: string) => void;
  onAbort: () => void;
}

const JOB_LABEL: Record<string, string> = {
  fetch: "Fetch",
  pull: "Update Project",
  push: "Push",
  updateBranch: "Update",
  deleteRemoteBranch: "Remote delete",
};

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/** Repository banners (detached, in-progress operation, lock, jobs) and the last action's outcome. */
export function StatusLine({ status, overview, loading, loadError, jobProgress, onCancelJob, onAbort }: StatusLineProps) {
  const banners: string[] = [];
  if (overview && overview.unavailableReason === null && gitTooOld(overview)) {
    banners.push(`git ${overview.gitVersion ?? "?"} on this machine is too old; the plugin needs ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or newer.`);
  }
  if (overview?.head?.kind === "detached") banners.push(`Detached HEAD at ${overview.head.sha.slice(0, 7)}.`);
  if (overview?.head?.kind === "unborn") banners.push("The repository has no commits yet.");
  if (overview?.indexLocked) banners.push("Another git process holds the index lock.");
  if (overview?.local.some((branch) => branch.isCurrent && branch.gone)) {
    banners.push("The upstream branch is gone.");
  }
  if (overview && overview.workingTree.conflicted > 0) banners.push(`${overview.workingTree.conflicted} conflicted file(s).`);
  const operation = overview && overview.operation !== "none" ? overview.operation : null;
  // Another pane's job (or one from before a reload): the overview knows it.
  const foreignJob = overview?.activeJob && overview.activeJob.jobId !== jobProgress?.jobId ? overview.activeJob : null;

  return (
    <div role="status" aria-live="polite" className="border-t border-border px-3 py-1.5 text-xs">
      {loadError !== null ? (
        <p className="text-destructive">Could not read the repository: {loadError}</p>
      ) : null}
      {banners.map((banner) => (
        <p key={banner} className="text-muted-foreground">
          {banner}
        </p>
      ))}
      {operation !== null ? (
        <p className="flex items-center gap-2 text-muted-foreground" data-testid="vcs-operation-banner">
          <Icon name="AlertTriangle" className="size-3 shrink-0" />
          <span className="flex-1">A {operation} is in progress.</span>
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onAbort} disabled={status.kind === "busy"}>
            Abort
          </Button>
        </p>
      ) : null}
      {foreignJob !== null ? (
        <p className="flex items-center gap-2 text-muted-foreground" data-testid="vcs-active-job">
          <Icon name="Loading" className="size-3 shrink-0 animate-spin" />
          <span className="flex-1 truncate" title={foreignJob.command}>
            {JOB_LABEL[foreignJob.kind] ?? foreignJob.kind} running for {elapsed(foreignJob.startedAt)}.
          </span>
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onCancelJob(foreignJob.jobId)}>
            Cancel
          </Button>
        </p>
      ) : null}
      {status.kind === "busy" ? (
        <div className="flex items-center gap-2 text-muted-foreground" data-testid="vcs-busy">
          <Icon name="Loading" className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1">
            <span>{status.text}</span>
            {jobProgress?.lastLine ? <span className="block truncate font-mono text-[11px]">{jobProgress.lastLine}</span> : null}
          </span>
          {jobProgress !== null ? (
            <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onCancelJob(jobProgress.jobId)}>
              Cancel
            </Button>
          ) : null}
        </div>
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
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] text-foreground">
                {status.error.stderr}
              </pre>
            </details>
          ) : null}
        </div>
      ) : loading && overview === null ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Icon name="Loading" className="size-3 animate-spin" />
          Reading repository…
        </p>
      ) : overview ? (
        <p className={cn("truncate text-muted-foreground")}>
          {overview.repoName}
          {overview.upstream
            ? ` · ${overview.upstream.name}${overview.upstream.ahead ? ` ↑${overview.upstream.ahead}` : ""}${overview.upstream.behind ? ` ↓${overview.upstream.behind}` : ""}`
            : " · no upstream"}
          {loading ? " · refreshing…" : ""}
        </p>
      ) : null}
    </div>
  );
}
