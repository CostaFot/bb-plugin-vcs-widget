// Background jobs seen from one pane: waits for a job's final result over
// the realtime `job` channel, polls `jobGet` as a fallback (a missed signal,
// or a job that finished before this pane subscribed), and cancels on
// request. One pane waits for one job at a time.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ActionResult, JobEvent, JobSummary } from "../contracts";
import type { rpcContract } from "../server";
import { JOB_CHANNEL } from "../shared/constants";
import { errorMessage } from "../lib/errors";

export interface JobProgress extends JobSummary {
  /** The last line git printed, when any. */
  lastLine: string | null;
}

export const FIRST_POLL_MS = 1_500;
export const POLL_MS = 3_000;

interface Pending {
  resolve: (result: ActionResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

function isJobPayload(value: unknown): value is { jobId: string; event: JobEvent } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { jobId?: unknown; event?: unknown };
  return typeof candidate.jobId === "string" && typeof candidate.event === "object" && candidate.event !== null;
}

export function useJobs(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const pending = useRef(new Map<string, Pending>());

  const settle = useCallback((jobId: string, result: ActionResult) => {
    const entry = pending.current.get(jobId);
    if (entry === undefined) return;
    pending.current.delete(jobId);
    if (entry.timer !== null) clearTimeout(entry.timer);
    setProgress((current) => (current?.jobId === jobId ? null : current));
    entry.resolve(result);
  }, []);

  const noteLine = useCallback((jobId: string, line: string) => {
    setProgress((current) => (current?.jobId === jobId ? { ...current, lastLine: line } : current));
  }, []);

  useRealtime(JOB_CHANNEL, (payload) => {
    if (!isJobPayload(payload) || !pending.current.has(payload.jobId)) return;
    const event = payload.event;
    if (event.kind === "output") noteLine(payload.jobId, event.line);
    else if (event.kind === "finished") settle(payload.jobId, event.result);
  });

  /** Resolves with the job's result; never rejects. */
  const waitFor = useCallback(
    (job: JobSummary): Promise<ActionResult> =>
      new Promise((resolve) => {
        setProgress({ ...job, lastLine: null });
        const entry: Pending = { resolve, timer: null };
        pending.current.set(job.jobId, entry);
        const poll = async () => {
          if (!pending.current.has(job.jobId)) return;
          try {
            const state = await rpc.call("jobGet", { threadId, jobId: job.jobId });
            if (state === null) {
              settle(job.jobId, {
                ok: false,
                error: {
                  code: "git_failed",
                  message: "The host no longer knows this job.",
                  hint: "The host worker may have restarted; open the popup again to see the repository state.",
                },
                overview: null,
              });
              return;
            }
            if (state.status === "finished" && state.result !== null) {
              settle(job.jobId, state.result);
              return;
            }
            const last = state.output.at(-1);
            if (last !== undefined) noteLine(job.jobId, last);
          } catch {
            // Transport hiccup: the next poll or the realtime event will tell.
          }
          if (pending.current.has(job.jobId)) entry.timer = setTimeout(poll, POLL_MS);
        };
        entry.timer = setTimeout(poll, FIRST_POLL_MS);
      }),
    [noteLine, rpc, settle, threadId],
  );

  const cancel = useCallback(
    async (jobId: string) => {
      try {
        const { cancelled } = await rpc.call("jobCancel", { threadId, jobId });
        if (!cancelled) toast.error("The job had already finished.");
      } catch (cause) {
        toast.error(`Could not cancel: ${errorMessage(cause)}`);
      }
    },
    [rpc, threadId],
  );

  useEffect(() => {
    const map = pending.current;
    return () => {
      for (const entry of map.values()) if (entry.timer !== null) clearTimeout(entry.timer);
      map.clear();
    };
  }, []);

  return { progress, waitFor, cancel };
}
