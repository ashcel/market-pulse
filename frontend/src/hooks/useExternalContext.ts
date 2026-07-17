import { useQuery } from "@tanstack/react-query";

import type { ExternalContext } from "@/lib/engine/external-context";

/**
 * External market context for one token (breadth, relative strength, recent
 * catalysts, upcoming events) — the secondary-evidence payload the AI analyst
 * prompt appends. Server assembles it from Postgres + its own caches; a
 * failure here just means the AI runs on technicals alone, so errors resolve
 * to null rather than throwing.
 */
export function useExternalContext(symbol: string) {
  return useQuery<ExternalContext | null>({
    queryKey: ["external-context", symbol.toUpperCase()],
    queryFn: async () => {
      const res = await fetch(`/api/external-context?symbol=${encodeURIComponent(symbol)}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return null;
      return (await res.json()) as ExternalContext;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}
