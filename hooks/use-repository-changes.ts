import { useRealtime } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL } from "../shared/constants";
import { useSidebarThread } from "./use-sidebar-thread";

/**
 * Calls `refetch` whenever the repository behind this thread's environment
 * changed: after one of our own actions, a job, bb's environment events or
 * the host worker's file watch. A payload without an environment id means
 * "everyone refetch".
 */
export function useRepositoryChanges(threadId: string, refetch: () => void) {
  const sidebar = useSidebarThread(threadId);
  const environmentId = sidebar.environmentId;
  useRealtime(CHANGED_CHANNEL, (payload) => {
    const change = payload as { environmentId?: unknown; reason?: unknown };
    if (change.reason === "favourites") return;
    if (typeof change.environmentId === "string" && environmentId !== null && change.environmentId !== environmentId) return;
    refetch();
  });
}
