// Parsers for git's machine-readable output. Pure functions, fixture-tested.

/** Field order of FOR_EACH_REF_FORMAT; keep the two in sync. */
export const FOR_EACH_REF_FORMAT = [
  "%(refname)",
  "%(objectname:short)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(committerdate:unix)",
  "%(subject)",
  "%(worktreepath)",
  "%(symref)",
  "%(HEAD)",
].join("%00");

export interface RefRow {
  refname: string;
  /** Short name: `feature` for heads, `origin/feature` for remotes. */
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  committedAt: number;
  subject: string;
  worktreePath: string | null;
  /** Non-empty when the ref is a symbolic ref such as origin/HEAD. */
  symref: string | null;
  isHead: boolean;
}

export interface UpstreamTrack {
  ahead: number;
  behind: number;
  gone: boolean;
}

/** Parses `%(upstream:track)`: "[ahead 1, behind 2]", "[gone]", "" ... */
export function parseUpstreamTrack(track: string): UpstreamTrack {
  const inner = track.trim().replace(/^\[|\]$/gu, "");
  if (inner === "") return { ahead: 0, behind: 0, gone: false };
  if (inner === "gone") return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/u.exec(inner);
  const behind = /behind (\d+)/u.exec(inner);
  return {
    ahead: ahead ? Number.parseInt(ahead[1] ?? "0", 10) : 0,
    behind: behind ? Number.parseInt(behind[1] ?? "0", 10) : 0,
    gone: false,
  };
}

const HEADS_PREFIX = "refs/heads/";
const REMOTES_PREFIX = "refs/remotes/";

/**
 * Parses `git for-each-ref --format=<FOR_EACH_REF_FORMAT>` output: one record
 * per line, NUL-separated fields. Malformed lines are skipped.
 */
export function parseForEachRef(raw: string): RefRow[] {
  const rows: RefRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split("\0");
    if (fields.length < 9) continue;
    const [refname, sha, upstream, track, committed, subject, worktreePath, symref, head] =
      fields as [string, string, string, string, string, string, string, string, string];
    const name = refname.startsWith(HEADS_PREFIX)
      ? refname.slice(HEADS_PREFIX.length)
      : refname.startsWith(REMOTES_PREFIX)
        ? refname.slice(REMOTES_PREFIX.length)
        : refname;
    const tracking = parseUpstreamTrack(track);
    rows.push({
      refname,
      name,
      sha,
      upstream: upstream === "" ? null : upstream,
      ahead: tracking.ahead,
      behind: tracking.behind,
      gone: tracking.gone,
      committedAt: Number.parseInt(committed, 10) || 0,
      subject,
      worktreePath: worktreePath === "" ? null : worktreePath,
      symref: symref === "" ? null : symref,
      isHead: head === "*",
    });
  }
  return rows;
}

/** Splits `origin/feature/x` into its remote and branch parts. */
export function splitRemoteRef(name: string, remotes: readonly string[]): {
  remote: string;
  branch: string;
} | null {
  // Prefer the longest configured remote name that prefixes the ref, so a
  // remote called "origin/mirror" is not mistaken for "origin".
  const match = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((remote) => name.startsWith(`${remote}/`));
  if (match) return { remote: match, branch: name.slice(match.length + 1) };
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) return null;
  return { remote: name.slice(0, slash), branch: name.slice(slash + 1) };
}

export interface StatusSummary {
  oid: string | null;
  /** Branch name, or null when detached. */
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

/**
 * Parses `git status --porcelain=v2 --branch -z`. Records are NUL-terminated;
 * rename/copy records carry the original path in the following NUL field.
 */
export function parseStatusV2(raw: string): StatusSummary {
  const summary: StatusSummary = {
    oid: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
  const tokens = raw.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index] ?? "";
    if (record.length === 0) continue;
    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      const value = rest.join(" ");
      switch (key) {
        case "branch.oid":
          summary.oid = value === "(initial)" ? null : value;
          break;
        case "branch.head":
          if (value === "(detached)") {
            summary.detached = true;
            summary.head = null;
          } else {
            summary.head = value;
          }
          break;
        case "branch.upstream":
          summary.upstream = value;
          break;
        case "branch.ab": {
          const ahead = /\+(\d+)/u.exec(value);
          const behind = /-(\d+)/u.exec(value);
          summary.ahead = ahead ? Number.parseInt(ahead[1] ?? "0", 10) : 0;
          summary.behind = behind ? Number.parseInt(behind[1] ?? "0", 10) : 0;
          break;
        }
        default:
          break;
      }
      continue;
    }
    const type = record[0];
    if (type === "?") {
      summary.untracked += 1;
      continue;
    }
    if (type === "!") continue;
    if (type === "u") {
      summary.conflicted += 1;
      continue;
    }
    if (type === "1" || type === "2") {
      const xy = record.slice(2, 4);
      if (xy[0] !== ".") summary.staged += 1;
      if (xy[1] !== ".") summary.unstaged += 1;
      if (type === "2") index += 1; // skip the original path field
    }
  }
  return summary;
}

/**
 * Derives "recently checked out" branches from `git reflog show --format=%gs
 * -n <n> HEAD` (newest first). Only branches that still exist are kept, the
 * current branch is excluded, and the order is most-recent-first.
 */
export function parseRecentFromReflog(
  raw: string,
  options: { current: string | null; existing: ReadonlySet<string>; limit: number },
): string[] {
  const recent: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    if (recent.length >= options.limit) return;
    if (name === options.current || seen.has(name) || !options.existing.has(name)) return;
    seen.add(name);
    recent.push(name);
  };
  for (const line of raw.split("\n")) {
    const match = /^checkout: moving from (.+) to (.+)$/u.exec(line.trim());
    if (!match) continue;
    push(match[2] ?? "");
    push(match[1] ?? "");
    if (recent.length >= options.limit) break;
  }
  return recent;
}

/** "git version 2.55.0" -> "2.55.0"; null when unrecognised. */
export function parseGitVersion(raw: string): string | null {
  const match = /git version (\d+\.\d+(?:\.\d+)?)/u.exec(raw);
  return match ? (match[1] ?? null) : null;
}

export function gitVersionAtLeast(version: string | null, major: number, minor: number): boolean {
  if (version === null) return true; // unknown: assume modern, let git tell us
  const [a = "0", b = "0"] = version.split(".");
  const actualMajor = Number.parseInt(a, 10);
  const actualMinor = Number.parseInt(b, 10);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}
