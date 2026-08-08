import { useQuery } from "@tanstack/react-query";

/** Mirrors `app.patterns.schemas.ReaccumulationReadResponse` (backend). */
export interface ReaccumulationEvidenceItem {
  score: number;
  detail: string;
}

export interface ReaccumulationRead {
  pattern: "REACCUMULATION";
  state: "SECOND_EXPANSION" | "ACCUMULATING";
  score: number;
  direction: "long" | "short";
  evidence: {
    previousImpulse: ReaccumulationEvidenceItem;
    retracementQuality: ReaccumulationEvidenceItem;
    baseQuality: ReaccumulationEvidenceItem;
    oiReset: ReaccumulationEvidenceItem;
    oiRebuild: ReaccumulationEvidenceItem;
    currentExpansion: ReaccumulationEvidenceItem;
  };
  explanation: string;
  evaluatedAt: number;
  oiAvailable: boolean;
  version: string;
  breakoutPct: number;
}

interface RawEvaluateResponse {
  data: {
    pattern: string;
    state: string;
    score: number;
    direction: string;
    evidence: Record<string, ReaccumulationEvidenceItem>;
    explanation: string;
    evaluated_at: number;
    oi_available: boolean;
    version: string;
    breakout_pct: number;
  } | null;
}

/**
 * Live REACCUMULATION / SECOND EXPANSION read for the token page — computed
 * on demand (server-side, against fresh klines + OI) rather than waiting for
 * the hourly worker pass that writes the persisted `signal_events` row.
 * Research hypothesis only: no win-rate claim, gates no order.
 */
export function useReaccumulation(symbol: string) {
  return useQuery<ReaccumulationRead | null>({
    queryKey: ["reaccumulation", symbol.toUpperCase()],
    enabled: symbol.length > 0,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch("/api/patterns/reaccumulation", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: symbol.toUpperCase() }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as RawEvaluateResponse;
      if (!body.data) return null;
      const d = body.data;
      return {
        pattern: "REACCUMULATION",
        state: d.state as ReaccumulationRead["state"],
        score: d.score,
        direction: d.direction as ReaccumulationRead["direction"],
        evidence: d.evidence as ReaccumulationRead["evidence"],
        explanation: d.explanation,
        evaluatedAt: d.evaluated_at,
        oiAvailable: d.oi_available,
        version: d.version,
        breakoutPct: d.breakout_pct,
      };
    },
  });
}

/** One ranked row of the discover-page REACCUMULATION screening card. */
export interface ReaccumulationScanRow {
  symbol: string;
  state: "SECOND_EXPANSION" | "ACCUMULATING";
  score: number;
  direction: "long" | "short";
  evidence: ReaccumulationRead["evidence"];
  explanation: string;
  detectedAt: string;
  oiAvailable: boolean;
}

interface RawListResponse {
  data: Array<{
    symbol: string;
    side: string;
    detected_at: string;
    state: string | null;
    score: number | null;
    features: {
      state?: string;
      score?: number;
      evidence?: Record<string, ReaccumulationEvidenceItem>;
      explanation?: string;
      oiAvailable?: boolean;
    };
  }>;
}

const SCAN_LIMIT = 15;

/**
 * Persisted REACCUMULATION screening feed for the discover page — one row
 * per symbol (its latest read), ranked by score. Reads only what the hourly
 * worker pass (`backend/app/worker/patterns_pass.py`) has already written;
 * never evaluates the universe live on page load.
 */
export function useReaccumulationScan() {
  return useQuery<ReaccumulationScanRow[]>({
    queryKey: ["reaccumulation-scan"],
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(SCAN_LIMIT),
        latest_per_symbol: "true",
        sort: "score",
      });
      const res = await fetch(`/api/patterns/reaccumulation?${params.toString()}`);
      if (!res.ok) return [];
      const body = (await res.json()) as RawListResponse;
      return (body.data ?? []).map((row) => ({
        symbol: row.symbol,
        state: (row.state ?? row.features.state ?? "ACCUMULATING") as ReaccumulationScanRow["state"],
        score: row.score ?? row.features.score ?? 0,
        direction: row.side as ReaccumulationScanRow["direction"],
        evidence: (row.features.evidence ?? {}) as ReaccumulationRead["evidence"],
        explanation: row.features.explanation ?? "",
        detectedAt: row.detected_at,
        oiAvailable: Boolean(row.features.oiAvailable),
      }));
    },
  });
}
