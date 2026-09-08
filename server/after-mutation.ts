import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Realtime channel the app listens on; payload `{ environmentId, reason }`. */
export const CHANGED_CHANNEL = "changed";

/**
 * bb serves environment status from a short read cache, and only a cache
 * miss records the new branch for its own sidebar. Nudge once now and once
 * after the cache expires so bb's chrome follows a plugin-made checkout.
 */
export const STATUS_CACHE_TTL_MS = 3_000;
const SECOND_NUDGE_DELAY_MS = STATUS_CACHE_TTL_MS + 200;

export interface ChangedPayload {
  environmentId: string;
  reason: string;
}

export function createAfterMutation(bb: BbPluginApi) {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  async function nudgeStatus(environmentId: string): Promise<void> {
    try {
      await bb.sdk.environments.status({ environmentId });
    } catch (error) {
      bb.log.warn(
        `status nudge failed for ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function publish(environmentId: string, reason: string): void {
    const payload: ChangedPayload = { environmentId, reason };
    bb.realtime.publish(CHANGED_CHANNEL, payload);
  }

  /** Call after every successful mutation on `environmentId`. */
  function afterMutation(environmentId: string, reason: string): void {
    void nudgeStatus(environmentId);
    const timer = setTimeout(() => {
      timers.delete(timer);
      void nudgeStatus(environmentId).then(() => publish(environmentId, `${reason}:settled`));
    }, SECOND_NUDGE_DELAY_MS);
    timers.add(timer);
    publish(environmentId, reason);
  }

  function dispose(): void {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  return { afterMutation, publish, dispose };
}
