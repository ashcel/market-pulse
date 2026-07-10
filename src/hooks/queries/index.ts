import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { fetchMacroSnapshot } from "@/lib/engine/macro";
import { fetchMarketSnapshot, type MarketSnapshot } from "@/lib/engine/market";
import { fetchNews } from "@/lib/engine/news";
import { fetchTradableTickers } from "@/lib/engine/symbols";
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

// Every tradable Binance USDT base ticker (or null while offline), for search
// autocomplete. The listing set changes rarely, so it refreshes hourly at most.
export const useBinanceTickers = (enabled = true) =>
  useQuery({
    queryKey: ["binance-tickers"],
    queryFn: () => fetchTradableTickers(),
    staleTime: 60 * 60_000,
    gcTime: 60 * 60_000,
    enabled,
  });

// Live crypto headlines (Cointelegraph RSS via server fn) with tagged
// impact/direction/assets; falls back to the curated sample offline.
export const useNews = () =>
  useQuery({ queryKey: ["news"], queryFn: fetchNews, staleTime: 5 * 60_000 });

// Daily stocks/dollar/gold context plus BTC↔Nasdaq correlation. Daily data
// moves slowly, so this refreshes far less often than the crypto snapshot.
export const useMacro = () =>
  useQuery({
    queryKey: ["macro"],
    queryFn: fetchMacroSnapshot,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
