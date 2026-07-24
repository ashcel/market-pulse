import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { fetchOpportunityScan } from "@/lib/engine/discovery";
import { fetchFundingScan } from "@/lib/engine/funding-scan";
import { fetchRsScan } from "@/lib/engine/rs-scan";
import { fetchMacroSnapshot } from "@/lib/engine/macro";
import { fetchMarketSnapshot, type MarketSnapshot } from "@/lib/engine/market";
import { fetchNews } from "@/lib/engine/news";
import { fetchAllTradableTickers, fetchTradableTickers } from "@/lib/engine/symbols";
import { usePreferencesStore } from "@/stores/preferences";
import { tickKey, useLivePriceStore } from "@/stores/live-prices";
import type { Asset } from "@/lib/types";

/**
 * One live snapshot feeds every dashboard surface: assets, regime, rotation,
 * sectors, sentiment, volatility, and per-asset signals. All page-level hooks
 * below are selectors over this single query so the whole app stays in sync
 * and refreshes together.
 */
function useMarketSnapshot<T = MarketSnapshot>(select?: (snapshot: MarketSnapshot) => T) {
  const refreshIntervalMs = usePreferencesStore((s) => s.refreshIntervalMs);
  const marketType = usePreferencesStore((s) => s.marketType);
  return useQuery({
    queryKey: ["market-snapshot", marketType],
    queryFn: () => fetchMarketSnapshot(marketType),
    staleTime: 30_000,
    refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    select,
  });
}

export const useSnapshotMeta = () =>
  useMarketSnapshot((s) => ({ source: s.source, updatedAt: s.updatedAt }));

/**
 * REST assets overlaid with live WS ticks (see binance-live-feed.ts /
 * useLiveUniverseSubscription) for whichever ticker+market a tick has
 * arrived for. REST stays the bootstrap/fallback — a tick only overrides
 * price/change24h once one exists, so this degrades to plain REST data
 * exactly as before if the feed hasn't ticked yet (or is unreachable).
 */
export const useAssets = () => {
  const marketType = usePreferencesStore((s) => s.marketType);
  const ticks = useLivePriceStore((s) => s.ticks);
  const query = useMarketSnapshot((s) => s.assets);
  const data = useMemo(() => {
    if (!query.data) return query.data;
    return query.data.map((asset): Asset => {
      const tick = ticks[tickKey(marketType, asset.ticker)];
      return tick ? { ...asset, price: tick.price, change24h: tick.change24h } : asset;
    });
  }, [query.data, ticks, marketType]);
  return { ...query, data };
};

export const useTopAssets = (n = 5) => {
  const { data: assets, ...rest } = useAssets();
  const data = useMemo(
    () => (assets ? [...assets].sort((a, b) => b.score - a.score).slice(0, n) : assets),
    [assets, n],
  );
  return { ...rest, data };
};

export const useRegime = () => useMarketSnapshot((s) => s.regime);

export const useRotation = () => useMarketSnapshot((s) => s.rotation);

export const useSectors = () => useMarketSnapshot((s) => s.sectors);

export const useSentiment = () => useMarketSnapshot((s) => s.sentiment);

export const useTechnicalQuality = () => useMarketSnapshot((s) => s.technical);

export const useVolatility = () => useMarketSnapshot((s) => s.volatility);

export const useSignals = (ticker = "BTC") =>
  useMarketSnapshot((s) => s.assetSignals[ticker.toUpperCase()] ?? s.assetSignals.BTC);

// Every tradable Binance USDT base ticker (spot + perp, for search
// autocomplete of perp-only pairs like LAB).
export const useBinanceTickers = (enabled = true) =>
  useQuery({
    queryKey: ["binance-tickers"],
    queryFn: () => fetchAllTradableTickers(),
    staleTime: 60 * 60_000,
    gcTime: 60 * 60_000,
    enabled,
  });

// Full-exchange liquidity/volatility/activity discovery scan (spot 24h ticker,
// cached ~2min server-side). Independent of the market snapshot on purpose:
// it ranks pairs far beyond the curated UNIVERSE.
export const useOpportunityScan = () =>
  useQuery({
    queryKey: ["opportunity-scan"],
    queryFn: fetchOpportunityScan,
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  });

