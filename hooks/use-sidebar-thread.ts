import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";

export interface SidebarThreadInfo {
  status: "loading" | "ready" | "error";
  found: boolean;
  environmentId: string | null;
  environmentName: string | null;
  /** bb's own record of the branch; free, live, but can lag a plugin checkout. */
  branchName: string | null;
  hostName: string | null;
}

/** The thread's environment and branch straight from bb's sidebar cache: no RPC. */
export function useSidebarThread(threadId: string): SidebarThreadInfo {
  const state = experimental_useSidebarThreads();
  const thread = state.threads.find((candidate) => candidate.id === threadId) ?? null;
  return {
    status: state.status,
    found: thread !== null,
    environmentId: thread?.environment?.id ?? null,
    environmentName: thread?.environment?.name ?? null,
    branchName: thread?.environment?.branchName ?? null,
    hostName: thread?.host?.name ?? null,
  };
}
