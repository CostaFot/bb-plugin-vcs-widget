// One mutation per repository at a time. A second caller is told "busy"
// immediately rather than queued behind an operation it cannot see. A
// background job holds the lock for its whole run (see host/jobs.ts).

const held = new Set<string>();

export const BUSY = Symbol("busy");

export async function tryWithRepoLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | typeof BUSY> {
  const release = tryAcquireRepoLock(key);
  if (release === null) return BUSY;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Takes the lock now; returns the release function, or null when held. Releasing twice is harmless. */
export function tryAcquireRepoLock(key: string): (() => void) | null {
  if (held.has(key)) return null;
  held.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(key);
  };
}

export function isRepoLocked(key: string): boolean {
  return held.has(key);
}
