import { describe, expect, it } from "vitest";
import type { LogPage, Overview } from "../contracts";
import { unavailableOverview } from "../contracts";
import {
  CLI_HELP,
  branchesJson,
  formatBranches,
  formatLog,
  formatStatus,
  formatTimestamp,
  parseCli,
  runCli,
  statusJson,
  type CliReader,
} from "./cli";

function overview(extra: Partial<Overview> = {}): Overview {
  return {
    ...unavailableOverview(""),
    unavailableReason: null,
    repoRoot: "/repo",
    repoName: "repo",
    gitVersion: "2.55.0",
    head: { kind: "branch", name: "main", sha: "abc1234def" },
    remotes: ["origin"],
    upstream: { name: "origin/main", remote: "origin", branch: "main", ahead: 2, behind: 1, gone: false },
    workingTree: { staged: 1, unstaged: 2, untracked: 0, conflicted: 0 },
    local: [
      {
        name: "main",
        sha: "abc1234def",
        upstream: "origin/main",
        ahead: 2,
        behind: 1,
        gone: false,
        isCurrent: true,
        worktreePath: null,
        committedAt: 1_757_000_000,
        subject: "first",
      },
      {
        name: "feature",
        sha: "def5678abc",
        upstream: null,
        ahead: 0,
        behind: 0,
        gone: false,
        isCurrent: false,
        worktreePath: "/other",
        committedAt: 1_757_000_000,
        subject: "second",
      },
    ],
    remote: [
      { name: "origin/main", remote: "origin", branch: "main", sha: "abc1234def", hasLocal: true, committedAt: 1_757_000_000, subject: "first" },
    ],
    ...extra,
  };
}

const page: LogPage = {
  ok: true,
  commits: [
    { sha: "abc1234def", shortSha: "abc1234", author: "Costa", committedAt: 1_757_000_000, subject: "a change", refs: [{ kind: "head", name: "main" }], parents: [] },
    { sha: "999888777f", shortSha: "9998887", author: "Costa", committedAt: 1_756_900_000, subject: "an older change", refs: [], parents: ["abc1234def"] },
  ],
  skip: 0,
  hasMore: false,
};

function reader(over: Overview = overview(), log: LogPage = page): CliReader & { logCalls: unknown[] } {
  const logCalls: unknown[] = [];
  return {
    logCalls,
    overview: async () => over,
    log: async (threadId, input) => {
      logCalls.push({ threadId, ...input });
      return log;
    },
  };
}

describe("parseCli", () => {
  it("reads help with no arguments", () => {
    expect(parseCli([])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseCli(["--help"])).toEqual({ ok: true, command: { kind: "help" } });
  });

  it("defaults branches to the local list and log to the current branch", () => {
    expect(parseCli(["branches"])).toEqual({
      ok: true,
      command: { kind: "branches", threadId: null, json: false, scope: "local", limit: 50 },
    });
    expect(parseCli(["log"])).toEqual({
      ok: true,
      command: { kind: "log", threadId: null, json: false, filter: { kind: "head" }, grep: null, limit: 20 },
    });
  });

  it("takes the flags each command declares", () => {
    expect(parseCli(["branches", "--all", "--limit", "5", "--thread", "t1", "--json"])).toEqual({
      ok: true,
      command: { kind: "branches", threadId: "t1", json: true, scope: "all", limit: 5 },
    });
    expect(parseCli(["log", "--branch", "feature", "--grep", "fix"])).toEqual({
      ok: true,
      command: { kind: "log", threadId: null, json: false, filter: { kind: "ref", ref: { kind: "local", name: "feature" } }, grep: "fix", limit: 20 },
    });
  });

  it("caps a limit at the page the host reads", () => {
    expect(parseCli(["log", "--limit", "5000"])).toMatchObject({ command: { limit: 100 } });
    expect(parseCli(["branches", "--limit", "5000"])).toMatchObject({ command: { limit: 500 } });
  });

  it("rejects an unknown command, an unknown flag and a flag with no value", () => {
    expect(parseCli(["checkout", "main"])).toEqual({ ok: false, message: 'Unknown command "checkout".' });
    expect(parseCli(["status", "--force"])).toEqual({ ok: false, message: 'Unknown option "--force".' });
    expect(parseCli(["status", "--thread"])).toEqual({ ok: false, message: "--thread needs a value." });
    expect(parseCli(["status", "main"])).toEqual({ ok: false, message: 'Unexpected argument "main".' });
  });

  it("refuses a branch name git would refuse and a filter that is not one line", () => {
    expect(parseCli(["log", "--branch", "bad name"])).toMatchObject({ ok: false });
    expect(parseCli(["log", "--branch", "-x"])).toMatchObject({ ok: false });
    expect(parseCli(["log", "--grep", "a\nb"])).toEqual({ ok: false, message: "--grep cannot contain newlines." });
    expect(parseCli(["log", "--grep", "x".repeat(201)])).toMatchObject({ ok: false });
  });

  it("refuses conflicting scopes", () => {
    expect(parseCli(["branches", "--all", "--remote"])).toEqual({ ok: false, message: "Use --remote or --all, not both." });
    expect(parseCli(["log", "--all", "--branch", "main"])).toEqual({ ok: false, message: "Use --branch or --all, not both." });
  });

  it("rejects a limit that is not a whole number of rows", () => {
    expect(parseCli(["log", "--limit", "0"])).toMatchObject({ ok: false });
    expect(parseCli(["log", "--limit", "two"])).toMatchObject({ ok: false });
  });
});

