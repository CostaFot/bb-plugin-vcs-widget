import type { GitError } from "../contracts";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** Wraps a transport or unexpected failure as a typed error for the status line. */
export function unexpectedGitError(error: unknown): GitError {
  return { code: "git_failed", message: errorMessage(error) };
}
