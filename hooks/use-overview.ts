import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { Overview } from "../contracts";
import type { rpcContract } from "../server";
import { CHANGED_CHANNEL } from "../shared/constants";
import { errorMessage } from "../lib/errors";

interface UseOverviewOptions {
  threadId: string;
  environmentId: string | null;
  /** Nothing is fetched until the popup was opened once. */
  enabled: boolean;
}

export interface OverviewState {
  overview: Overview | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /** Adopt the overview returned by a mutation without another round trip. */
  applyOverview: (overview: Overview) => void;
}

function isChangedPayload(value: unknown): value is { environmentId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { environmentId?: unknown }).environmentId === "string"
  );
}

export function useOverview({ threadId, environmentId, enabled }: UseOverviewOptions): OverviewState {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A slow response must never overwrite a newer one.
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refetch = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await rpc.call("overview", { threadId });
      if (mine !== generation.current) return;
      setOverview(next);
      setError(null);
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(errorMessage(cause));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [rpc, threadId]);

  const applyOverview = useCallback((next: Overview) => {
    generation.current += 1;
    setOverview(next);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (enabled) void refetch();
  }, [enabled, refetch]);

  useRealtime(CHANGED_CHANNEL, (payload) => {
    if (!enabledRef.current) return;
    if (isChangedPayload(payload) && environmentId !== null && payload.environmentId !== environmentId) return;
    void refetch();
  });

  // Signals are never replayed: reconcile after a reconnect.
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current !== "connected" && connection === "connected" && enabledRef.current) {
      void refetch();
    }
    previousConnection.current = connection;
  }, [connection, refetch]);

  return { overview, loading, error, refetch, applyOverview };
}
