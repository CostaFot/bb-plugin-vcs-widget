// One mutation per repository at a time. A second caller is told "busy"
// immediately rather than queued behind an operation it cannot see.

const held = new Set<string>();

export const BUSY = Symbol("busy");

export async function tryWithRepoLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | typeof BUSY> {
  if (held.has(key)) return BUSY;
  held.add(key);
  try {
    return await fn();
  } finally {
    held.delete(key);
  }
}

export function isRepoLocked(key: string): boolean {
  return held.has(key);
}