// Full-exchange funding-play scan (premiumIndex + fundingInfo, cached ~20s
// server-side). Discovery/advisor layer like the opportunity scan: ranks
// every perp's current funding window, never a trading verdict.
export const useFundingScan = () =>
  useQuery({
    queryKey: ["funding-scan"],
    queryFn: fetchFundingScan,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

// Full-exchange relative-strength scan vs BTC (24h ticker + top/bottom kline
// enrichment, cached ~10min server-side). Discovery-plane like the
// opportunity scan — a ranking, never a verdict.
export const useRsScan = () =>
  useQuery({
    queryKey: ["rs-scan"],
    queryFn: fetchRsScan,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

// Live crypto headlines (Cointelegraph RSS via server fn) with tagged
// impact/direction/assets; falls back to the curated sample offline.
export const useNews = () =>
  useQuery({ queryKey: ["news"], queryFn: fetchNews, staleTime: 5 * 60_000 });

/** Mirrors the /api/auth GET shape without importing server code. */
export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
}

// The signed-in user, or null when signed out. Cheap + cached — every
// authed-only UI (first-run modal, account settings...) reads this instead
// of re-deriving auth state itself.
export const useCurrentUser = () =>
  useQuery<CurrentUser | null>({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      const res = await fetch("/api/auth", { credentials: "same-origin" });
      if (!res.ok) return null;
      const data = (await res.json()) as { user: CurrentUser | null };
      return data.user;
    },
    staleTime: 5 * 60_000,
  });

// Daily stocks/dollar/gold context plus BTC↔Nasdaq correlation. Daily data
// moves slowly, so this refreshes far less often than the crypto snapshot.
export const useMacro = () =>
  useQuery({
    queryKey: ["macro"],
    queryFn: fetchMacroSnapshot,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

// ── Catalyst Impact Score (Python events plane) ────────────────────────────────

export type ImpactDirection = "bearish" | "neutral" | "bullish";
export type ImpactLevel = "low" | "medium" | "high";

/**
 * One in-window, impact-scored event for a token — the flattened shape the
 * token page's catalyst line consumes. `occursAt` is the future occurrence for
 * upcoming calendar catalysts and the past publish time for news-derived
 * events; `isUpcoming` disambiguates the two.
 */
export interface CatalystImpact {
  id: string;
  symbol: string;
  kind: string;
  title: string;
  direction: ImpactDirection;
  impact: ImpactLevel;
  impactScore: number;
  occursAt: string;
  isUpcoming: boolean;
  percentOfSupply: number | null;
  disclaimer: string;
}

interface EventsEnvelope<T> {
  data: T[];
  meta: unknown;
  error: null;
}

interface CatalystRow {
  id: string;
  symbol: string;
  kind: string;
  title: string;
  occurs_at: string;
  percent_of_supply: number | null;
  impact: ImpactLevel;
  direction: ImpactDirection;
  impact_score: number;
  impact_disclaimer: string;
}

interface TokenEventRow {
  id: string;
  symbol: string;
  kind: string;
  title: string;
  published_at: string;
  impact: ImpactLevel;
  direction: ImpactDirection;
  impact_score: number;
  impact_disclaimer: string;
}

async function fetchEventRows<T>(path: string): Promise<T[]> {
  try {
    const res = await fetch(path, { credentials: "same-origin" });
    if (!res.ok) return [];
    const body = (await res.json()) as EventsEnvelope<T>;
    return body.data ?? [];
  } catch {
    // The Python events plane is served same-origin via Caddy (/api/v1/*) in
    // production; in dev (Vite alone) it 404s. Either way, absence is silent —
    // the catalyst line simply doesn't render.
    return [];
  }
}

/**
 * The single highest-impact, near-term catalyst for one token, from the
 * deterministic Catalyst Impact Score plane (backend/app/events — served
 * same-origin at /api/v1/events/*). Merges upcoming calendar catalysts
 * (7-day window) with recent news-derived events, keeps only medium/high
 * banded rows (LOW is filtered so a non-event never surfaces), and returns
 * the top-scoring one — or null, in which case the caller renders nothing.
 * The score/direction are the engine's own; this hook never re-weights them.
 */
export function useCatalystImpact(symbol: string) {
  const sym = symbol.toUpperCase();
  return useQuery<CatalystImpact | null>({
    queryKey: ["catalyst-impact", sym],
    queryFn: async () => {
      const [catalysts, news] = await Promise.all([
        fetchEventRows<CatalystRow>(
          `/api/v1/events/catalysts?symbol=${encodeURIComponent(sym)}&days=7`,
        ),
        fetchEventRows<TokenEventRow>(
          `/api/v1/events/token-events?symbol=${encodeURIComponent(sym)}`,
        ),
      ]);
      const events: CatalystImpact[] = [
        ...catalysts.map((c) => ({
          id: c.id,
          symbol: c.symbol,
          kind: c.kind,
          title: c.title,
          direction: c.direction,
          impact: c.impact,
          impactScore: c.impact_score,
          occursAt: c.occurs_at,
          isUpcoming: true,
          percentOfSupply: c.percent_of_supply,
          disclaimer: c.impact_disclaimer,
        })),
        ...news.map((n) => ({
          id: n.id,
          symbol: n.symbol,
          kind: n.kind,
          title: n.title,
          direction: n.direction,
          impact: n.impact,
          impactScore: n.impact_score,
          occursAt: n.published_at,
          isUpcoming: false,
          percentOfSupply: null,
          disclaimer: n.impact_disclaimer,
        })),
      ].filter((e) => e.impact !== "low");
      if (events.length === 0) return null;
      events.sort((a, b) => b.impactScore - a.impactScore);
      return events[0];
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Ranked, impact-scored upcoming catalysts across a batch of watched
 * tickers — the home catalyst rail's data source. `backend/app/events` has
 * no batch-by-symbols route for catalysts (unlike `/token-events`), so this
 * fans out one request per symbol via `useQueries` — watchlists stay
 * single-digit in practice — and flattens client-side. LOW-banded rows are
 * dropped for the same reason `useCatalystImpact` drops them: a non-event
 * shouldn't occupy a rail slot. Ranking is left to the caller by sorting on
 * `impactScore` directly — that composite already *is* impact (magnitude +
 * source confidence) weighted by a 30%-weighted proximity factor, so a
 * second "impact x proximity" formula here would just drift from the
 * backend's authoritative one.
 */
export function useCatalystRailEvents(symbols: string[], days = 14) {
  const key = useMemo(() => [...new Set(symbols.map((s) => s.toUpperCase()))].sort(), [symbols]);
  const results = useQueries({
    queries: key.map((symbol) => ({
      queryKey: ["catalyst-rail", symbol, days],
      queryFn: async (): Promise<CatalystImpact[]> => {
        const rows = await fetchEventRows<CatalystRow>(
          `/api/v1/events/catalysts?symbol=${encodeURIComponent(symbol)}&days=${days}`,
        );
        return rows
          .filter((c) => c.impact !== "low")
          .map((c) => ({
            id: c.id,
            symbol: c.symbol,
            kind: c.kind,
            title: c.title,
            direction: c.direction,
            impact: c.impact,
            impactScore: c.impact_score,
            occursAt: c.occurs_at,
            isUpcoming: true,
            percentOfSupply: c.percent_of_supply,
            disclaimer: c.impact_disclaimer,
          }));
      },
      staleTime: 5 * 60_000,
      refetchInterval: 5 * 60_000,
    })),
  });

  return {
    data: results.flatMap((r) => r.data ?? []),
    isLoading: results.length > 0 && results.some((r) => r.isLoading),
  };
}

/** Mirrors the server's EconomicEventRow (repo.ts) without importing server code. */
export interface UpcomingEconomicEvent {
  id: string;
  title: string;
  country: string;
  impact: "high" | "medium" | "low" | "holiday";
  forecast: string | null;
  previous: string | null;
  occursAt: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

// Upcoming macro calendar events (Fed decisions, CPI, jobs...) — read-only;
// the worker's econ pass is the sole writer. Defaults to the next 3 days,
// high-impact only, for a slim above-the-fold strip.
export function useEconomicEvents(days = 3, minImpact: "high" | "medium" | "low" = "high") {
  return useQuery<UpcomingEconomicEvent[]>({
    queryKey: ["economic-events", days, minImpact],
    queryFn: async () => {
      const res = await fetch(`/api/economic-events?days=${days}&minImpact=${minImpact}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { events: UpcomingEconomicEvent[] };
      return data.events;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}
