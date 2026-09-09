import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionResult, BranchRef, JobStart, Overview } from "./contracts";
import hostEntry from "./host";
import { waitForJob } from "./host/jobs";
import { tryWithRepoLock } from "./host/locks";

const exec = promisify(execFile);

// The test's own git: a fixed identity and no user config.
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

/** Asserts success and that the host had time to read the repository afterwards. */
function okOverview(result: ActionResult): Overview {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.overview).not.toBeNull();
  return result.overview as Overview;
}

type JobMethod = "fetch" | "pull" | "push" | "updateBranch" | "deleteRemoteBranch";
type JobInput<M extends JobMethod> = Omit<Parameters<typeof harness.experimental_call<M>>[1], "timeoutMs"> & { timeoutMs?: number };

/** Starts a job and waits for its final result, the way the app does through signals. */
async function runJob<M extends JobMethod>(method: M, input: JobInput<M>): Promise<ActionResult> {
  const start = (await harness.experimental_call(method, { timeoutMs: 60_000, ...input } as never)) as JobStart;
  if (!start.ok) return { ok: false, error: start.error, overview: start.overview };
  await waitForJob(start.jobId);
  const state = await harness.experimental_call("jobGet", { repoPath: (input as { repoPath: string }).repoPath, jobId: start.jobId });
  if (state === null || state.result === null) throw new Error(`job ${start.jobId} left no result`);
  return state.result;
}

const local = (name: string): BranchRef => ({ kind: "local", name });
const remote = (branch: string, remoteName = "origin"): BranchRef => ({ kind: "remote", remote: remoteName, branch });

let root: string;
let repo: string;
let bare: string;
let other: string;
const savedEnv = { ...process.env };
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

  // The plugin's git (host/git.ts spreads process.env) must not depend on the
  // developer's dotfiles. push.default=nothing proves every push names its
  // refspec; a hooks path proves no user hook runs.
  await writeFile(
    join(root, "gitconfig"),
    "[push]\n\tdefault = nothing\n[core]\n\thooksPath = /nonexistent-hooks\n[user]\n\tname = VCS Test\n\temail = vcs@example.com\n",
  );
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";
}, 60_000);

afterAll(async () => {
  await harness.experimental_dispose();
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "PATH", "VCS_GROUP_BUDGET_MS"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
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
    expect(overview.upstream).toEqual({ name: "origin/main", remote: "origin", branch: "main", ahead: 0, behind: 0, gone: false });
    expect(overview.operation).toBe("none");
    expect(overview.indexLocked).toBe(false);
    expect(overview.workingTree).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(overview.gitVersion).toMatch(/^\d+\.\d+/u);
  });

  it("reports a non-repository, a bare repository and a missing path as unavailable", async () => {
    const notRepo = await harness.experimental_call("overview", { repoPath: root, recentLimit: 8 });
    expect(notRepo.unavailableReason).toMatch(/git/iu);
    expect(notRepo.local).toEqual([]);
    const bareRepo = await harness.experimental_call("overview", { repoPath: bare, recentLimit: 8 });
    expect(bareRepo.unavailableReason).toMatch(/work tree/iu);
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

  it("still lists recent branches when a file called HEAD exists", async () => {
    await writeFile(join(repo, "HEAD"), "not a ref\n");
    try {
      await git(repo, "switch", "-q", "-c", "scratch");
      await git(repo, "switch", "-q", "main");
      const overview = await harness.experimental_call("overview", { repoPath: repo, recentLimit: 8 });
      expect(overview.recent).toEqual(["scratch"]);
    } finally {
      await rm(join(repo, "HEAD"));
      await git(repo, "branch", "-q", "-D", "scratch");
    }
  });
});

describe("checkout", () => {
  it("creates a tracking branch from a remote-only branch", async () => {
    const result = await harness.experimental_call("checkout", {
      repoPath: repo,
      target: { kind: "remote", remote: "origin", branch: "feature" },
    });
    const overview = okOverview(result);
    expect(result.ok && result.message).toBe("Switched to feature (tracking origin/feature).");
    expect(overview.head).toMatchObject({ kind: "branch", name: "feature" });
    expect(overview.local.find((branch) => branch.name === "feature")).toMatchObject({ upstream: "origin/feature", isCurrent: true });
    expect(overview.recent).toEqual(["main"]);
  });

  it("switches to a local branch and records it as recent", async () => {
    const result = await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } });
    const overview = okOverview(result);
    expect(result.ok && result.message).toBe("Switched to main.");
    expect(overview.recent).toEqual(["feature"]);
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
    const before = await git(repo, "reflog", "show", "-n", "1", "HEAD", "--");
    const result = await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "nope" } });
    expect(result).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
    expect(await git(repo, "reflog", "show", "-n", "1", "HEAD", "--")).toBe(before);
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
    const key = resolve(repo, await git(repo, "rev-parse", "--git-common-dir"));
    let release: () => void = () => {};
    const holding = tryWithRepoLock(key, () => new Promise<void>((done) => { release = done; }));
    try {
      const result = await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "feature" } });
      expect(result).toMatchObject({ ok: false, error: { code: "busy" } });
      expect(await git(repo, "branch", "--show-current")).toBe("main");
    } finally {
      release();
      await holding;
    }
  });
});