describe("formatting", () => {
  it("prints a status a human can read", () => {
    expect(formatStatus(overview())).toBe(
      [
        "Repository: repo (/repo)",
        "HEAD:       main (abc1234)",
        "Upstream:   origin/main (ahead 2, behind 1)",
        "Working:    1 staged, 2 unstaged",
        "Branches:   2 local, 1 remote",
        "Remotes:    origin",
        "Git:        2.55.0",
      ].join("\n"),
    );
  });

  it("names a detached head, a missing upstream, a running job and a stuck operation", () => {
    const text = formatStatus(
      overview({
        head: { kind: "detached", sha: "abc1234def" },
        upstream: null,
        operation: "rebase",
        indexLocked: true,
        workingTree: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        activeJob: { jobId: "j1", kind: "push", command: "git push origin HEAD", startedAt: 1_757_000_000 },
      }),
    );
    expect(text).toContain("HEAD:       detached at abc1234");
    expect(text).toContain("Upstream:   none");
    expect(text).toContain("Working:    clean");
    expect(text).toContain("Operation:  rebase in progress");
    expect(text).toContain("Index:      locked");
    expect(text).toContain("Job:        push since 2025-09-04 15:33 — git push origin HEAD");
  });

  it("marks the current branch, a missing upstream and another worktree", () => {
    const text = formatBranches(overview(), "all", 50);
    expect(text).toContain("* main");
    expect(text).toContain("origin/main +2/-1");
    expect(text).toContain("no upstream");
    expect(text).toContain("[worktree /other]");
    expect(text).toContain("Remote branches (1)");
  });

  it("says how many branches it left out", () => {
    expect(formatBranches(overview(), "local", 1)).toContain("… 1 more (use --limit).");
  });

  it("prints the reason instead of a table when the thread has no repository", () => {
    const text = formatBranches(unavailableOverview("This thread has no project environment."), "all", 50);
    expect(text).toBe("This thread has no project environment.");
  });

  it("prints commits with their refs and says when more exist", () => {
    const text = formatLog(page.ok ? page.commits : [], true);
    expect(text).toContain("abc1234  2025-09-04 15:33  Costa   a change  (main)");
    expect(text).toContain("… more commits");
  });

  it("keeps the json shapes bounded", () => {
    const status = statusJson(overview()) as { branchCounts: unknown; local?: unknown };
    expect(status.local).toBeUndefined();
    expect(status.branchCounts).toEqual({ local: 2, remote: 1, truncated: { local: false, remote: false } });
    const branches = branchesJson(overview(), "local", 1) as { local: unknown[]; remote: unknown[] };
    expect(branches.local).toHaveLength(1);
    expect(branches.remote).toHaveLength(0);
  });

  it("formats a timestamp in UTC and survives a missing one", () => {
    expect(formatTimestamp(0)).toBe("unknown");
    expect(formatTimestamp(1_757_000_000)).toBe("2025-09-04 15:33");
  });
});

describe("runCli", () => {
  it("prints help and exits 0", async () => {
    const result = await runCli([], "t1", reader());
    expect(result).toEqual({ exitCode: 0, stdout: `${CLI_HELP}\n` });
  });

  it("prefers --thread over the calling thread", async () => {
    const read = reader();
    await runCli(["log", "--thread", "t9"], "t1", read);
    expect(read.logCalls).toEqual([{ threadId: "t9", filter: { kind: "head" }, grep: null, skip: 0 }]);
  });

  it("asks for a thread when there is none", async () => {
    const result = await runCli(["status"], undefined, reader());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--thread <id>");
  });

  it("exits 2 on a usage error and prints the help with it", async () => {
    const result = await runCli(["nope"], "t1", reader());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown command "nope".');
    expect(result.stderr).toContain("bb vcs-widget status");
  });

  it("exits 1 with the reason when the thread has no repository", async () => {
    const result = await runCli(["status"], "t1", reader(unavailableOverview("The thread workspace is not a git repository.")));
    expect(result).toEqual({ exitCode: 1, stderr: "The thread workspace is not a git repository.\n" });
  });

  it("exits 1 with the git error and its hint", async () => {
    const failing: LogPage = { ok: false, error: { code: "ref_not_found", message: "No such branch.", hint: "Fetch first." } };
    const result = await runCli(["log", "--branch", "missing"], "t1", reader(overview(), failing));
    expect(result).toEqual({ exitCode: 1, stderr: "No such branch.\nFetch first.\n" });
  });

  it("slices the page to --limit and says more remain", async () => {
    const result = await runCli(["log", "--limit", "1"], "t1", reader());
    expect(result.stdout).toContain("abc1234");
    expect(result.stdout).not.toContain("9998887");
    expect(result.stdout).toContain("… more commits");
  });

  it("turns a read that throws into an exit code and a sentence", async () => {
    const broken: CliReader = {
      overview: async () => {
        throw new Error("HTTP 404: Thread not found");
      },
      log: async () => {
        throw new Error("HTTP 404: Thread not found");
      },
    };
    const result = await runCli(["status", "--thread", "nope"], undefined, broken);
    expect(result).toEqual({ exitCode: 1, stderr: "Could not read the repository: HTTP 404: Thread not found\n" });
  });

  it("prints json when asked", async () => {
    const result = await runCli(["branches", "--json"], "t1", reader());
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({ counts: { local: 2, remote: 1 } });
  });
});
