import { useQuery } from "@tanstack/react-query";

import { fetchMacroSnapshot } from "@/lib/engine/macro";
import { fetchMarketSnapshot, type MarketSnapshot } from "@/lib/engine/market";
import { fetchNews } from "@/lib/engine/news";
import { fetchTradableTickers } from "@/lib/engine/symbols";
import { usePreferencesStore } from "@/stores/preferences";

/**
 * One live snapshot feeds every dashboard surface: assets, regime, rotation,
 * sectors, sentiment, volatility, and per-asset signals. All page-level hooks
 * below are selectors over this single query so the whole app stays in sync
 * and refreshes together.
 */
function useMarketSnapshot<T = MarketSnapshot>(select?: (snapshot: MarketSnapshot) => T) {
  const refreshIntervalMs = usePreferencesStore((s) => s.refreshIntervalMs);
  return useQuery({
    queryKey: ["market-snapshot"],
    queryFn: fetchMarketSnapshot,
    staleTime: 30_000,
    refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    select,
  });
}

export const useSnapshotMeta = () =>
  useMarketSnapshot((s) => ({ source: s.source, updatedAt: s.updatedAt }));

export const useAssets = () => useMarketSnapshot((s) => s.assets);

export const useTopAssets = (n = 5) =>
  useMarketSnapshot((s) => [...s.assets].sort((a, b) => b.score - a.score).slice(0, n));

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
