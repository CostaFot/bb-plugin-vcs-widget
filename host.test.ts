import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import hostEntry from "./host";

const exec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "VCS Test",
  GIT_AUTHOR_EMAIL: "vcs@example.com",
  GIT_COMMITTER_NAME: "VCS Test",
  GIT_COMMITTER_EMAIL: "vcs@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function commit(cwd: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), content);
  await git(cwd, "add", "--", file);
  await git(cwd, "commit", "-q", "-m", message);
}

let root: string;
let repo: string;
let bare: string;
let other: string;
const harness = experimental_createHostEntryHarness(hostEntry);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vcs-group-host-"));
  repo = join(root, "repo");
  bare = join(root, "origin.git");
  other = join(root, "other");
  await exec("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  await commit(repo, "a.txt", "a\n", "first");
  await commit(repo, "b.txt", "b\n", "second");
  await exec("git", ["clone", "-q", "--bare", repo, bare], { env: GIT_ENV });
  await git(repo, "remote", "add", "origin", bare);
  await git(repo, "push", "-q", "-u", "origin", "main");
  await git(repo, "branch", "feature");
  await git(repo, "push", "-q", "origin", "feature");
  await git(repo, "branch", "-D", "feature");
  await exec("git", ["clone", "-q", bare, other], { env: GIT_ENV });
}, 60_000);

afterAll(async () => {
  await harness.experimental_dispose();
  await rm(root, { recursive: true, force: true });
});

describe("overview", () => {
  it("describes a healthy repository", async () => {
    const overview = await harness.experimental_call("overview", { repoPath: repo, recentLimit: 8 });
    expect(overview.unavailableReason).toBeNull();
    expect(overview.repoName).toBe("repo");
    expect(overview.head).toMatchObject({ kind: "branch", name: "main" });
    expect(overview.remotes).toEqual(["origin"]);
    expect(overview.local.map((branch) => branch.name)).toEqual(["main"]);
    expect(overview.local[0]).toMatchObject({ isCurrent: true, upstream: "origin/main", ahead: 0, behind: 0, worktreePath: null });
    expect(overview.remote.map((branch) => branch.name).sort()).toEqual(["origin/feature", "origin/main"]);
    expect(overview.remote.find((branch) => branch.name === "origin/main")?.hasLocal).toBe(true);
    expect(overview.remote.find((branch) => branch.name === "origin/feature")?.hasLocal).toBe(false);
    expect(overview.upstream).toEqual({ name: "origin/main", ahead: 0, behind: 0 });
    expect(overview.operation).toBe("none");
    expect(overview.indexLocked).toBe(false);
    expect(overview.workingTree).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(overview.gitVersion).toMatch(/^\d+\.\d+/u);
  });

  it("reports a non-repository and a missing path as unavailable", async () => {
    const notRepo = await harness.experimental_call("overview", { repoPath: root, recentLimit: 8 });
    expect(notRepo.unavailableReason).toMatch(/git/iu);
    expect(notRepo.local).toEqual([]);
    const missing = await harness.experimental_call("overview", { repoPath: join(root, "nope"), recentLimit: 8 });
    expect(missing.unavailableReason).toMatch(/does not exist/u);
    const relative = await harness.experimental_call("overview", { repoPath: "relative/path", recentLimit: 8 });
    expect(relative.unavailableReason).toMatch(/absolute/u);
  });

  it("counts working tree changes", async () => {
    await writeFile(join(repo, "a.txt"), "changed\n");
    await writeFile(join(repo, "new.txt"), "new\n");
    const overview = await harness.experimental_call("overview", { repoPath: repo, recentLimit: 8 });
    expect(overview.workingTree).toEqual({ staged: 0, unstaged: 1, untracked: 1, conflicted: 0 });
    await git(repo, "checkout", "--", "a.txt");
    await rm(join(repo, "new.txt"));
  });
});

