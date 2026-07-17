import { useQuery } from "@tanstack/react-query";

import { ENGINE_VERSION } from "@/lib/engine/version";
import type { ShadowComboStat, ShadowRecordSummary } from "@/lib/engine/shadow";

/** Mirrors `ForwardTestStats` (`@/server/forward-test/service`) without importing server code into the client bundle. */
export interface ForwardTestStats {
  engineVersion: string;
  shadow: {
    summary: ShadowRecordSummary;
    combos: ShadowComboStat[];
  };
}

const EMPTY_STATS: ForwardTestStats = {
  engineVersion: ENGINE_VERSION,
  shadow: {
    summary: { total: 0, open: 0, closed: 0, wins: 0, winRate: 0, averageR: 0, lowSample: false },
    combos: [],
  },
};

async function fetchForwardTestStats(): Promise<ForwardTestStats> {
  const res = await fetch("/api/forward-test?view=stats", { credentials: "same-origin" });
  // Signed-out visitor: the server record simply isn't available to them yet —
  // fall back to the empty record rather than surfacing a query error.
  if (res.status === 401) return EMPTY_STATS;
  if (!res.ok) throw new Error(`forward-test stats fetch failed: ${res.status}`);
  return (await res.json()) as ForwardTestStats;
}

/**
 * Read-through query over the server-owned forward-test record (WS5). This is
 * the one source of shadow-record combo stats for the UI now — the worker is
 * the sole writer, the browser only reads.
 */
export function useForwardTestRecord() {
  return useQuery({
    queryKey: ["forward-test-stats"],
    queryFn: fetchForwardTestStats,
    staleTime: 30_000,
    placeholderData: EMPTY_STATS,
  });
}
