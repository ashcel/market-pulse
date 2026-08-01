import { useQuery } from "@tanstack/react-query";

export interface OpportunitySource {
  source: string;
  source_version: string;
  kind: string;
  conviction: string | null;
  detected_at: string;
  reason: string;
}

export interface Opportunity {
  key: string;
  symbol: string;
  side: "long" | "short";
  horizon: string;
  sources: OpportunitySource[];
  conviction: "low" | "medium" | "high";
  regime_alignment: "aligned" | "counter" | "neutral";
  rank_score: number;
  evidence: { status: "ok" | "insufficient"; n: number; hit_rate: number | null; avg_r: number | null; window_days: number };
}

export interface RelatedSignal {
  id: string;
  source: string;
  source_version: string;
  symbol: string;
  side: string;
  horizon: string;
  kind: string;
  conviction: string | null;
  detected_at: string;
}

async function getData<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

export function useIdeas() {
  return useQuery({
    queryKey: ["ideas"],
    queryFn: () => getData<Opportunity[]>("/api/opportunities?limit=50"),
    staleTime: 30_000,
  });
}

export function useRelatedSignals(symbol: string) {
  return useQuery({
    queryKey: ["signals", symbol],
    queryFn: () => getData<RelatedSignal[]>(`/api/signals?symbol=${encodeURIComponent(symbol)}`),
    enabled: Boolean(symbol),
    staleTime: 30_000,
  });
}
