import { createServerFn } from "@tanstack/react-start";

import { normalizeTicker } from "./symbol-map";

interface ExchangeInfoSymbol {
  status: string;
  baseAsset: string;
  quoteAsset: string;
}

// Base assets of every TRADING Binance USDT spot pair. Cached server-side;
// the listing set changes rarely, and stale data is served if a refresh fails.
let cache: { tickers: string[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60_000;

async function loadTradableTickers(): Promise<string[] | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.tickers;

  try {
    const response = await fetch("https://api.binance.com/api/v3/exchangeInfo");
    if (!response.ok) return cache?.tickers ?? null;
    const payload = (await response.json()) as { symbols?: ExchangeInfoSymbol[] };
    const tickers = [
      ...new Set(
        (payload.symbols ?? [])
          .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
          .map((s) => s.baseAsset),
      ),
    ].sort();
    if (tickers.length === 0) return cache?.tickers ?? null;
    cache = { tickers, fetchedAt: Date.now() };
    return tickers;
  } catch {
    return cache?.tickers ?? null;
  }
}

/** All tradable USDT spot base tickers, or null when Binance is unreachable. */
export const fetchTradableTickers = createServerFn({ method: "GET" }).handler(loadTradableTickers);

export type TickerCheck = "valid" | "invalid" | "unknown";

/**
 * Whether `${ticker}USDT` is a live Binance USDT spot pair.
 * "unknown" means the directory could not be fetched, so the caller should not 404.
 */
export const checkTradableTicker = createServerFn({ method: "GET" })
  .validator((ticker: string): string => (typeof ticker === "string" ? ticker : ""))
  .handler(async ({ data }): Promise<TickerCheck> => {
    const ticker = normalizeTicker(data);
    if (!ticker) return "invalid";
    const tickers = await loadTradableTickers();
    if (!tickers) return "unknown";
    return tickers.includes(ticker) ? "valid" : "invalid";
  });
