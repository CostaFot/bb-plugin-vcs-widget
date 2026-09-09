// Values the browser bundle needs that must not drag zod (contracts.ts) or
// server code into app.js. contracts.ts and server/* import from here too.

export const PULL_STRATEGIES = ["ff-only", "rebase", "merge"] as const;
export type PullStrategy = (typeof PULL_STRATEGIES)[number];

export function isPullStrategy(value: unknown): value is PullStrategy {
  return typeof value === "string" && (PULL_STRATEGIES as readonly string[]).includes(value);
}

/** Realtime channel the app listens on; payload `{ environmentId, reason }`. */
export const CHANGED_CHANNEL = "changed";

export interface ChangedPayload {
  environmentId: string;
  reason: string;
}
