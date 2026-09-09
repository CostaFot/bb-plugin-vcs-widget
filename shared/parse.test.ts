import { describe, expect, it } from "vitest";
import {
  gitVersionAtLeast,
  parseCommitSummary,
  parseForEachRef,
  parseGitVersion,
  parseLeftRightCount,
  parseCommitDetails,
  parseLog,
  parseLogPage,
  parseNumstat,
  parseRefDecoration,
  parseRecentFromReflog,
  parseStatusEntries,
  parseStatusV2,
  parseTags,
  parseUpstreamTrack,
  splitRemoteRef,
} from "./parse";

const NUL = "\0";

describe("parseUpstreamTrack", () => {
  it.each([
    ["", { ahead: 0, behind: 0, gone: false }],
    ["[gone]", { ahead: 0, behind: 0, gone: true }],
    ["[ahead 3]", { ahead: 3, behind: 0, gone: false }],
    ["[behind 2]", { ahead: 0, behind: 2, gone: false }],
    ["[ahead 1, behind 2]", { ahead: 1, behind: 2, gone: false }],
  ])("parses %j", (input, expected) => {
    expect(parseUpstreamTrack(input)).toEqual(expected);
  });
});

describe("parseForEachRef", () => {
  const heads = [
    ["refs/heads/main", "abc1234", "origin/main", "[ahead 1, behind 2]", "1700000000", "Initial commit", "/repo", "", "*"].join(NUL),
    ["refs/heads/feature", "def5678", "", "", "1700000100", "Add feature: with, punctuation", "", "", " "].join(NUL),
    ["refs/heads/old", "0000aaa", "origin/old", "[gone]", "1600000000", "Old", "/repo-wt", "", " "].join(NUL),
    "",
  ].join("\n");

  it("parses local heads with tracking, worktree and HEAD marker", () => {
    const rows = parseForEachRef(heads);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      name: "main",
      sha: "abc1234",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      gone: false,
      committedAt: 1700000000,
      subject: "Initial commit",
      worktreePath: "/repo",
      symref: null,
      isHead: true,
    });
    expect(rows[1]).toMatchObject({ name: "feature", upstream: null, isHead: false, worktreePath: null });
    expect(rows[2]).toMatchObject({ name: "old", gone: true, worktreePath: "/repo-wt" });
  });

  it("keeps remote names and exposes symrefs such as origin/HEAD", () => {
    const remotes = [
      ["refs/remotes/origin/HEAD", "abc1234", "", "", "1700000000", "Initial commit", "", "refs/remotes/origin/main", " "].join(NUL),
      ["refs/remotes/origin/feature", "def5678", "", "", "1700000100", "Add feature", "", "", " "].join(NUL),
    ].join("\n");
    const rows = parseForEachRef(remotes);
    expect(rows.map((row) => row.name)).toEqual(["origin/HEAD", "origin/feature"]);
    expect(rows[0]?.symref).toBe("refs/remotes/origin/main");
    expect(rows[1]?.symref).toBeNull();
  });

  it("skips malformed lines", () => {
    expect(parseForEachRef("garbage\n\n")).toEqual([]);
  });
});

describe("splitRemoteRef", () => {
  it("prefers the longest configured remote", () => {
    expect(splitRemoteRef("origin/mirror/main", ["origin", "origin/mirror"])).toEqual({
      remote: "origin/mirror",
      branch: "main",
    });
    expect(splitRemoteRef("origin/feat/x", ["origin"])).toEqual({ remote: "origin", branch: "feat/x" });
  });
  it("falls back to the first slash and rejects nonsense", () => {
    expect(splitRemoteRef("up/main", [])).toEqual({ remote: "up", branch: "main" });
    expect(splitRemoteRef("noslash", [])).toBeNull();
    expect(splitRemoteRef("trailing/", [])).toBeNull();
  });
});

describe("parseStatusV2", () => {
  it("reads branch headers and counts staged, unstaged, untracked and conflicted entries", () => {
    const raw = [
      "# branch.oid abc1234",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -2",
      "1 M. N... 100644 100644 100644 h1 h2 staged.txt",
      "1 .M N... 100644 100644 100644 h1 h2 unstaged.txt",
      "1 MM N... 100644 100644 100644 h1 h2 both.txt",
      "2 R. N... 100644 100644 100644 h1 h2 R100 new.txt",
      "old.txt",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
      "? untracked.txt",
      "! ignored.txt",
      "",
    ].join(NUL);
    expect(parseStatusV2(raw)).toEqual({
      oid: "abc1234",
      head: "main",
      detached: false,
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      staged: 3,
      unstaged: 2,
      untracked: 1,
      conflicted: 1,
    });
  });

  it("recognises detached and unborn heads", () => {
    expect(parseStatusV2(["# branch.oid abc", "# branch.head (detached)", ""].join(NUL))).toMatchObject({
      detached: true,
      head: null,
      oid: "abc",
    });
    expect(parseStatusV2(["# branch.oid (initial)", "# branch.head main", ""].join(NUL))).toMatchObject({
      detached: false,
      head: "main",
      oid: null,
    });
  });
});

