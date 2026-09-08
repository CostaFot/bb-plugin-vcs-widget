import { describe, expect, it } from "vitest";
import {
  branchNameProblem,
  isValidGitBranchName,
  isValidRefish,
  isValidRemoteName,
} from "./branch-name";

describe("isValidGitBranchName", () => {
  it.each(["main", "feat/click-test", "release-1.2", "v1.0", "user/feat/x_y", "a.b", "hotfix"])(
    "accepts %s",
    (name) => {
      expect(isValidGitBranchName(name)).toBe(true);
    },
  );

  it.each([
    "",
    " ",
    "bad name",
    "-x",
    "a..b",
    "x.lock",
    "feat/x.lock",
    "HEAD",
    "@",
    "/x",
    "x/",
    "a//b",
    ".hidden/x",
    "a/.b",
    "a@{b}",
    "tab\tname",
    "colon:name",
    "star*",
    "quest?",
    "brack[et",
    "tilde~",
    "caret^",
    "back\\slash",
    "ends.",
    "ctrl",
    "a".repeat(256),
  ])("rejects %j", (name) => {
    expect(isValidGitBranchName(name)).toBe(false);
  });
});

describe("branchNameProblem", () => {
  it("returns null for a valid name", () => {
    expect(branchNameProblem("feat/ok")).toBeNull();
  });
  it("names the problem", () => {
    expect(branchNameProblem("bad name")).toMatch(/spaces/u);
    expect(branchNameProblem("a..b")).toMatch(/\.\./u);
    expect(branchNameProblem("-x")).toMatch(/'-'/u);
    expect(branchNameProblem("x.lock")).toMatch(/\.lock/u);
    expect(branchNameProblem("HEAD")).toMatch(/reserved/u);
    expect(branchNameProblem("")).toMatch(/Enter/u);
  });
});

describe("remote and refish names", () => {
  it("accepts ordinary remotes and revisions", () => {
    expect(isValidRemoteName("origin")).toBe(true);
    expect(isValidRemoteName("upstream-2")).toBe(true);
    expect(isValidRefish("main")).toBe(true);
    expect(isValidRefish("origin/main")).toBe(true);
    expect(isValidRefish("HEAD~2")).toBe(true);
    expect(isValidRefish("v1.0^{commit}")).toBe(true);
    expect(isValidRefish("abc1234")).toBe(true);
  });
  it("rejects option-shaped and traversal-shaped values", () => {
    expect(isValidRemoteName("-origin")).toBe(false);
    expect(isValidRemoteName("ori gin")).toBe(false);
    expect(isValidRemoteName("a/b")).toBe(false);
    expect(isValidRefish("-rf")).toBe(false);
    expect(isValidRefish("a..b")).toBe(false);
    expect(isValidRefish("a b")).toBe(false);
    expect(isValidRefish("")).toBe(false);
  });
});
