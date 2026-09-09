// The commit panel's view of the working tree and the index, refetched on
// every repository change and after a reconnect.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChangesResult } from "../contracts";
import type { rpcContract } from "../server";
import { errorMessage } from "../lib/errors";
import { useRepositoryChanges } from "./use-repository-changes";

export interface ChangesState {
  changes: ChangesResult | null;
  loading: boolean;
  /** A transport failure; a git failure is inside `changes`. */
  error: string | null;
  refetch: () => void;
}

export function useChanges(threadId: string): ChangesState {
  const rpc = useRpc<typeof rpcContract>();
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refetch = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    rpc.call("changes", { threadId }).then(
      (next) => {
        if (mine !== generation.current) return;
        setChanges(next);
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (mine !== generation.current) return;
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
  }, [rpc, threadId]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRepositoryChanges(threadId, refetch);

  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current !== "connected" && connection === "connected") refetch();
    previous.current = connection;
  }, [connection, refetch]);

  return { changes, loading, error, refetch };
}
