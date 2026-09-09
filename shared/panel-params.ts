// The JSON a panel tab is opened with is persisted by bb and restored across
// reloads, so it is untrusted input: parse it back into typed refs.
import type { BranchRef, CompareRef, LogFilter } from "../contracts";
import { isValidGitBranchName, isValidRefish, isValidRemoteName } from "./branch-name";

/** The panel tabs this plugin registers, by the id app.tsx gives them. */
export const PANEL_ACTION = { compare: "compare", diff: "diff", commit: "commit", log: "log" } as const;

export interface CompareParams {
  base: CompareRef;
  target: CompareRef;
}

export interface LogParams {
  filter: LogFilter;
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

/** A branch ref, or a revision the log pointed at. */
export function parseCompareRef(value: unknown): CompareRef | null {
  const branch = parseBranchRef(value);
  if (branch !== null) return branch;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { kind?: unknown; revision?: unknown };
  return candidate.kind === "revision" && typeof candidate.revision === "string" && isValidRefish(candidate.revision)
    ? { kind: "revision", revision: candidate.revision }
    : null;
}

export function parseCompareParams(value: unknown): CompareParams | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { base?: unknown; target?: unknown };
  const base = parseCompareRef(candidate.base);
  const target = parseCompareRef(candidate.target);
  return base !== null && target !== null ? { base, target } : null;
}

/** The log tab remembers which refs it walks; anything unrecognised means "all branches". */
export function parseLogParams(value: unknown): LogParams {
  const all: LogParams = { filter: { kind: "all" } };
  if (typeof value !== "object" || value === null) return all;
  const filter = (value as { filter?: unknown }).filter;
  if (typeof filter !== "object" || filter === null) return all;
  const candidate = filter as { kind?: unknown; ref?: unknown };
  if (candidate.kind === "head") return { filter: { kind: "head" } };
  if (candidate.kind === "ref") {
    const ref = parseBranchRef(candidate.ref);
    return ref === null ? all : { filter: { kind: "ref", ref } };
  }
  return all;
}

export function parseDiffParams(value: unknown): DiffParams | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = parseBranchRef((value as { ref?: unknown }).ref);
  return ref === null ? null : { ref };
}
