import { useQuery } from "@tanstack/react-query";
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

/** Mirrors the server's MarketContextRow (repo.ts) without importing server code. */
export interface MarketContextSnapshot {
  id: string;
  totalMcapUsd: number;
  btcDominance: number;
  ethDominance: number | null;
  mcapChange24hPct: number | null;
  source: string;
  fetchedAt: string;
}

export interface MarketContextRead {
  latest: MarketContextSnapshot | null;
  prior24h: MarketContextSnapshot | null;
  series: { t: number; mcapUsd: number; btcDominance: number }[];
}

// Global breadth (total market cap + BTC dominance) from the worker's context
// pass. Provider data refreshed every few minutes, so this polls slowly; a
// null `latest` means nothing has been ingested (unconfigured keys) and every
// consumer must render that as "unavailable", never as zero.
export const useMarketContext = () =>
  useQuery<MarketContextRead>({
    queryKey: ["market-context"],
    queryFn: async () => {
      const res = await fetch("/api/market-context", { credentials: "same-origin" });
      if (!res.ok) return { latest: null, prior24h: null, series: [] };
      return (await res.json()) as MarketContextRead;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

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
