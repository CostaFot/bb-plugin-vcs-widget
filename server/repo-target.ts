import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface RepositoryTarget {
  environmentId: string;
  hostId: string;
  repoPath: string;
}

/** Expected states in which a thread has no usable repository; never a crash. */
export class RepositoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryUnavailableError";
  }
}

/**
 * Resolves the thread's environment to the machine and absolute worktree path
 * git must run against. `repoPath` only ever comes from bb's own record.
 */
export async function repositoryForThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<RepositoryTarget> {
  const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
  if (!("environment" in thread) || !thread.environment) {
    throw new RepositoryUnavailableError("This thread has no project environment.");
  }
  const environment = thread.environment;
  if (!environment.path) {
    throw new RepositoryUnavailableError("The thread environment has no workspace path yet.");
  }
  if (environment.status !== "ready") {
    throw new RepositoryUnavailableError(`The thread environment is ${environment.status}.`);
  }
  if (environment.isGitRepo === false) {
    throw new RepositoryUnavailableError("The thread workspace is not a git repository.");
  }
  return {
    environmentId: environment.id,
    hostId: environment.hostId,
    repoPath: environment.path,
  };
}
