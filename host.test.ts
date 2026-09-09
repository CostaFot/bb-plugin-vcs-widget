import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionResult, Overview } from "./contracts";
import hostEntry from "./host";
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
  await writeFile(join(root, "gitconfig"), "[push]\n\tdefault = nothing\n[core]\n\thooksPath = /nonexistent-hooks\n");
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

  it("refuses a tracked push when the branch has no upstream instead of inventing one", async () => {
    const result = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "feat/click-test" });
    expect(result).toMatchObject({ ok: false, error: { code: "no_upstream" } });
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).not.toContain("feat/click-test");
  });

  it("refuses to push when HEAD is not the branch the dialog named", async () => {
    const result = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: true, expectedBranch: "main" });
    expect(result).toMatchObject({ ok: false, error: { code: "head_changed" } });
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).not.toContain("feat/click-test");
  });

  it("pushes a new branch with -u, then pushes the tracked branch by explicit refspec", async () => {
    const result = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: true, expectedBranch: "feat/click-test" });
    const overview = okOverview(result);
    expect(result.ok && result.message).toBe("Pushed feat/click-test to origin/feat/click-test and set it as upstream.");
    expect(overview.upstream).toMatchObject({ name: "origin/feat/click-test", remote: "origin", branch: "feat/click-test", gone: false });
    expect(await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toContain("feat/click-test");
    // push.default=nothing in the plugin's global config: only an explicit refspec can work.
    const again = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "feat/click-test" });
    expect(again).toMatchObject({ ok: true, message: "feat/click-test is already up to date on origin/feat/click-test." });
    await commit(repo, "pushed.txt", "p\n", "pushed work");
    const withWork = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "feat/click-test" });
    expect(withWork).toMatchObject({ ok: true, message: "Pushed feat/click-test to origin/feat/click-test." });
    expect(await git(bare, "rev-parse", "feat/click-test")).toBe(await git(repo, "rev-parse", "HEAD"));
  });

  it("pushes to an upstream named differently from the local branch", async () => {
    await git(repo, "switch", "-q", "-c", "localname");
    await git(repo, "push", "-q", "-u", "origin", "localname:othername");
    try {
      await commit(repo, "renamed.txt", "r\n", "renamed work");
      const result = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "localname" });
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
      expect(await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "gone-br" })).toMatchObject({
        ok: false,
        error: { code: "no_upstream" },
      });
      expect(await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false })).toMatchObject({
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
    const result = await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
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
      const result = await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: true });
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
    const result = await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false });
    expect(result).toMatchObject({ ok: false, error: { code: "non_fast_forward" } });
    if (!result.ok) expect(result.error.hint).toMatch(/rebase or merge/u);
    expect(result.ok ? null : result.overview?.upstream).toMatchObject({ ahead: 1, behind: 1 });
  });

  it("names the rejection reason, not the remote URL, on a rejected push", async () => {
    const result = await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "main" });
    expect(result).toMatchObject({ ok: false, error: { code: "non_fast_forward" } });
    if (!result.ok) expect(result.error.message).toMatch(/\[rejected\]/u);
  });

  it("refuses pull and push on a detached HEAD", async () => {
    await git(repo, "checkout", "-q", "--detach");
    const overview = await harness.experimental_call("overview", { repoPath: repo, recentLimit: 8 });
    expect(overview.head?.kind).toBe("detached");
    expect(await harness.experimental_call("pull", { repoPath: repo, strategy: "ff-only", autoStash: false })).toMatchObject({
      ok: false,
      error: { code: "detached_head" },
    });
    expect(await harness.experimental_call("push", { repoPath: repo, remote: "origin", setUpstream: false, expectedBranch: "main" })).toMatchObject({
      ok: false,
      error: { code: "detached_head" },
    });
    await git(repo, "switch", "-q", "main");
  });
});

// A git shim that hangs on `fetch` and spawns a grandchild, so the deadline,
// cancellation and process-group kill can be observed in seconds.
describe.skipIf(process.platform === "win32")("deadlines", () => {
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
      `#!/bin/sh\nif [ "$1" = "fetch" ]; then sleep ${MARKER} & exec sleep ${MARKER}; fi\nexec ${stdout.trim()} "$@"\n`,
    );
    await chmod(join(binDir, "git"), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  });

  afterAll(async () => {
    process.env.PATH = savedEnv.PATH ?? "";
    delete process.env.VCS_GROUP_BUDGET_MS;
    await exec("pkill", ["-f", `sleep ${MARKER}`]).catch(() => undefined);
  });

  it("turns a hung network command into a typed timeout inside the budget and kills its children", async () => {
    process.env.VCS_GROUP_BUDGET_MS = "1500";
    try {
      const started = Date.now();
      const result = await harness.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: false });
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
      if (!result.ok) expect(result.error.message).toMatch(/Fetch took longer than/u);
      await settle();
      expect(await survivors()).toEqual([]);
    } finally {
      delete process.env.VCS_GROUP_BUDGET_MS;
    }
  });

  it("reports a cancelled call and stops git's whole process group", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const result = await harness.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: false }, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    await settle();
    expect(await survivors()).toEqual([]);
  });

  it("cancels in-flight calls when the entry is disposed", async () => {
    const own = experimental_createHostEntryHarness(hostEntry);
    const pending = own.experimental_call("fetch", { repoPath: repo, remote: "origin", prune: false });
    setTimeout(() => void own.experimental_dispose(), 500);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    await settle();
    expect(await survivors()).toEqual([]);
  });
});
