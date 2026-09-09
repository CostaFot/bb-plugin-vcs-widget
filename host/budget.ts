// One time budget per host call. bb cancels every server -> host call at a
// fixed 30 s (COMMAND_TIMEOUT_MS in apps/server/src/constants.ts) and offers
// no override, so a handler's git commands share one clock: resolve, the
// pre-flight reads, the action itself and the overview read afterwards.

export const HOST_CALL_CAP_MS = 30_000;
/** Leaves transport headroom under bb's cap. */
export const DEFAULT_BUDGET_MS = 27_000;
/** Kept back from mutations so the overview read afterwards can still run. */
export const OVERVIEW_RESERVE_MS = 4_000;
/** Below this the overview read is skipped and the result carries `overview: null`. */
export const MIN_OVERVIEW_MS = 2_500;

/** Upper bounds per command kind; the budget can only lower them. */
export const DEADLINES_MS = {
  read: 10_000,
  mutate: 15_000,
  network: 20_000,
} as const;

export type DeadlineKind = keyof typeof DEADLINES_MS;

export interface Budget {
  /** Milliseconds left in this call. */
  remaining(): number;
  /**
   * Deadline for the next command: the kind's cap, cut down to what is left.
   * Mutations and network calls also leave the overview reserve behind.
   */
  deadlineFor(kind: DeadlineKind): number;
}

/** Test hook: `VCS_GROUP_BUDGET_MS` shrinks the budget so timeouts are quick. */
function configuredBudgetMs(): number {
  const raw = process.env.VCS_GROUP_BUDGET_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET_MS;
}

export function createBudget(totalMs = configuredBudgetMs(), now: () => number = Date.now): Budget {
  const startedAt = now();
  const remaining = () => Math.max(0, totalMs - (now() - startedAt));
  return {
    remaining,
    deadlineFor(kind) {
      const left = remaining();
      const reserve = kind === "read" ? 0 : Math.min(OVERVIEW_RESERVE_MS, Math.floor(totalMs / 4));
      return Math.max(0, Math.min(DEADLINES_MS[kind], left - reserve));
    },
  };
}
