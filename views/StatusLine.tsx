import type { Overview } from "../contracts";
import type { ActionStatus } from "../hooks/use-vcs-actions";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface StatusLineProps {
  status: ActionStatus;
  overview: Overview | null;
  loading: boolean;
  loadError: string | null;
}

/** Repository banners (detached, in-progress operation, lock) and the last action's outcome. */
export function StatusLine({ status, overview, loading, loadError }: StatusLineProps) {
  const banners: string[] = [];
  if (overview?.head?.kind === "detached") banners.push(`Detached HEAD at ${overview.head.sha.slice(0, 7)}.`);
  if (overview?.head?.kind === "unborn") banners.push("The repository has no commits yet.");
  if (overview && overview.operation !== "none") banners.push(`A ${overview.operation} is in progress.`);
  if (overview?.indexLocked) banners.push("Another git process holds the index lock.");
  if (overview?.local.some((branch) => branch.isCurrent && branch.gone)) {
    banners.push("The upstream branch is gone.");
  }
  if (overview && overview.workingTree.conflicted > 0) banners.push(`${overview.workingTree.conflicted} conflicted file(s).`);

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