describe("createBranch", () => {
  it("creates and switches", async () => {
    const result = await harness.experimental_call("createBranch", { repoPath: repo, name: "feat/click-test", startPoint: null, checkout: true });
    const overview = okOverview(result);
    expect(result.ok && result.message).toBe("Created feat/click-test and switched to it.");
    expect(overview.head).toMatchObject({ kind: "branch", name: "feat/click-test" });
  });

  it("creates from a start point without switching", async () => {
    const result = await harness.experimental_call("createBranch", { repoPath: repo, name: "from-main", startPoint: "main", checkout: false });
    const overview = okOverview(result);
    expect(result.ok && result.message).toBe("Created from-main from main.");
    expect(overview.head).toMatchObject({ kind: "branch", name: "feat/click-test" });
    expect(overview.local.map((branch) => branch.name)).toContain("from-main");
  });

  it("creates from a remote branch by its full ref and tracks it", async () => {
    // A tag named like the branch would make the short name ambiguous.
    await git(repo, "tag", "origin/feature");
    try {
      const result = await harness.experimental_call("createBranch", { repoPath: repo, name: "from-remote", startPoint: "origin/feature", checkout: false });
      const overview = okOverview(result);
      // While the tag exists git spells the upstream "remotes/origin/feature" to disambiguate.
      expect(overview.local.find((branch) => branch.name === "from-remote")?.upstream).toMatch(/^(?:remotes\/)?origin\/feature$/u);
    } finally {
      await git(repo, "tag", "-d", "origin/feature");
    }
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
    const result = await runJob("fetch", { repoPath: repo, remote: "origin", prune: true });
    expect(result.ok).toBe(true);
    expect(await runJob("fetch", { repoPath: repo, remote: "nope", prune: false })).toMatchObject({
      ok: false,
      error: { code: "no_remote" },
    });
  });

  it("reports a missing upstream on pull", async () => {
    const result = await runJob("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
    expect(result).toMatchObject({ ok: false, error: { code: "no_upstream" } });
  });

  it("refuses a tracked push when the branch has no upstream instead of inventing one", async () => {
    const result = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "feat/click-test" });
    expect(result).toMatchObject({ ok: false, error: { code: "no_upstream" } });
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).not.toContain("feat/click-test");
  });

  it("refuses to push when HEAD is not the branch the dialog named", async () => {
    const result = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: true, expectedBranch: "main" });
    expect(result).toMatchObject({ ok: false, error: { code: "head_changed" } });
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).not.toContain("feat/click-test");
  });

  it("pushes a new branch with -u, then pushes the tracked branch by explicit refspec", async () => {
    const result = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: true, expectedBranch: "feat/click-test" });
    const overview = okOverview(result);
    expect(result.ok && result.message).toBe("Pushed feat/click-test to origin/feat/click-test and set it as upstream.");
    expect(overview.upstream).toMatchObject({ name: "origin/feat/click-test", remote: "origin", branch: "feat/click-test", gone: false });
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toContain("feat/click-test");
    // push.default=nothing in the plugin's global config: only an explicit refspec can work.
    const again = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "feat/click-test" });
    expect(again).toMatchObject({ ok: true, message: "feat/click-test is already up to date on origin/feat/click-test." });
    await commit(repo, "pushed.txt", "p\n", "pushed work");
    const withWork = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "feat/click-test" });
    expect(withWork).toMatchObject({ ok: true, message: "Pushed feat/click-test to origin/feat/click-test." });
    expect(await git(bare, "rev-parse", "feat/click-test")).toBe(await git(repo, "rev-parse", "HEAD"));
  });

  it("pushes to an upstream named differently from the local branch", async () => {
    await git(repo, "switch", "-q", "-c", "localname");
    await git(repo, "push", "-q", "-u", "origin", "localname:othername");
    try {
      await commit(repo, "renamed.txt", "r\n", "renamed work");
      const result = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "localname" });
      expect(result).toMatchObject({ ok: true, message: "Pushed localname to origin/othername." });
      expect(await git(bare, "rev-parse", "othername")).toBe(await git(repo, "rev-parse", "HEAD"));
    } finally {
      await git(repo, "switch", "-q", "feat/click-test");
      await git(repo, "branch", "-q", "-D", "localname");
    }
  });

  it("reports a gone upstream and refuses the tracked push and the pull", async () => {
    await git(repo, "switch", "-q", "-c", "gone-br");
    await git(repo, "push", "-q", "-u", "origin", "gone-br");
    await git(repo, "push", "-q", "origin", "--delete", "gone-br");
    await git(repo, "fetch", "-q", "--prune", "origin");
    try {
      const overview = await harness.experimental_call("overview", { repoPath: repo, recentLimit: 8 });
      expect(overview.upstream).toMatchObject({ name: "origin/gone-br", gone: true });
      expect(await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "gone-br" })).toMatchObject({
        ok: false,
        error: { code: "no_upstream" },
      });
      expect(await runJob("pull", { repoPath: repo, strategy: "ff-only", autoStash: false })).toMatchObject({
        ok: false,
        error: { code: "no_upstream" },
      });
    } finally {
      await git(repo, "switch", "-q", "main");
      await git(repo, "branch", "-q", "-D", "gone-br");
    }
  });

  it("fast-forwards main after an upstream commit", async () => {
    await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } });
    await commit(other, "c.txt", "c\n", "third");
    await git(other, "push", "-q", "origin", "main");
    const result = await runJob("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("Update Project: Fast-forward.");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(await git(other, "rev-parse", "HEAD"));
  });

  it("reports a conflict when re-applying the autostash fails, although git exits 0", async () => {
    await commit(other, "c.txt", "upstream edit\n", "edit c upstream");
    await git(other, "push", "-q", "origin", "main");
    await writeFile(join(repo, "c.txt"), "local edit\n");
    try {
      const result = await runJob("pull", { repoPath: repo, strategy: "ff-only", autoStash: true });
      expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
      if (!result.ok) expect(result.overview?.workingTree.conflicted).toBe(1);
    } finally {
      await git(repo, "reset", "-q", "--hard", "HEAD");
      await git(repo, "stash", "drop", "-q");
    }
  });

  it("reports divergence under ff-only", async () => {
    await commit(repo, "local.txt", "local\n", "local work");
    await commit(other, "d.txt", "d\n", "fourth");
    await git(other, "push", "-q", "origin", "main");
    const result = await runJob("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
    expect(result).toMatchObject({ ok: false, error: { code: "non_fast_forward" } });
    if (!result.ok) expect(result.error.hint).toMatch(/rebase or merge/u);
    expect(result.ok ? null : result.overview?.upstream).toMatchObject({ ahead: 1, behind: 1 });
  });

  it("names the rejection reason, not the remote URL, on a rejected push", async () => {
    const result = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "main" });
    expect(result).toMatchObject({ ok: false, error: { code: "non_fast_forward" } });
    if (!result.ok) expect(result.error.message).toMatch(/\[rejected\]/u);
  });

  it("refuses pull and push on a detached HEAD", async () => {
    await git(repo, "checkout", "-q", "--detach");
    const overview = await harness.experimental_call("overview", { repoPath: repo, recentLimit: 8 });
    expect(overview.head?.kind).toBe("detached");
    expect(await runJob("pull", { repoPath: repo, strategy: "ff-only", autoStash: false })).toMatchObject({
      ok: false,
      error: { code: "detached_head" },
    });
    expect(await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "main" })).toMatchObject({
      ok: false,
      error: { code: "detached_head" },
    });
    await git(repo, "switch", "-q", "main");
  });
});

