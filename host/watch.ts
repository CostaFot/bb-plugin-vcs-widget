// Live refresh from the machine that owns the worktree: the first overview
// for a repository registers the daemon's native watcher on its git dir (and
// the shared common dir of a linked worktree). Every change becomes one
// `changed` signal per worktree that uses that directory. Watches are
// idempotent per directory, released after an idle period, and capped well
// under the daemon's 256-per-worker limit.
import type { RepoInfo } from "./repo";

interface WatchOptions {
  readonly rootPath: string;
  readonly ignoredPaths?: readonly string[];
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
}

type WatchEvent =
  | { readonly kind: "changed"; readonly changes: readonly { readonly path: string; readonly type: string }[] }
  | { readonly kind: "rescan-required" }
  | { readonly kind: "watch-error"; readonly message: string };

interface Subscription {
  dispose(): Promise<void>;
}

export interface WatchContext {
  experimental_watch(options: WatchOptions, listener: (event: WatchEvent) => void | Promise<void>): Promise<Subscription>;
}

export type EmitChanged = (repoRoot: string, reason: string) => Promise<void>;

interface Entry {
  subscription: Subscription | null;
  pending: Promise<void> | null;
  repoRoots: Set<string>;
  lastUsed: number;
}

export const WATCH_IDLE_MS = 15 * 60_000;
export const MAX_WATCHES = 200;
const SWEEP_MS = 60_000;
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 1_500;

/** Directories under a git dir whose churn never changes what the popup shows. */
const IGNORED = ["objects", "lfs", "hooks", "info", "logs", "modules", "rr-cache", "subtree-cache"];

const entries = new Map<string, Entry>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function relevant(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  // Absolute paths: keep the last segments that sit under the git dir; any
  // ignored directory name anywhere in the path is enough to drop it.
  if (parts.some((part) => IGNORED.includes(part))) return false;
  const last = parts[parts.length - 1] ?? "";
  return !/\.(?:pack|idx|bitmap|tmp)$/u.test(last);
}

/**
 * Registers (or refreshes) the watches for a repository. Never throws: a
 * watcher that cannot start only costs live refresh.
 */
export function ensureWatch(repo: RepoInfo, context: WatchContext, emit: EmitChanged): void {
  const dirs = repo.gitDir === repo.commonDir ? [repo.gitDir] : [repo.gitDir, repo.commonDir];
  for (const dir of dirs) {
    let entry = entries.get(dir);
    if (entry === undefined) {
      if (entries.size >= MAX_WATCHES) evictOldest();
      entry = { subscription: null, pending: null, repoRoots: new Set(), lastUsed: Date.now() };
      entries.set(dir, entry);
    }
    entry.repoRoots.add(repo.repoRoot);
    entry.lastUsed = Date.now();
    if (entry.subscription === null && entry.pending === null) {
      const current = entry;
      current.pending = context
        .experimental_watch(
          { rootPath: dir, ignoredPaths: IGNORED, debounceMs: DEBOUNCE_MS, maxWaitMs: MAX_WAIT_MS },
          (event) => onEvent(current, event, emit),
        )
        .then(
          (subscription) => {
            current.pending = null;
            if (entries.get(dir) !== current) {
              void subscription.dispose();
              return;
            }
            current.subscription = subscription;
          },
          () => {
            current.pending = null;
            entries.delete(dir);
          },
        );
    }
  }
  if (sweeper === null) {
    sweeper = setInterval(sweep, SWEEP_MS);
    sweeper.unref?.();
  }
}

async function onEvent(entry: Entry, event: WatchEvent, emit: EmitChanged): Promise<void> {
  let reason: string;
  if (event.kind === "changed") {
    if (!event.changes.some((change) => relevant(change.path))) return;
    reason = "watch";
  } else if (event.kind === "rescan-required") {
    reason = "watch:rescan";
  } else {
    reason = "watch:error";
  }
  await Promise.allSettled([...entry.repoRoots].map((repoRoot) => emit(repoRoot, reason)));
}

function evictOldest(): void {
  let oldest: [string, Entry] | null = null;
  for (const candidate of entries) {
    if (oldest === null || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate;
  }
  if (oldest !== null) void release(oldest[0]);
}

async function release(dir: string): Promise<void> {
  const entry = entries.get(dir);
  if (entry === undefined) return;
  entries.delete(dir);
  await entry.pending?.catch(() => undefined);
  await entry.subscription?.dispose().catch(() => undefined);
}

function sweep(): void {
  const cutoff = Date.now() - WATCH_IDLE_MS;
  for (const [dir, entry] of entries) {
    if (entry.lastUsed < cutoff) void release(dir);
  }
  if (entries.size === 0 && sweeper !== null) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Test hook. */
export function watchedDirectories(): string[] {
  return [...entries.keys()];
}

export async function disposeWatches(): Promise<void> {
  if (sweeper !== null) {
    clearInterval(sweeper);
    sweeper = null;
  }
  await Promise.allSettled([...entries.keys()].map((dir) => release(dir)));
}
