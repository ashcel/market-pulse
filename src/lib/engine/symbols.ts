import { createServerFn } from "@tanstack/react-start";

import type { MarketType } from "./binance";
import { normalizeTicker, resolveExchangeSymbol } from "./symbol-map";

interface ExchangeInfoSymbol {
  status: string;
  baseAsset: string;
  quoteAsset: string;
}

// Base assets of every TRADING Binance USDT pair, per market type. Cached
// server-side; the listing set changes rarely, and stale data is served if a
// refresh fails. Spot and futures have independent caches because the listed
// bases differ (e.g. PEPE on spot vs 1000PEPE on perp).
interface TickerCache {
  spot: { tickers: string[]; fetchedAt: number } | null;
  perp: { tickers: string[]; fetchedAt: number } | null;
}
const cache: TickerCache = { spot: null, perp: null };
const CACHE_TTL_MS = 60 * 60_000;

async function loadSpotTickers(): Promise<string[] | null> {
  if (cache.spot && Date.now() - cache.spot.fetchedAt < CACHE_TTL_MS) return cache.spot.tickers;

  try {
    const response = await fetch("https://api.binance.com/api/v3/exchangeInfo");
    if (!response.ok) return cache.spot?.tickers ?? null;
    const payload = (await response.json()) as { symbols?: ExchangeInfoSymbol[] };
    const tickers = [
      ...new Set(
        (payload.symbols ?? [])
          .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
          .map((s) => s.baseAsset),
      ),
    ].sort();
    if (tickers.length === 0) return cache.spot?.tickers ?? null;
    cache.spot = { tickers, fetchedAt: Date.now() };
    return tickers;
  } catch {
    return cache.spot?.tickers ?? null;
  }
}

async function loadPerpTickers(): Promise<string[] | null> {
  if (cache.perp && Date.now() - cache.perp.fetchedAt < CACHE_TTL_MS) return cache.perp.tickers;

  try {
    const response = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
    if (!response.ok) return cache.perp?.tickers ?? null;
    const payload = (await response.json()) as { symbols?: ExchangeInfoSymbol[] };
    const tickers = [
      ...new Set(
        (payload.symbols ?? [])
          .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
          .map((s) => s.baseAsset),
      ),
    ].sort();
    if (tickers.length === 0) return cache.perp?.tickers ?? null;
    cache.perp = { tickers, fetchedAt: Date.now() };
    return tickers;
  } catch {
    return cache.perp?.tickers ?? null;
  }
}

/** All tradable USDT spot base tickers, or null when Binance is unreachable. */
export const fetchTradableTickers = createServerFn({ method: "GET" }).handler(loadSpotTickers);

/**
 * Plain (non-serverFn) spot ∪ perp directory for server-side callers like the
 * worker's event pass, which runs outside a request context.
 */
export async function loadAllTradableTickersDirect(): Promise<string[]> {
  const [spot, perp] = await Promise.all([loadSpotTickers(), loadPerpTickers()]);
  const set = new Set<string>();
  if (spot) for (const t of spot) set.add(t);
  if (perp) for (const t of perp) set.add(t);
  return [...set].sort();
}

/**
 * All tradable USDT base tickers across both spot *and* perp markets, merged
 * and deduplicated. Used by the search autocomplete so perp-only pairs like
 * LAB show up when the user types them.
 */
export const fetchAllTradableTickers = createServerFn({ method: "GET" }).handler(async () => {
  const [spot, perp] = await Promise.all([loadSpotTickers(), loadPerpTickers()]);
  const set = new Set<string>();
  if (spot) for (const t of spot) set.add(t);
  if (perp) for (const t of perp) set.add(t);
  return set.size > 0 ? [...set].sort() : null;
});

export type TickerCheck = "valid" | "invalid" | "unknown";

/**
 * Whether `${ticker}USDT` is a live Binance USDT pair on the given market.
 * Spot checks the spot exchangeInfo; perp checks the futures exchangeInfo and
 * resolves the base-asset override (e.g. PEPE → 1000PEPE on futures).
 * "unknown" means the directory could not be fetched, so the caller should not 404.
 */
export const checkTradableTicker = createServerFn({ method: "GET" })
  .validator(
    (input: { ticker: string; market?: MarketType }): { ticker: string; market?: MarketType } =>
      typeof input === "object" && input !== null ? input : { ticker: "" },
  )
  .handler(async ({ data }): Promise<TickerCheck> => {
    const ticker = normalizeTicker(data.ticker);
    if (!ticker) return "invalid";
    const market: MarketType = data.market ?? "spot";
    const tickers = market === "perp" ? await loadPerpTickers() : await loadSpotTickers();
    if (!tickers) return "unknown";
    // On perp, the listed base may be a scaled alias (PEPE → 1000PEPE).
    // resolveExchangeSymbol returns the exchange-facing base, so the check
    // works against the actual futures listing.
    if (market === "perp") {
      const resolved = resolveExchangeSymbol(ticker, "perp");
      const baseSymbol = resolved.symbol.replace(/USDT$/, "");
      return tickers.includes(baseSymbol) ? "valid" : "invalid";
    }
    return tickers.includes(ticker) ? "valid" : "invalid";
  });