describe("branch management", () => {
  beforeAll(async () => {
    await git(repo, "switch", "-q", "main");
    await git(repo, "reset", "-q", "--hard", "origin/main");
  });

  it("renames a branch and refuses a taken name", async () => {
    const result = await harness.experimental_call("renameBranch", { repoPath: repo, from: "from-main", to: "renamed-main" });
    expect(result).toMatchObject({ ok: true, message: "Renamed from-main to renamed-main." });
    expect(await harness.experimental_call("renameBranch", { repoPath: repo, from: "renamed-main", to: "feature" })).toMatchObject({ ok: false, error: { code: "ref_exists" } });
    expect(await harness.experimental_call("renameBranch", { repoPath: repo, from: "nope", to: "x" })).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
  });

  it("deletes a merged branch with -d and needs -D for an unmerged one", async () => {
    await git(repo, "branch", "merged", "main");
    expect(await harness.experimental_call("deleteBranch", { repoPath: repo, name: "merged", force: false })).toMatchObject({ ok: true, message: "Deleted merged." });
    await git(repo, "switch", "-q", "-c", "unmerged");
    await commit(repo, "u.txt", "u\n", "unmerged work");
    await git(repo, "switch", "-q", "main");
    const soft = await harness.experimental_call("deleteBranch", { repoPath: repo, name: "unmerged", force: false });
    expect(soft).toMatchObject({ ok: false, error: { code: "not_fully_merged" } });
    if (!soft.ok) expect(soft.overview?.local.map((branch) => branch.name)).toContain("unmerged");
    expect(await harness.experimental_call("deleteBranch", { repoPath: repo, name: "unmerged", force: true })).toMatchObject({ ok: true });
    expect(await git(repo, "branch", "--list", "unmerged")).toBe("");
  });

  it("refuses to delete the current branch or one checked out in another worktree", async () => {
    expect(await harness.experimental_call("deleteBranch", { repoPath: repo, name: "main", force: true })).toMatchObject({ ok: false, error: { code: "busy" } });
    const wt = join(root, "wt-feature");
    await git(repo, "worktree", "add", "-q", wt, "feature");
    try {
      const result = await harness.experimental_call("deleteBranch", { repoPath: repo, name: "feature", force: true });
      expect(result).toMatchObject({ ok: false, error: { code: "path_exists" } });
      if (!result.ok) expect(result.error.message).toContain(wt);
    } finally {
      await git(repo, "worktree", "remove", "--force", wt);
    }
  });

  it("sets and unsets the tracked branch", async () => {
    expect(await harness.experimental_call("setUpstream", { repoPath: repo, branch: "renamed-main", upstream: { remote: "origin", branch: "feature" } })).toMatchObject({ ok: true, message: "renamed-main now tracks origin/feature." });
    expect(await git(repo, "rev-parse", "--abbrev-ref", "renamed-main@{upstream}")).toBe("origin/feature");
    expect(await harness.experimental_call("setUpstream", { repoPath: repo, branch: "renamed-main", upstream: null })).toMatchObject({ ok: true, message: "renamed-main no longer tracks a branch." });
    expect(await harness.experimental_call("setUpstream", { repoPath: repo, branch: "renamed-main", upstream: null })).toMatchObject({ ok: true, message: "renamed-main tracks no branch." });
    expect(await harness.experimental_call("setUpstream", { repoPath: repo, branch: "renamed-main", upstream: { remote: "origin", branch: "nope" } })).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
  });

  it("adds a worktree in a sibling directory from a local and from a remote branch", async () => {
    const path = join(root, "repo-renamed-main");
    const result = await harness.experimental_call("addWorktree", { repoPath: repo, ref: local("renamed-main"), path });
    expect(result).toMatchObject({ ok: true, message: `Added worktree ${path} on renamed-main.` });
    if (result.ok) expect(result.overview?.local.find((branch) => branch.name === "renamed-main")?.worktreePath).toBe(path);
    expect(await harness.experimental_call("addWorktree", { repoPath: repo, ref: local("main"), path })).toMatchObject({ ok: false, error: { code: "path_exists" } });
    expect(await harness.experimental_call("addWorktree", { repoPath: repo, ref: local("main"), path: join(root, "deeper", "x") })).toMatchObject({ ok: false, error: { code: "git_failed" } });
    expect(await harness.experimental_call("addWorktree", { repoPath: repo, ref: local("renamed-main"), path: join(root, "again") })).toMatchObject({ ok: false, error: { code: "path_exists" } });
    await git(other, "switch", "-q", "-c", "wt-remote");
    await commit(other, "wt.txt", "wt\n", "remote work");
    await git(other, "push", "-q", "origin", "wt-remote");
    await git(repo, "fetch", "-q", "origin");
    const remotePath = join(root, "repo-wt-remote");
    const fromRemote = await harness.experimental_call("addWorktree", { repoPath: repo, ref: remote("wt-remote"), path: remotePath });
    expect(fromRemote).toMatchObject({ ok: true });
    expect(await git(remotePath, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/wt-remote");
    expect(await harness.experimental_call("addWorktree", { repoPath: repo, ref: remote("wt-remote"), path: join(root, "repo-x") })).toMatchObject({ ok: false, error: { code: "ref_exists" } });
    await git(repo, "worktree", "remove", "--force", path);
    await git(repo, "worktree", "remove", "--force", remotePath);
    await git(repo, "branch", "-q", "-D", "wt-remote");
  });

  it("checks out a tag or revision as a detached HEAD and lists tags", async () => {
    await git(repo, "tag", "-a", "v1", "-m", "release one");
    const tags = await harness.experimental_call("listTags", { repoPath: repo });
    expect(tags).toMatchObject({ ok: true, truncated: false });
    if (tags.ok) expect(tags.tags.map((tag) => tag.name)).toEqual(["v1"]);
    const result = await harness.experimental_call("checkoutRevision", { repoPath: repo, revision: "v1" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.message).toMatch(/^Checked out v1 \(detached HEAD at [0-9a-f]{7}\)\.$/u);
      expect(result.overview?.head?.kind).toBe("detached");
    }
    expect(await harness.experimental_call("checkoutRevision", { repoPath: repo, revision: "nope" })).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
    await expect(harness.experimental_call("checkoutRevision", { repoPath: repo, revision: "-x" })).rejects.toThrow();
    await git(repo, "switch", "-q", "main");
  });
});

describe("merge, rebase and abort", () => {
  it("merges fast-forward, reports a conflict and aborts it", async () => {
    await git(repo, "switch", "-q", "-c", "topic");
    await commit(repo, "t.txt", "t\n", "topic work");
    await git(repo, "switch", "-q", "main");
    const ff = await harness.experimental_call("merge", { repoPath: repo, ref: local("topic") });
    expect(ff).toMatchObject({ ok: true, message: "Merged topic into main: Fast-forward." });
    await git(repo, "switch", "-q", "-c", "conflict-a");
    await commit(repo, "a.txt", "A\n", "a on branch");
    await git(repo, "switch", "-q", "main");
    await commit(repo, "a.txt", "B\n", "a on main");
    const clash = await harness.experimental_call("merge", { repoPath: repo, ref: local("conflict-a") });
    expect(clash).toMatchObject({ ok: false, error: { code: "conflict" } });
    if (!clash.ok) {
      expect(clash.overview?.operation).toBe("merge");
      expect(clash.overview?.workingTree.conflicted).toBe(1);
    }
    expect(await harness.experimental_call("checkout", { repoPath: repo, target: local("topic") })).toMatchObject({ ok: false, error: { code: "operation_in_progress" } });
    const aborted = await harness.experimental_call("abortOperation", { repoPath: repo });
    expect(aborted).toMatchObject({ ok: true, message: "Aborted the merge." });
    if (aborted.ok) expect(aborted.overview?.operation).toBe("none");
    expect(await harness.experimental_call("abortOperation", { repoPath: repo })).toMatchObject({ ok: false, error: { code: "git_failed" } });
    expect(await harness.experimental_call("merge", { repoPath: repo, ref: local("nope") })).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
  });

  it("rebases the current branch, or checks out first when asked", async () => {
    await git(repo, "branch", "rb", "main~1");
    await git(repo, "switch", "-q", "rb");
    await commit(repo, "r.txt", "r\n", "rb work");
    await git(repo, "switch", "-q", "main");
    const before = await git(repo, "rev-parse", "rb");
    const result = await harness.experimental_call("rebase", { repoPath: repo, onto: local("rb"), checkoutFirst: null });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.message).toMatch(/^Rebased main onto rb/u);
    expect(await git(repo, "merge-base", "main", "rb")).toBe(before);
    const switched = await harness.experimental_call("rebase", { repoPath: repo, onto: local("main"), checkoutFirst: local("topic") });
    expect(switched).toMatchObject({ ok: true });
    if (switched.ok) {
      expect(switched.message).toMatch(/^Rebased topic onto main|^topic is already up to date with main\.$/u);
      expect(switched.overview?.head).toMatchObject({ kind: "branch", name: "topic" });
    }
    expect(await git(repo, "merge-base", "--is-ancestor", "main", "topic").then(() => true, () => false)).toBe(true);
    const fromRemote = await harness.experimental_call("rebase", { repoPath: repo, onto: remote("main"), checkoutFirst: null });
    expect(fromRemote).toMatchObject({ ok: true });
    await git(repo, "switch", "-q", "main");
  });
});

describe("jobs", () => {
  it("runs fetch as a job that reports through signals and releases its lease", async () => {
    const before = harness.experimental_getSignals().length;
    const start = await harness.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: true, timeoutMs: 30_000 });
    expect(start).toMatchObject({ ok: true, kind: "fetch", command: "git fetch --no-progress --prune --end-of-options origin" });
    if (!start.ok) return;
    await waitForJob(start.jobId);
    const state = await harness.experimental_call("jobGet", { repoPath: repo, jobId: start.jobId });
    expect(state).toMatchObject({ jobId: start.jobId, kind: "fetch", status: "finished", result: { ok: true } });
    expect(state?.finishedAt).not.toBeNull();
    const events = harness.experimental_getSignals().slice(before).filter((signal) => signal.signal === "jobEvent");
    expect(events[0]?.payload).toMatchObject({ jobId: start.jobId, repoRoot: repo, event: { kind: "started" } });
    const last = events.at(-1)?.payload;
    expect(last && "event" in last ? last.event : null).toMatchObject({ kind: "finished", result: { ok: true } });
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    expect(await harness.experimental_call("jobGet", { repoPath: repo, jobId: "nope" })).toBeNull();
    expect(await harness.experimental_call("jobCancel", { repoPath: repo, jobId: "nope" })).toEqual({ cancelled: false });
  });

  it("pushes another local branch by its own ref and refuses when it moved", async () => {
    await git(repo, "switch", "-q", "main");
    await git(repo, "branch", "side", "main");
    const sha = (await git(repo, "rev-parse", "side")).slice(0, 7);
    const result = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: true, expectedBranch: "side", source: "branch", expectedSha: sha });
    expect(result).toMatchObject({ ok: true, message: "Pushed side to origin/side and set it as upstream." });
    expect(await git(bare, "rev-parse", "side")).toBe(await git(repo, "rev-parse", "side"));
    expect(await git(repo, "branch", "--show-current")).toBe("main");
    expect(await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "side", source: "branch", expectedSha: "0000000" })).toMatchObject({ ok: false, error: { code: "head_changed" } });
    expect(await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "nope", source: "branch" })).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
  });

  it("force-pushes only with a lease on the remote sha the dialog saw", async () => {
    await git(repo, "switch", "-q", "side");
    await commit(repo, "s1.txt", "1\n", "side one");
    await git(repo, "push", "-q", "origin", "side");
    await git(repo, "reset", "-q", "--hard", "HEAD~1");
    await commit(repo, "s2.txt", "2\n", "side two");
    expect(await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "side" })).toMatchObject({ ok: false, error: { code: "non_fast_forward" } });
    const remoteSha = (await git(repo, "rev-parse", "origin/side")).slice(0, 7);
    expect(await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "side", lease: "0000000" })).toMatchObject({ ok: false, error: { code: "head_changed" } });
    const forced = await runJob("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "side", lease: remoteSha });
    expect(forced).toMatchObject({ ok: true, message: "Force-pushed side to origin/side (with lease)." });
    expect(await git(bare, "rev-parse", "side")).toBe(await git(repo, "rev-parse", "side"));
    await git(repo, "switch", "-q", "main");
  });

  it("updates a branch that is not checked out by fast-forward only", async () => {
    await git(other, "fetch", "-q", "origin");
    await git(other, "switch", "-q", "-c", "side", "origin/side");
    await commit(other, "s3.txt", "3\n", "side three");
    await git(other, "push", "-q", "origin", "side");
    expect(await runJob("updateBranch", { repoPath: repo, branch: "side" })).toMatchObject({ ok: true, message: "Updated side from origin/side." });
    expect(await git(repo, "rev-parse", "side")).toBe(await git(other, "rev-parse", "side"));
    expect(await runJob("updateBranch", { repoPath: repo, branch: "side" })).toMatchObject({ ok: true, message: "side is already up to date with origin/side." });
    expect(await runJob("updateBranch", { repoPath: repo, branch: "main" })).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(await runJob("updateBranch", { repoPath: repo, branch: "topic" })).toMatchObject({ ok: false, error: { code: "no_upstream" } });
    await git(repo, "switch", "-q", "side");
    await commit(repo, "s4.txt", "4\n", "side four local");
    await git(repo, "switch", "-q", "main");
    await commit(other, "s5.txt", "5\n", "side five remote");
    await git(other, "push", "-q", "origin", "side");
    expect(await runJob("updateBranch", { repoPath: repo, branch: "side" })).toMatchObject({ ok: false, error: { code: "non_fast_forward" } });
  });

  it("deletes a remote branch as a job", async () => {
    expect(await runJob("deleteRemoteBranch", { repoPath: repo, remote: "origin", branch: "side" })).toMatchObject({ ok: true, message: "Deleted origin/side on the remote." });
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).not.toContain("side");
    expect(await runJob("deleteRemoteBranch", { repoPath: repo, remote: "origin", branch: "side" })).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
    expect(await runJob("deleteRemoteBranch", { repoPath: repo, remote: "nope", branch: "side" })).toMatchObject({ ok: false, error: { code: "no_remote" } });
  });
});

