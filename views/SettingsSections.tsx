// The plugin's own blocks on its settings page, under bb's form for the
// declared settings: what the plugin exposes to agents and to a terminal
// (read-only, deliberately), and the favourites the popup keeps per machine
// and worktree, which nothing else can list or clear.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { FavouriteRepo } from "../contracts";
import { errorMessage } from "../lib/errors";
import type { rpcContract } from "../server";
import { favouriteLabel } from "../shared/model";
import { Button } from "@/components/ui/button";

const READS = [
  ["bb vcs-widget status", "branch, upstream, working tree, running job"],
  ["bb vcs-widget branches --all", "local and remote branches with ahead/behind"],
  ["bb vcs-widget log --grep fix", "recent commits, literal message filter"],
];

export function AgentAccessSection() {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Agents and terminals can read this repository through the{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">vcs-widget</code> command and the{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">vcs_widget_status</code> tool. Both only read: no plugin
        command, flag or tool checks out, commits, pushes, rebases or deletes anything.
      </p>
      <ul className="space-y-1">
        {READS.map(([command, what]) => (
          <li key={command} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{command}</code>
            <span className="text-xs text-muted-foreground">{what}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Checkout, commit, push and the rest stay with you, in the branch popup, the Commit panel and the Git Log, where
        each one shows the exact git command first. Every mutation the plugin runs is written to its log with the thread
        that asked for it — the plugin’s “Safety model” doc says what that does and does not guarantee.
      </p>
    </div>
  );
}

function RepoRow({ repo, onClear, busy }: { repo: FavouriteRepo; onClear: () => void; busy: boolean }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0 space-y-1">
        <p className="truncate font-mono text-xs" title={`${repo.repoRoot} on ${repo.hostId}`}>
          {repo.repoRoot}
        </p>
        <p className="flex flex-wrap gap-1">
          {repo.names.map((key) => {
            const label = favouriteLabel(key);
            return (
              <span
                key={key}
                className="rounded bg-muted px-1.5 py-0.5 text-xs"
                title={label.kind === "remote" ? "Remote branch" : label.kind === "local" ? "Local branch" : key}
              >
                {label.name}
              </span>
            );
          })}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onClear} disabled={busy}>
        Clear
      </Button>
    </li>
  );
}

export function FavouritesSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [repos, setRepos] = useState<FavouriteRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("favouriteRepos", {});
      setRepos(result.repos);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = useCallback(
    async (repo: FavouriteRepo) => {
      setBusy(true);
      try {
        const result = await rpc.call("clearFavourites", { hostId: repo.hostId, repoRoot: repo.repoRoot });
        setRepos(result.repos);
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );

  if (error !== null) return <p className="text-sm text-destructive">Could not read the favourites: {error}</p>;
  if (repos === null) return <p className="text-sm text-muted-foreground">Reading…</p>;
  if (repos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No favourites yet. The star on a branch row in the popup adds one; they are kept per machine and worktree, not
        per thread.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {repos.map((repo) => (
        <RepoRow key={`${repo.hostId}:${repo.repoRoot}`} repo={repo} onClear={() => void clear(repo)} busy={busy} />
      ))}
    </ul>
  );
}
