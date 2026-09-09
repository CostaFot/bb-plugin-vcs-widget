import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBudget, DEADLINES_MS } from "./budget";
import { runGit } from "./git";

const exec = promisify(execFile);

describe("createBudget", () => {
  it("cuts deadlines down to what is left and keeps the overview reserve", () => {
    let now = 0;
    const budget = createBudget(27_000, () => now);
    expect(budget.deadlineFor("read")).toBe(DEADLINES_MS.read);
    expect(budget.deadlineFor("network")).toBe(DEADLINES_MS.network);
    now = 20_000;
    expect(budget.remaining()).toBe(7_000);
    expect(budget.deadlineFor("read")).toBe(7_000);
    expect(budget.deadlineFor("network")).toBe(3_000);
    expect(budget.deadlineFor("mutate")).toBe(3_000);
    now = 26_000;
    expect(budget.deadlineFor("network")).toBe(0);
    now = 40_000;
    expect(budget.remaining()).toBe(0);
    expect(budget.deadlineFor("read")).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("runGit", () => {
  const MARKER = "27.182";
  let root: string;
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vcs-group-git-"));
    const { stdout } = await exec("sh", ["-c", "command -v git"]);
    await mkdir(join(root, "bin"));
    await writeFile(
      join(root, "bin", "git"),
      `#!/bin/sh\nif [ "$1" = "hang" ]; then sleep ${MARKER} & exec sleep ${MARKER}; fi\nexec ${stdout.trim()} "$@"\n`,
    );
    await chmod(join(root, "bin", "git"), 0o755);
    process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`;
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await exec("pkill", ["-f", `sleep ${MARKER}`]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const survivors = async () => {
    try {
      const { stdout } = await exec("pgrep", ["-f", `sleep ${MARKER}`]);
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  it("resolves non-zero exits as results and never throws for them", async () => {
    const result = await runGit(["rev-parse", "--verify", "nope"], { cwd: root, timeoutMs: 5_000 });
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it("times out without spawning when the deadline is already spent", async () => {
    const result = await runGit(["hang"], { cwd: root, timeoutMs: 0 });
    expect(result).toMatchObject({ code: null, timedOut: true, cancelled: false });
    expect(await survivors()).toEqual([]);
  });

  it("kills the whole process group on timeout, not only the top-level git", async () => {
    const started = Date.now();
    const result = await runGit(["hang"], { cwd: root, timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result).toMatchObject({ code: null, timedOut: true, cancelled: false });
    await new Promise((done) => setTimeout(done, 300));
    expect(await survivors()).toEqual([]);
  });

  it("kills the whole process group on abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runGit(["hang"], { cwd: root, timeoutMs: 10_000, signal: controller.signal });
    expect(result).toMatchObject({ code: null, timedOut: false, cancelled: true });
    await new Promise((done) => setTimeout(done, 300));
    expect(await survivors()).toEqual([]);
  });
});
