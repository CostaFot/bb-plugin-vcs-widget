// The only way git is ever executed: spawn with an argv, no shell, a hygienic
// environment, and a deadline that kills git's whole process group (ssh,
// credential helpers, the fetch and merge children of `git pull`) rather
// than only the top-level process.
import { spawn } from "node:child_process";

export { DEADLINES_MS } from "./budget";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** After SIGTERM, how long a process group gets before SIGKILL. */
const KILL_GRACE_MS = 2_000;

export interface GitRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Receives every stdout and stderr chunk as it arrives (jobs stream progress). */
  onOutput?: (chunk: string) => void;
  /** Written to git's stdin, then closed (`commit -F -`). Undefined leaves stdin closed. */
  stdin?: string;
}

export interface GitRunResult {
  argv: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export class GitSpawnError extends Error {
  constructor(message: string, readonly argv: string[]) {
    super(message);
    this.name = "GitSpawnError";
  }
}

/** Environment for every git call: no prompts, no editors, no pagers, C locale. */
export function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_PAGER: "cat",
    LC_ALL: "C",
    ...extra,
  };
}

const useProcessGroups = process.platform !== "win32";

/**
 * Runs git and resolves with its outcome, never rejecting for a non-zero
 * exit. Rejects only when git cannot be spawned at all or floods the output
 * limit. A zero or negative deadline resolves as timed out without spawning.
 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const argv = [...args];
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ argv, code: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
      return;
    }
    if (options.timeoutMs <= 0) {
      resolve({ argv, code: null, stdout: "", stderr: "", timedOut: true, cancelled: false });
      return;
    }

    const child = spawn("git", argv, {
      cwd: options.cwd,
      env: gitEnv(options.env),
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: useProcessGroups,
      windowsHide: true,
    });
    if (options.stdin !== undefined && child.stdin) {
      // git may exit before reading everything (a failed pre-flight of its
      // own); an EPIPE then must not surface as an unhandled error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (useProcessGroups && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        stop();
        return;
      }
      chunks.push(chunk);
      if (options.onOutput) {
        try {
          options.onOutput(chunk.toString("utf8"));
        } catch {
          // A listener must not break the run.
        }
      }
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        reject(
          new GitSpawnError(
            error.code === "ENOENT" ? "git is not installed on the machine that owns this worktree." : error.message,
            argv,
          ),
        );
      });
    });

    child.on("close", (code, signal) => {
      finish(() => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (cancelled) {
          resolve({ argv, code: null, stdout: out, stderr: err, timedOut: false, cancelled: true });
        } else if (timedOut) {
          resolve({ argv, code: null, stdout: out, stderr: err, timedOut: true, cancelled: false });
        } else if (overflow) {
          reject(new GitSpawnError("git produced more output than the plugin can handle.", argv));
        } else if (code === null) {
          resolve({
            argv,
            code: null,
            stdout: out,
            stderr: err.length > 0 ? err : `git was stopped by ${signal ?? "a signal"}.`,
            timedOut: false,
            cancelled: false,
          });
        } else {
          resolve({ argv, code, stdout: out, stderr: err, timedOut: false, cancelled: false });
        }
      });
    });
  });
}

/** A read that is expected to succeed; the result's stdout, or null on failure. */
export async function gitReadOrNull(
  args: readonly string[],
  options: GitRunOptions,
): Promise<string | null> {
  const result = await runGit(args, options);
  return result.code === 0 ? result.stdout : null;
}
