// Background jobs: fetch, pull, push and their relatives outlive the 30 s
// host call. The starting handler pre-flights, takes the repository lock and
// a worker lease, spawns git, and returns the job id at once. Progress and
// the final result travel as `jobEvent` signals; `jobGet` is the polling
// fallback, `jobCancel` kills the process group. Finished jobs stay readable
// for a while so a client that missed the signal can still learn the outcome.
import { randomUUID } from "node:crypto";
import type { ActionResult, JobEvent, JobState, JobSummary } from "../contracts";
import type { JobKind } from "../shared/constants";
import { runGit, type GitRunResult } from "./git";

/** How long a finished job stays readable through `jobGet`. */
export const JOB_RETENTION_MS = 10 * 60_000;
/** Lines of output kept per job. */
const OUTPUT_LINES = 40;
/** Output events emitted per job; a runaway remote cannot flood the server. */
const MAX_OUTPUT_EVENTS = 200;

interface Lease {
  dispose(): Promise<void>;
}

export interface StartJobInput {
  kind: JobKind;
  repoRoot: string;
  commonDir: string;
  cwd: string;
  argv: string[];
  /** Human-readable command, shown to the user. */
  command: string;
  /** Text for git's stdin (the commit message); never part of `argv`. */
  stdin?: string;
  timeoutMs: number;
  lifecycleSignal: AbortSignal;
  retainWorker: () => Lease;
  emit: (jobId: string, event: JobEvent) => Promise<void>;
  /** Releases the repository lock; called once the job is over. */
  releaseLock: () => void;
  /** Turns the finished run into a result, reading the overview afterwards. */
  finish: (run: GitRunResult, deadlineMs: number) => Promise<ActionResult>;
}

interface Job {
  summary: JobSummary;
  repoRoot: string;
  commonDir: string;
  status: "running" | "finished";
  finishedAt: number | null;
  output: string[];
  result: ActionResult | null;
  controller: AbortController;
  retention: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
}

const jobs = new Map<string, Job>();
const byRepo = new Map<string, string>();

export function activeJobFor(commonDir: string): JobSummary | null {
  const jobId = byRepo.get(commonDir);
  const job = jobId === undefined ? undefined : jobs.get(jobId);
  return job === undefined || job.status !== "running" ? null : job.summary;
}

export function jobState(jobId: string): JobState | null {
  const job = jobs.get(jobId);
  if (job === undefined) return null;
  return {
    ...job.summary,
    status: job.status,
    finishedAt: job.finishedAt,
    output: [...job.output],
    result: job.result,
  };
}

/** SIGTERM to the process group, SIGKILL after the grace period (host/git.ts). */
export function cancelJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (job === undefined || job.status !== "running") return false;
  job.controller.abort();
  return true;
}

/** Test hook: resolves once the job has emitted its final event. */
export function waitForJob(jobId: string): Promise<void> {
  return jobs.get(jobId)?.done ?? Promise.resolve();
}

export function startJob(input: StartJobInput): JobSummary {
  const jobId = randomUUID();
  const summary: JobSummary = { jobId, kind: input.kind, command: input.command, startedAt: Date.now() };
  const controller = new AbortController();
  const onLifecycleAbort = () => controller.abort();
  input.lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });
  if (input.lifecycleSignal.aborted) controller.abort();

  // The lease is taken while the starting call is still open; the daemon
  // refuses one afterwards.
  let lease: Lease | null = null;
  try {
    lease = input.retainWorker();
  } catch {
    lease = null;
  }

  const job: Job = {
    summary,
    repoRoot: input.repoRoot,
    commonDir: input.commonDir,
    status: "running",
    finishedAt: null,
    output: [],
    result: null,
    controller,
    retention: null,
    done: Promise.resolve(),
  };
  jobs.set(jobId, job);
  byRepo.set(input.commonDir, jobId);

  const emit = (event: JobEvent) => input.emit(jobId, event).catch(() => undefined);

  let partial = "";
  let emitted = 0;
  const onOutput = (chunk: string) => {
    partial += chunk;
    // git ends progress lines with \r; treat those as lines too.
    const pieces = partial.split(/\r\n|\n|\r/u);
    partial = pieces.pop() ?? "";
    for (const raw of pieces) {
      const line = raw.trim();
      if (line.length === 0) continue;
      job.output.push(line);
      if (job.output.length > OUTPUT_LINES) job.output.shift();
      if (emitted < MAX_OUTPUT_EVENTS) {
        emitted += 1;
        void emit({ kind: "output", line });
      }
    }
  };

  job.done = (async () => {
    await emit({ kind: "started", command: input.command });
    let result: ActionResult;
    try {
      const run = await runGit(input.argv, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
        onOutput,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      });
      if (partial.trim().length > 0) onOutput("\n");
      // Off the repository before the overview read, so the result's
      // overview does not list this job as active.
      job.status = "finished";
      if (byRepo.get(input.commonDir) === jobId) byRepo.delete(input.commonDir);
      input.releaseLock();
      result = await input.finish(run, input.timeoutMs);
    } catch (error) {
      job.status = "finished";
      if (byRepo.get(input.commonDir) === jobId) byRepo.delete(input.commonDir);
      input.releaseLock();
      result = {
        ok: false,
        error: { code: "git_failed", message: error instanceof Error ? error.message : String(error) },
        overview: null,
      };
    }
    job.finishedAt = Date.now();
    job.result = result;
    input.lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
    await emit({ kind: "finished", result });
    if (lease !== null) await lease.dispose().catch(() => undefined);
    job.retention = setTimeout(() => {
      jobs.delete(jobId);
    }, JOB_RETENTION_MS);
    job.retention.unref?.();
  })();

  return summary;
}

/** Cancels every running job and forgets the finished ones (worker dispose). */
export async function disposeJobs(): Promise<void> {
  const running: Promise<void>[] = [];
  for (const job of jobs.values()) {
    if (job.status === "running") {
      job.controller.abort();
      running.push(job.done);
    }
    if (job.retention !== null) clearTimeout(job.retention);
  }
  await Promise.allSettled(running);
  jobs.clear();
  byRepo.clear();
}