describe("checkout", () => {
  it("creates a tracking branch from a remote-only branch", async () => {
    const result = await harness.experimental_call("checkout", {
      repoPath: repo,
      target: { kind: "remote", remote: "origin", branch: "feature" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("Switched to feature (tracking origin/feature).");
    expect(result.overview.head).toMatchObject({ kind: "branch", name: "feature" });
    expect(result.overview.local.find((branch) => branch.name === "feature")).toMatchObject({ upstream: "origin/feature", isCurrent: true });
    expect(result.overview.recent).toEqual(["main"]);
  });

  it("switches to a local branch and records it as recent", async () => {
    const result = await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("Switched to main.");
    expect(result.overview.recent).toEqual(["feature"]);
  });

  it("uses the existing local branch when a remote branch has one", async () => {
    const result = await harness.experimental_call("checkout", {
      repoPath: repo,
      target: { kind: "remote", remote: "origin", branch: "feature" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toMatch(/existing local branch feature/u);
    await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } });
  });

  it("reports unknown branches without running a checkout", async () => {
    const before = await git(repo, "reflog", "show", "-n", "1", "HEAD");
    const result = await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "nope" } });
    expect(result).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
    expect(await git(repo, "reflog", "show", "-n", "1", "HEAD")).toBe(before);
  });

  it("rejects invalid names at the contract boundary", async () => {
    for (const name of ["bad name", "-x", "a..b", "x.lock", "HEAD"]) {
      await expect(
        harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name } }),
      ).rejects.toThrow();
    }
  });

  it("refuses to run while the index is locked", async () => {
    const lock = join(repo, ".git", "index.lock");
    await writeFile(lock, "");
    try {
      const result = await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "feature" } });
      expect(result).toMatchObject({ ok: false, error: { code: "index_locked" } });
      if (!result.ok) expect(result.overview?.indexLocked).toBe(true);
    } finally {
      await rm(lock);
    }
  });

  it("tells a concurrent caller the repository is busy", async () => {
    const results = await Promise.all([
      harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "feature" } }),
      harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } }),
    ]);
    const busy = results.filter((result) => !result.ok && result.error.code === "busy");
    const ok = results.filter((result) => result.ok);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(busy.length + ok.length).toBe(2);
    await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } });
  });
});

describe("createBranch", () => {
  it("creates and switches", async () => {
    const result = await harness.experimental_call("createBranch", { repoPath: repo, name: "feat/click-test", startPoint: null, checkout: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("Created feat/click-test and switched to it.");
    expect(result.overview.head).toMatchObject({ kind: "branch", name: "feat/click-test" });
  });

  it("creates from a start point without switching", async () => {
    const result = await harness.experimental_call("createBranch", { repoPath: repo, name: "from-main", startPoint: "main", checkout: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("Created from-main from main.");
    expect(result.overview.head).toMatchObject({ kind: "branch", name: "feat/click-test" });
    expect(result.overview.local.map((branch) => branch.name)).toContain("from-main");
  });

  it("reports existing names and unknown start points", async () => {
    expect(await harness.experimental_call("createBranch", { repoPath: repo, name: "main", startPoint: null, checkout: false })).toMatchObject({
      ok: false,
      error: { code: "ref_exists" },
    });
    expect(await harness.experimental_call("createBranch", { repoPath: repo, name: "x", startPoint: "nope", checkout: false })).toMatchObject({
      ok: false,
      error: { code: "ref_not_found" },
    });
  });
});

describe("fetch, pull and push", () => {
  it("fetches and validates the remote name", async () => {
    const result = await harness.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: true });
    expect(result.ok).toBe(true);
    expect(await harness.experimental_call("fetch", { repoPath: repo, remote: "nope", prune: false })).toMatchObject({
      ok: false,
      error: { code: "no_remote" },
    });
  });

  it("reports a missing upstream on pull", async () => {
    const result = await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
    expect(result).toMatchObject({ ok: false, error: { code: "no_upstream" } });
  });

  it("pushes a new branch and sets its upstream", async () => {
    const result = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("Pushed feat/click-test to origin/feat/click-test and set it as upstream.");
    expect(result.overview.upstream?.name).toBe("origin/feat/click-test");
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toContain("feat/click-test");
    const again = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false });
    expect(again).toMatchObject({ ok: true, message: "feat/click-test is already up to date on origin/feat/click-test." });
  });

  it("fast-forwards main after an upstream commit", async () => {
    await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } });
    await commit(other, "c.txt", "c\n", "third");
    await git(other, "push", "-q", "origin", "main");
    const result = await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toMatch(/Update Project/u);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(await git(other, "rev-parse", "HEAD"));
  });

  it("reports divergence under ff-only", async () => {
    await commit(repo, "local.txt", "local\n", "local work");
    await commit(other, "d.txt", "d\n", "fourth");
    await git(other, "push", "-q", "origin", "main");
    const result = await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
    expect(result).toMatchObject({ ok: false, error: { code: "non_fast_forward" } });
    if (!result.ok) expect(result.error.hint).toMatch(/rebase or merge/u);
    expect(result.ok ? null : result.overview?.upstream).toMatchObject({ ahead: 1, behind: 1 });
  });

  it("refuses pull and push on a detached HEAD", async () => {
    await git(repo, "checkout", "-q", "--detach");
    const overview = await harness.experimental_call("overview", { repoPath: repo, recentLimit: 8 });
    expect(overview.head?.kind).toBe("detached");
    expect(await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false })).toMatchObject({
      ok: false,
      error: { code: "detached_head" },
    });
    expect(await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false })).toMatchObject({
      ok: false,
      error: { code: "detached_head" },
    });
    await git(repo, "switch", "-q", "main");
  });
});
