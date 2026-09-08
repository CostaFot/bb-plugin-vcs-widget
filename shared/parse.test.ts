import { describe, expect, it } from "vitest";
import {
  gitVersionAtLeast,
  parseForEachRef,
  parseGitVersion,
  parseRecentFromReflog,
  parseStatusV2,
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