describe("compare and diff", () => {
  it("lists commits on either side and the changed files, with per-file patches", async () => {
    await git(repo, "switch", "-q", "-c", "cmp");
    await commit(repo, "cmp.txt", "cmp\n", "cmp work");
    await git(repo, "switch", "-q", "main");
    await commit(repo, "m2.txt", "m2\n", "main two");
    const result = await harness.experimental_call("compare", { repoPath: repo, base: local("main"), target: local("cmp") });
    expect(result).toMatchObject({ ok: true, base: "main", target: "cmp", aheadCount: 1, behindCount: 1 });
    if (!result.ok) return;
    expect(result.ahead.map((commit) => commit.subject)).toEqual(["cmp work"]);
    expect(result.behind.map((commit) => commit.subject)).toEqual(["main two"]);
    expect(result.ahead[0]).toMatchObject({ author: "VCS Test" });
    expect(result.files).toEqual([{ path: "cmp.txt", oldPath: null, additions: 1, deletions: 0, binary: false }]);
    const patch = await harness.experimental_call("comparePatch", { repoPath: repo, base: local("main"), target: local("cmp"), path: "cmp.txt" });
    expect(patch).toMatchObject({ ok: true, path: "cmp.txt", truncated: false, binary: false });
    if (patch.ok) expect(patch.patch).toContain("+cmp");
    const withRemote = await harness.experimental_call("compare", { repoPath: repo, base: local("main"), target: remote("main") });
    expect(withRemote).toMatchObject({ ok: true, target: "origin/main" });
    expect(await harness.experimental_call("compare", { repoPath: repo, base: local("main"), target: local("nope") })).toMatchObject({ ok: false, error: { code: "ref_not_found" } });
    await expect(harness.experimental_call("comparePatch", { repoPath: repo, base: local("main"), target: local("cmp"), path: "../etc/passwd" })).rejects.toThrow();
  });

  it("diffs the working tree against a branch", async () => {
    await writeFile(join(repo, "a.txt"), "working\n");
    try {
      const result = await harness.experimental_call("diffWorkingTree", { repoPath: repo, ref: local("main") });
      expect(result).toMatchObject({ ok: true, ref: "main", truncated: false });
      if (result.ok) expect(result.files.map((file) => file.path)).toEqual(["a.txt"]);
      const patch = await harness.experimental_call("diffWorkingTreePatch", { repoPath: repo, ref: local("main"), path: "a.txt" });
      if (patch.ok) expect(patch.patch).toContain("+working");
      const other = await harness.experimental_call("diffWorkingTree", { repoPath: repo, ref: local("cmp") });
      if (other.ok) expect(other.files.map((file) => file.path).sort()).toEqual(["a.txt", "cmp.txt", "m2.txt"]);
    } finally {
      await git(repo, "checkout", "--", "a.txt");
    }
  });
});

