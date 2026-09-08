// The only way git is ever executed: execFile with an argv, no shell, a
// hygienic environment, and a per-command deadline that keeps every handler
// under bb's fixed 30 s host-call cap.
import { execFile } from "node:child_process";

export const DEADLINES_MS = {
  read: 10_000,
  mutate: 20_000,
  network: 25_000,
} as const;

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface GitRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
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

/**
 * Runs git and resolves with its outcome, never rejecting for a non-zero
 * exit. Rejects only when git cannot be spawned at all.
 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const argv = [...args];
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ argv, code: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
      return;
    }
    execFile(
      "git",
      argv,
      {
        cwd: options.cwd,
        env: gitEnv(options.env),
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs,
        killSignal: "SIGTERM",
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ argv, code: 0, stdout, stderr, timedOut: false, cancelled: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (failure.code === "ENOENT") {
          reject(new GitSpawnError("git is not installed on the machine that owns this worktree.", argv));
          return;
        }
        if (failure.name === "AbortError" || options.signal?.aborted) {
          resolve({ argv, code: null, stdout, stderr, timedOut: false, cancelled: true });
          return;
        }
        if (failure.killed === true || failure.signal === "SIGTERM") {
          resolve({ argv, code: null, stdout, stderr, timedOut: true, cancelled: false });
          return;
        }
        if (typeof failure.code === "number") {
          resolve({ argv, code: failure.code, stdout, stderr, timedOut: false, cancelled: false });
          return;
        }
        reject(new GitSpawnError(failure.message, argv));
      },
    );
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
