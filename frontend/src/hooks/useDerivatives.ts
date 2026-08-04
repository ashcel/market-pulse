import { useQuery } from "@tanstack/react-query";

import type { SparkPoint } from "@/lib/types";

/**
 * Derivatives Intelligence read models.
 *
 * Every field below is already interpreted server-side (`backend/app/derivatives`).
 * Nothing in this file — or in anything consuming it — recomputes a score, a
 * band or a label: two implementations of "crowding" would drift the day one
 * of them is tuned.
 */

export type OiExpansion =
  "bullish_expansion" | "short_covering" | "bearish_expansion" | "long_capitulation" | "neutral";

export type CrowdingBand = "bearish_crowded" | "balanced" | "bullish_crowded" | "unknown";

export type MarketRegime =
  | "strong_bull_trend"
  | "weak_bull_trend"
  | "strong_bear_trend"
  | "weak_bear_trend"
  | "short_squeeze"
  | "long_squeeze"
  | "distribution"
  | "accumulation"
  | "neutral";

export type DerivativesMetric =
  | "momentum"
  | "oi"
  | "funding"
  | "buyer_aggression"
  | "squeeze_long"
  | "squeeze_short";
export type DerivativesWindow = "5m" | "1h" | "4h" | "24h";

export interface SqueezeScores {
  long: number;
  short: number;
}

export interface DerivativesRaw {
  symbol: string;
  timestamp: string;
  open_interest: number | null;
  open_interest_usd: number | null;
  funding_rate: number | null;
  long_short_ratio: number | null;
  top_trader_accounts_ratio: number | null;
  top_trader_positions_ratio: number | null;
  taker_buy_volume: number | null;
  taker_sell_volume: number | null;
  basis: number | null;
  premium: number | null;
  oi_marketcap_ratio: number | null;
  price: number | null;
}

export interface DerivativesDerived {
  oi_delta: Record<string, number | null>;
  price_delta: Record<string, number | null>;
  funding_trend: {
    current: number | null;
    delta_15m: number | null;
    delta_1h: number | null;
    percentile_24h: number | null;
  };
  buyer_aggression: number | null;
  oi_expansion: OiExpansion;
  crowding_score: number | null;
  crowding_band: CrowdingBand;
  momentum_score: number | null;
  squeeze: SqueezeScores;
  sample_count: number;
  history_span_s: number;
}

export interface DerivativesIntelligence {
  raw: DerivativesRaw;
  derived: DerivativesDerived;
  regime: MarketRegime;
  intelligence: {
    summary: string;
    regime_label: string;
    crowding_label: string;
    expansion_label: string;
    funding_label: string;
    oi_label: string;
    aggression_label: string;
    squeeze_label: string;
  };
  scores: {
    momentum: number | null;
    crowding: number | null;
    squeeze: SqueezeScores;
  };
}

interface DerivativesHistory {
  symbol: string;
  metric: DerivativesMetric;
  window: DerivativesWindow;
  points: SparkPoint[];
}

/**
 * Cross-symbol summary — same rule as everything else in this file: every
 * field arrives finished (`regime_label`, `squeeze_label`), computed once in
 * `backend/app/derivatives/service.py::build_summary`.
 */
export interface DerivativesSummaryMomentum {
  symbol: string;
  momentum: number;
  regime: MarketRegime;
  regime_label: string;
}

export interface DerivativesSummarySqueeze {
  symbol: string;
  squeeze: SqueezeScores;
  dominant_side: "long" | "short";
  squeeze_label: string;
}

export interface DerivativesSummaryOi {
  symbol: string;
  oi_delta_pct: number;
  regime: MarketRegime;
  regime_label: string;
}

export interface DerivativesSummaryRegimeCount {
  regime: MarketRegime;
  regime_label: string;
  count: number;
}

export interface DerivativesSummary {
  top_momentum: DerivativesSummaryMomentum[];
  top_squeeze: DerivativesSummarySqueeze[];
  top_oi_gainers: DerivativesSummaryOi[];
  top_oi_losers: DerivativesSummaryOi[];
  regime_distribution: DerivativesSummaryRegimeCount[];
  symbols_covered: number;
}

async function getData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { credentials: "same-origin" });
  // 404 = the collector has never seen this symbol. That is an empty state,
  // not an error the user should be shown a red box for.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

export function useDerivatives(symbol: string) {
  return useQuery({
    queryKey: ["derivatives", symbol],
    queryFn: () =>
      getData<DerivativesIntelligence>(`/api/derivatives?symbol=${encodeURIComponent(symbol)}`),
    enabled: Boolean(symbol),
    // The collector writes one row every 5 minutes; refetching faster than
    // that just re-reads the same row.
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
}

export function useDerivativesSummary() {
  return useQuery({
    queryKey: ["derivatives", "summary"],
    queryFn: () => getData<DerivativesSummary>("/api/derivatives?summary=1"),
    // Same 5-minute collector cadence as the per-symbol read.
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
}

export function useDerivativesHistory(
  symbol: string,
  metric: DerivativesMetric,
  window: DerivativesWindow,
  enabled = true,
) {
  return useQuery({
    queryKey: ["derivatives", symbol, metric, window],
    queryFn: () =>
      getData<DerivativesHistory>(
        `/api/derivatives?symbol=${encodeURIComponent(symbol)}&metric=${metric}&window=${window}`,
      ),
    enabled: enabled && Boolean(symbol),
    staleTime: 60_000,
  });
}
