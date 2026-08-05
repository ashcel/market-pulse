import { useQuery } from "@tanstack/react-query";

/** Mirrors `ForwardReturnEvidence` (`@/server/forward-test/evidence`) without importing server code into the client bundle. */
export interface ForwardReturnExtreme {
  symbol: string;
  forwardReturn: number;
}

export interface HorizonEvidence {
  horizon: string;
  n: number;
  avgR: number | null;
  medianR: number | null;
  winRate: number | null;
  insufficient: boolean;
  best: ForwardReturnExtreme | null;
  worst: ForwardReturnExtreme | null;
}

export interface ForwardReturnEvidence {
  horizons: HorizonEvidence[];
}

const EMPTY_EVIDENCE: ForwardReturnEvidence = { horizons: [] };

async function fetchForwardReturnEvidence(): Promise<ForwardReturnEvidence> {
  const res = await fetch("/api/evidence", { credentials: "same-origin" });
  // Signed-out visitor: the server record simply isn't available to them yet —
  // fall back to the empty record rather than surfacing a query error.
  if (res.status === 401) return EMPTY_EVIDENCE;
  if (!res.ok) throw new Error(`forward-return evidence fetch failed: ${res.status}`);
  return (await res.json()) as ForwardReturnEvidence;
}

/** Read-through query over the forward-return ground-truth evidence (Track Record section). */
export function useForwardReturnEvidence() {
  return useQuery({
    queryKey: ["forward-return-evidence"],
    queryFn: fetchForwardReturnEvidence,
    staleTime: 30_000,
    placeholderData: EMPTY_EVIDENCE,
  });
}