describe("watch", () => {
  it("registers one watch per git dir on the first overview and signals relevant changes", async () => {
    type Listener = (event: { kind: "changed"; changes: { path: string; type: "create" | "update" | "delete" }[] } | { kind: "rescan-required" } | { kind: "watch-error"; message: string }) => void | Promise<void>;
    const registered: { rootPath: string; ignoredPaths?: readonly string[] }[] = [];
    let listener: Listener | null = null;
    let disposed = 0;
    const own = experimental_createHostEntryHarness(hostEntry, {
      experimental_watch: async (options, next) => {
        registered.push(options);
        listener = next as Listener;
        return { dispose: async () => { disposed += 1; } };
      },
    });
    try {
      await own.experimental_call("overview", { repoPath: other, recentLimit: 8 });
      await new Promise((done) => setTimeout(done, 50));
      expect(registered).toHaveLength(1);
      expect(registered[0]?.rootPath).toBe(resolve(other, ".git"));
      expect(registered[0]?.ignoredPaths).toContain("objects");
      await own.experimental_call("overview", { repoPath: other, recentLimit: 8 });
      expect(registered).toHaveLength(1);
      expect(listener).not.toBeNull();
      const gitDir = resolve(other, ".git");
      await listener!({ kind: "changed", changes: [{ path: join(gitDir, "objects", "ab", "cdef"), type: "create" }, { path: join(gitDir, "objects", "pack", "x.pack"), type: "create" }] });
      expect(own.experimental_getSignals().filter((signal) => signal.signal === "changed")).toEqual([]);
      await listener!({ kind: "changed", changes: [{ path: join(gitDir, "HEAD"), type: "update" }] });
      await listener!({ kind: "rescan-required" });
      expect(own.experimental_getSignals().filter((signal) => signal.signal === "changed").map((signal) => signal.payload)).toEqual([
        { repoRoot: other, reason: "watch" },
        { repoRoot: other, reason: "watch:rescan" },
      ]);
    } finally {
      await own.experimental_dispose();
    }
    expect(disposed).toBe(1);
  });
});

