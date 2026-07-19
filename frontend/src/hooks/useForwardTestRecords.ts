import { useQuery } from "@tanstack/react-query";

import type { ShadowSignal } from "@/lib/engine/shadow";

async function fetchForwardTestRecords(): Promise<ShadowSignal[]> {
  const res = await fetch("/api/forward-test?view=records", { credentials: "same-origin" });
  // Signed-out visitor: the server record simply isn't available to them yet —
  // fall back to an empty list rather than surfacing a query error.
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`forward-test records fetch failed: ${res.status}`);
  return (await res.json()) as ShadowSignal[];
}

/**
 * Read-through query over the engine's auto-recorded favored-verdict shadow
 * signals (the tracker page's "Signals the Engine Is Tracking" section) —
 * every favored verdict the engine issues, settled against real candles, no
 * follow required. The Python worker is the sole writer; the browser only
 * reads.
 */
export function useForwardTestRecords() {
  return useQuery({
    queryKey: ["forward-test-records"],
    queryFn: fetchForwardTestRecords,
    // The worker settles on a 5m cadence; refetching each minute keeps
    // statuses close behind without hammering the API.
    refetchInterval: 60_000,
    staleTime: 30_000,
    placeholderData: [],
  });
}
