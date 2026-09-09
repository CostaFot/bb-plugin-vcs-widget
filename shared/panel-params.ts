// The JSON a panel tab is opened with is persisted by bb and restored across
// reloads, so it is untrusted input: parse it back into typed refs.
import type { BranchRef } from "../contracts";
import { isValidGitBranchName, isValidRemoteName } from "./branch-name";

export interface CompareParams {
  base: BranchRef;
  target: BranchRef;
}

export interface DiffParams {
  ref: BranchRef;
}

export function parseBranchRef(value: unknown): BranchRef | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { kind?: unknown; name?: unknown; remote?: unknown; branch?: unknown };
  if (candidate.kind === "local") {
    return typeof candidate.name === "string" && isValidGitBranchName(candidate.name) ? { kind: "local", name: candidate.name } : null;
  }
  if (candidate.kind === "remote") {
    return typeof candidate.remote === "string" &&
      typeof candidate.branch === "string" &&
      isValidRemoteName(candidate.remote) &&
      isValidGitBranchName(candidate.branch)
      ? { kind: "remote", remote: candidate.remote, branch: candidate.branch }
      : null;
  }
  return null;
}

export function parseCompareParams(value: unknown): CompareParams | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { base?: unknown; target?: unknown };
  const base = parseBranchRef(candidate.base);
  const target = parseBranchRef(candidate.target);
  return base !== null && target !== null ? { base, target } : null;
}

export function parseDiffParams(value: unknown): DiffParams | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = parseBranchRef((value as { ref?: unknown }).ref);
  return ref === null ? null : { ref };
}