// A git shim that hangs on `fetch` and spawns a grandchild, so the deadline,
// cancellation and process-group kill can be observed in seconds.
describe.skipIf(process.platform === "win32")("job deadlines and cancellation", () => {
  const MARKER = "31.415";
  let binDir: string;
  const survivors = async () => {
    try {
      const { stdout } = await exec("pgrep", ["-f", `sleep ${MARKER}`]);
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const settle = () => new Promise((done) => setTimeout(done, 400));

  beforeAll(async () => {
    const { stdout } = await exec("sh", ["-c", "command -v git"]);
    binDir = join(root, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "git"),
      `#!/bin/sh\nif [ "$1" = "fetch" ]; then echo "shim: fetching" >&2; sleep ${MARKER} & exec sleep ${MARKER}; fi\nexec ${stdout.trim()} "$@"\n`,
    );
    await chmod(join(binDir, "git"), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  });

  afterAll(async () => {
    process.env.PATH = savedEnv.PATH ?? "";
    await exec("pkill", ["-f", `sleep ${MARKER}`]).catch(() => undefined);
  });

  it("turns a hung job into a typed timeout and kills its children", async () => {
    const started = Date.now();
    const start = await harness.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: false, timeoutMs: 1_500 });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitForJob(start.jobId);
    const state = await harness.experimental_call("jobGet", { repoPath: repo, jobId: start.jobId });
    expect(state?.status).toBe("finished");
    expect(state?.result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(state?.output).toContain("shim: fetching");
    await settle();
    expect(await survivors()).toEqual([]);
  });

  it("tells a concurrent caller the repository is busy while a job runs, then cancels it", async () => {
    const start = await harness.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: false, timeoutMs: 30_000 });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    const blocked = await harness.experimental_call("checkout", { repoPath: repo, target: { kind: "local", name: "main" } });
    expect(blocked).toMatchObject({ ok: false, error: { code: "busy" } });
    if (!blocked.ok) expect(blocked.overview?.activeJob).toMatchObject({ jobId: start.jobId, kind: "fetch" });
    const blockedJob = await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false, timeoutMs: 30_000 });
    expect(blockedJob).toMatchObject({ ok: false, error: { code: "busy" } });
    const running = await harness.experimental_call("jobGet", { repoPath: repo, jobId: start.jobId });
    expect(running).toMatchObject({ status: "running", result: null, kind: "fetch" });
    expect(await harness.experimental_call("jobCancel", { repoPath: repo, jobId: start.jobId })).toEqual({ cancelled: true });
    await waitForJob(start.jobId);
    const state = await harness.experimental_call("jobGet", { repoPath: repo, jobId: start.jobId });
    expect(state?.result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(state?.result && !state.result.ok ? state.result.overview?.activeJob : "x").toBeNull();
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    expect(await harness.experimental_call("jobCancel", { repoPath: repo, jobId: start.jobId })).toEqual({ cancelled: false });
    await settle();
    expect(await survivors()).toEqual([]);
    const kinds = harness
      .experimental_getSignals()
      .map((signal) => signal.payload)
      .filter((payload): payload is Extract<typeof payload, { jobId: string }> => "jobId" in payload && payload.jobId === start.jobId)
      .map((payload) => payload.event.kind);
    expect(kinds).toEqual(["started", "output", "finished"]);
  });

  it("cancels running jobs when the entry is disposed", async () => {
    const own = experimental_createHostEntryHarness(hostEntry);
    const start = await own.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: false, timeoutMs: 30_000 });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await own.experimental_dispose();
    await waitForJob(start.jobId);
    await settle();
    expect(await survivors()).toEqual([]);
  });
});
