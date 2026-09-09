// Starred branches for this repository, kept by the server per host and
// repository. Keys are `local:<name>` / `remote:<remote>/<branch>`.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { CHANGED_CHANNEL } from "../shared/constants";
import { errorMessage } from "../lib/errors";

interface UseFavouritesOptions {
  threadId: string;
  environmentId: string | null;
  enabled: boolean;
}

export function useFavourites({ threadId, environmentId, enabled }: UseFavouritesOptions) {
  const rpc = useRpc<typeof rpcContract>();
  const [names, setNames] = useState<ReadonlySet<string>>(() => new Set());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refetch = useCallback(async () => {
    try {
      const result = await rpc.call("favourites", { threadId });
      setNames(new Set(result.names));
    } catch {
      // Favourites are decoration; the list still works without them.
    }
  }, [rpc, threadId]);

  useEffect(() => {
    if (enabled) void refetch();
  }, [enabled, refetch]);

  useRealtime(CHANGED_CHANNEL, (payload) => {
    if (!enabledRef.current) return;
    const change = payload as { environmentId?: unknown; reason?: unknown };
    if (change.reason !== "favourites") return;
    if (typeof change.environmentId === "string" && environmentId !== null && change.environmentId !== environmentId) return;
    void refetch();
  });

  const toggle = useCallback(
    async (key: string) => {
      const favourite = !names.has(key);
      setNames((current) => {
        const next = new Set(current);
        if (favourite) next.add(key);
        else next.delete(key);
        return next;
      });
      try {
        const result = await rpc.call("setFavourite", { threadId, name: key, favourite });
        setNames(new Set(result.names));
      } catch (cause) {
        toast.error(`Could not update favourites: ${errorMessage(cause)}`);
        void refetch();
      }
    },
    [names, refetch, rpc, threadId],
  );

  return { names, toggle, refetch };
}