describe("parseStatusEntries", () => {
  it("lists every entry with its two status letters, renames with the old path", () => {
    const raw = [
      "# branch.oid abc1234",
      "# branch.head main",
      "1 M. N... 100644 100644 100644 h1 h2 staged.txt",
      "1 .M N... 100644 100644 100644 h1 h2 dir/with space.txt",
      "1 MM N... 100644 100644 100644 h1 h2 both.txt",
      "1 A. N... 000000 100644 100644 h1 h2 added.txt",
      "1 .D N... 100644 100644 000000 h1 h2 deleted.txt",
      "2 RM N... 100644 100644 100644 h1 h2 R100 new.txt",
      "old.txt",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
      "? untracked.txt",
      "! ignored.txt",
      "",
    ].join(NUL);
    expect(parseStatusEntries(raw)).toEqual([
      { path: "staged.txt", oldPath: null, index: "M", worktree: ".", kind: "tracked" },
      { path: "dir/with space.txt", oldPath: null, index: ".", worktree: "M", kind: "tracked" },
      { path: "both.txt", oldPath: null, index: "M", worktree: "M", kind: "tracked" },
      { path: "added.txt", oldPath: null, index: "A", worktree: ".", kind: "tracked" },
      { path: "deleted.txt", oldPath: null, index: ".", worktree: "D", kind: "tracked" },
      { path: "new.txt", oldPath: "old.txt", index: "R", worktree: "M", kind: "tracked" },
      { path: "conflict.txt", oldPath: null, index: "U", worktree: "U", kind: "conflicted" },
      { path: "untracked.txt", oldPath: null, index: ".", worktree: "?", kind: "untracked" },
    ]);
  });

  it("returns nothing for a clean tree", () => {
    expect(parseStatusEntries(["# branch.oid abc", "# branch.head main", ""].join(NUL))).toEqual([]);
    expect(parseStatusEntries("")).toEqual([]);
  });
});

describe("parseCommitSummary", () => {
  it("reads the branch, sha and subject of git commit's summary line", () => {
    expect(parseCommitSummary("[main 1a2b3c4] Fix the thing\n 1 file changed, 1 insertion(+)\n")).toEqual({ branch: "main", sha: "1a2b3c4", subject: "Fix the thing" });
    expect(parseCommitSummary("[main (root-commit) 1a2b3c4] first\n")).toEqual({ branch: "main", sha: "1a2b3c4", subject: "first" });
    expect(parseCommitSummary("[detached HEAD 1a2b3c4] on a sha\n")).toEqual({ branch: "detached HEAD", sha: "1a2b3c4", subject: "on a sha" });
    expect(parseCommitSummary("[feat/x (merge) 1a2b3c4] Merge it\n")).toEqual({ branch: "feat/x", sha: "1a2b3c4", subject: "Merge it" });
    expect(parseCommitSummary("On branch main\nnothing to commit\n")).toBeNull();
  });
});

describe("parseRecentFromReflog", () => {
  it("lists recently checked out branches, newest first, excluding the current one", () => {
    const raw = [
      "checkout: moving from feature to main",
      "commit: something",
      "checkout: moving from old to feature",
      "checkout: moving from main to old",
      "checkout: moving from deleted to main",
    ].join("\n");
    expect(
      parseRecentFromReflog(raw, {
        current: "main",
        existing: new Set(["main", "feature", "old"]),
        limit: 10,
      }),
    ).toEqual(["feature", "old"]);
  });
  it("honours the limit", () => {
    const raw = ["checkout: moving from a to b", "checkout: moving from c to a"].join("\n");
    expect(
      parseRecentFromReflog(raw, { current: null, existing: new Set(["a", "b", "c"]), limit: 1 }),
    ).toEqual(["b"]);
  });
});

describe("git version", () => {
  it("parses and compares", () => {
    expect(parseGitVersion("git version 2.55.0\n")).toBe("2.55.0");
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toBe("2.39.5");
    expect(parseGitVersion("nonsense")).toBeNull();
    expect(gitVersionAtLeast("2.55.0", 2, 24)).toBe(true);
    expect(gitVersionAtLeast("2.23.1", 2, 24)).toBe(false);
    expect(gitVersionAtLeast("3.0", 2, 24)).toBe(true);
    expect(gitVersionAtLeast(null, 2, 24)).toBe(true);
  });
});

