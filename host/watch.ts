// Live refresh from the machine that owns the worktree: the first overview
// for a repository registers the daemon's native watcher on its git dir (and
// the shared common dir of a linked worktree). Every change becomes one
// `changed` signal per worktree that uses that directory. Watches are
// idempotent per directory, released after an idle period, and capped well
// under the daemon's 256-per-worker limit.
//
// `ignoredPaths` is root-relative, and a plain directory name is the right
// syntax: bb hands the list to @parcel/watcher, whose wrapper resolves every
// non-glob entry against the watched root and then prefix-matches it, so
// `objects` drops the whole subtree. On Linux the recursive walk skips those
// directories outright, so an ignored one costs no inotify watch at all --
// which is the difference between a handful of watches and one per loose
// object directory. bb's own git watcher passes the same shape.
//
// Measured on a repository holding 50k loose objects (2026-09-09): the git
// dir is 265 directories, of which the ignore list leaves 4. Writing those
// objects produced 50,441 watcher events without the ignores and none with
// them. The ignores are what carries that, not `relevant()` below: past
// 4,096 paths in one window the daemon throws the batch away and sends
// `rescan-required` instead, which has no paths to filter and always costs
// an overview read. Unignored, that unpack forced three of them.
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
  /** The watched directory, so an event can be read relative to it. */
  dir: string;
  subscription: Subscription | null;
  pending: Promise<void> | null;
  repoRoots: Set<string>;
  lastUsed: number;
}

export const WATCH_IDLE_MS = 15 * 60_000;
export const MAX_WATCHES = 200;
const SWEEP_MS = 60_000;
// A real fetch settles into one signal; continuous churn is capped at one per
// MAX_WAIT_MS (measured: 7 signals over 10 s of writes every 100 ms).
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 1_500;

/** Directories under a git dir whose churn never changes what the popup shows. */
const IGNORED = ["objects", "lfs", "hooks", "info", "logs", "modules", "rr-cache", "subtree-cache"];

const entries = new Map<string, Entry>();
let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * The second filter, applied to what the watcher still delivers: the ignore
 * list again (a backend other than inotify may only filter, and a linked
 * worktree's own reflog sits below the common dir's top level) plus the pack
 * suffixes, which are not expressible as an ignored path.
 *
 * Matching is relative to the watched directory, never absolute: a repository
 * under a directory named `modules` or `logs` would otherwise have every one
 * of its events dropped and never refresh.
 */
export function relevant(root: string, path: string): boolean {
  const slash = (value: string) => value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const normalized = slash(path);
  const prefix = `${slash(root)}/`;
  // Anything the watcher reports from outside its root is kept: guessing is
  // worse than one extra read.
  const inside = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  const parts = inside.split("/").filter((part) => part.length > 0);
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
      entry = { dir, subscription: null, pending: null, repoRoots: new Set(), lastUsed: Date.now() };
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
    if (!event.changes.some((change) => relevant(entry.dir, change.path))) return;
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