describe("parseLog / parseNumstat / parseTags", () => {
  it("parses log records with NUL-separated fields", () => {
    const raw = "e39c38c412631e1e46b086779dfbb09d7528009f\x00e39c38c\x00Costa\x001788945062\x00Fix: a\x00b\n54291b34c4ef9a47490d6e1f44e488b94a5adc7b\x0054291b3\x00t\x001788945061\x00first\n";
    expect(parseLog(raw)).toEqual([
      { sha: "e39c38c412631e1e46b086779dfbb09d7528009f", shortSha: "e39c38c", author: "Costa", committedAt: 1788945062, subject: "Fix: a\x00b" },
      { sha: "54291b34c4ef9a47490d6e1f44e488b94a5adc7b", shortSha: "54291b3", author: "t", committedAt: 1788945061, subject: "first" },
    ]);
  });

  it("parses numstat -z including renames and binaries", () => {
    const raw = "1\t0\ta.txt\x00-\t-\timg.png\x003\t2\t\x00old/name.ts\x00new/name.ts\x00";
    expect(parseNumstat(raw)).toEqual([
      { path: "a.txt", oldPath: null, additions: 1, deletions: 0, binary: false },
      { path: "img.png", oldPath: null, additions: 0, deletions: 0, binary: true },
      { path: "new/name.ts", oldPath: "old/name.ts", additions: 3, deletions: 2, binary: false },
    ]);
    expect(parseNumstat("")).toEqual([]);
  });

  it("parses tags and left-right counts", () => {
    expect(parseTags("v1.0\x00abc1234\x001700000000\x00release 1.0\nv0.9\x00def5678\x00\x00\n")).toEqual([
      { name: "v1.0", sha: "abc1234", createdAt: 1700000000, subject: "release 1.0" },
      { name: "v0.9", sha: "def5678", createdAt: 0, subject: "" },
    ]);
    expect(parseLeftRightCount("3\t5\n")).toEqual({ left: 3, right: 5 });
    expect(parseLeftRightCount("")).toEqual({ left: 0, right: 0 });
  });
});

describe("parseRefDecoration", () => {
  it("tells heads, remotes and tags apart by their full names", () => {
    expect(parseRefDecoration("HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main")).toEqual([
      { kind: "head", name: "HEAD" },
      { kind: "local", name: "main" },
      { kind: "tag", name: "v1.0" },
      { kind: "remote", name: "origin/main" },
    ]);
  });

  it("handles a detached HEAD, a branch with a slash and unknown refs", () => {
    expect(parseRefDecoration("HEAD")).toEqual([{ kind: "head", name: "HEAD" }]);
    expect(parseRefDecoration("refs/heads/feature/x, refs/remotes/origin/feature/x")).toEqual([
      { kind: "local", name: "feature/x" },
      { kind: "remote", name: "origin/feature/x" },
    ]);
    expect(parseRefDecoration("refs/stash")).toEqual([{ kind: "other", name: "stash" }]);
    expect(parseRefDecoration("")).toEqual([]);
  });
});

describe("parseLogPage", () => {
  it("parses rows with refs and parents", () => {
    const raw = [
      "aaa1\x00aaa\x00Costa\x001788945062\x00HEAD -> refs/heads/main\x00bbb2 ccc3\x00Merge branch 'x'",
      "bbb2\x00bbb\x00Costa\x001788945061\x00\x00ccc3\x00first",
      "",
    ].join("\n");
    expect(parseLogPage(raw)).toEqual([
      {
        sha: "aaa1",
        shortSha: "aaa",
        author: "Costa",
        committedAt: 1788945062,
        subject: "Merge branch 'x'",
        refs: [
          { kind: "head", name: "HEAD" },
          { kind: "local", name: "main" },
        ],
        parents: ["bbb2", "ccc3"],
      },
      { sha: "bbb2", shortSha: "bbb", author: "Costa", committedAt: 1788945061, subject: "first", refs: [], parents: ["ccc3"] },
    ]);
    expect(parseLogPage("")).toEqual([]);
  });
});

describe("parseCommitDetails", () => {
  it("keeps a multi-line body and both identities", () => {
    const raw = [
      "aaa1",
      "aaa",
      "Costa",
      "costa@example.com",
      "1788945000",
      "Committer",
      "committer@example.com",
      "1788945062",
      "refs/heads/main",
      "bbb2",
      "Subject line\n\nA body paragraph.\n\n",
    ].join("\0");
    expect(parseCommitDetails(raw)).toEqual({
      sha: "aaa1",
      shortSha: "aaa",
      author: "Costa",
      authorEmail: "costa@example.com",
      authoredAt: 1788945000,
      committer: "Committer",
      committerEmail: "committer@example.com",
      committedAt: 1788945062,
      subject: "Subject line",
      message: "Subject line\n\nA body paragraph.",
      refs: [{ kind: "local", name: "main" }],
      parents: ["bbb2"],
    });
  });

  it("returns null for a short record", () => {
    expect(parseCommitDetails("")).toBeNull();
    expect(parseCommitDetails("aaa\x00bbb")).toBeNull();
  });
});
