import { createServerFn } from "@tanstack/react-start";

import { isTokenTimeframe } from "./mock-candles";
import type { TokenTimeframe } from "./mock-candles";
import { resolveExchangeSymbol } from "./symbol-map";
import type { Candle } from "./types";

/** Binance's kline interval string per app timeframe — also used by the kline WS stream name. */
export const BINANCE_INTERVALS: Record<TokenTimeframe, string> = {
  "15M": "15m",
  "30M": "30m",
  "1H": "1h",
  "4H": "4h",
  "1D": "1d",
  "1W": "1w",
};

/** Binance market to price against: spot or USDⓈ-M perpetual futures. */
export type MarketType = "spot" | "perp";

// Both markets expose identically shaped /klines and /ticker/price endpoints,
// so the same parsers work for either — only the REST host differs.
const REST_BASE: Record<MarketType, string> = {
  spot: "https://api.binance.com/api/v3",
  perp: "https://fapi.binance.com/fapi/v1",
};

function normalizeMarket(market: unknown): MarketType {
  return market === "perp" ? "perp" : "spot";
}

export interface BinanceKlinesInput {
  symbol: string;
  timeframe: TokenTimeframe;
  limit?: number;
  /** Only return bars that opened at or before this ms timestamp (history paging). */
  endTime?: number;
  /** Spot (default) or USDⓈ-M perpetual futures. */
  market?: MarketType;
}

type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]];

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 200;
  return Math.min(1000, Math.max(1, Math.trunc(limit)));
}

function normalizeEndTime(endTime: unknown): number | undefined {
  if (typeof endTime !== "number" || !Number.isFinite(endTime) || endTime <= 0) return undefined;
  return Math.trunc(endTime);
}

/**
 * Binance includes the still-forming current bar as the last kline row — its
 * OHLCV keeps changing on every refetch. Signal generation must never react
 * to an unclosed bar, or setups/decisions flip within a single candle's
 * lifetime instead of only when a bar actually closes. Charts may still want
 * the partial bar; this is for anything feeding `evaluateSignal`.
 */
export function dropUnclosedCandle(candles: Candle[]): Candle[] {
  if (candles.length < 2) return candles;
  const closing = candles[candles.length - 1];
  const step = closing.time - candles[candles.length - 2].time;
  if (step > 0 && Date.now() / 1000 < closing.time + step) return candles.slice(0, -1);
  return candles;
}

function parseBinanceKlines(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) return [];

  return payload.flatMap((row): Candle[] => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const [openTime, open, high, low, close, volume] = row as BinanceKlineRow;
    const candle = {
      time: Math.floor(Number(openTime) / 1000),
      open: Number.parseFloat(open),
      high: Number.parseFloat(high),
      low: Number.parseFloat(low),
      close: Number.parseFloat(close),
      volume: Number.parseFloat(volume),
    };

    return Object.values(candle).every(Number.isFinite) ? [candle] : [];
  });
}

/**
 * Binance quotes some futures bases (1000PEPE etc., see symbol-map.ts) as a
 * fixed multiple of the real token. Divide price fields back to real
 * per-token USDT so every downstream consumer (quant engine, chart, display)
 * sees the same units regardless of market — base-asset volume is in
 * contract units, so it's multiplied the other way; quoteVolume is already
 * real USDT notional and untouched (price × quantity cancels the scale).
 */
function applyPriceScale(candles: Candle[], priceScale: number): Candle[] {
  if (priceScale === 1) return candles;
  return candles.map((c) => ({
    ...c,
    open: c.open / priceScale,
    high: c.high / priceScale,
    low: c.low / priceScale,
    close: c.close / priceScale,
    volume: c.volume * priceScale,
  }));
}

export async function fetchBinanceKlinesDirect({
  symbol,
  timeframe,
  limit = 200,
  endTime,
  market,
}: BinanceKlinesInput): Promise<Candle[]> {
  const interval = BINANCE_INTERVALS[timeframe];
  const resolvedMarket = normalizeMarket(market);
  const { symbol: exchangeSymbol, priceScale } = resolveExchangeSymbol(symbol, resolvedMarket);
  if (exchangeSymbol === "USDT" || !interval) return [];

  const params = new URLSearchParams({
    symbol: exchangeSymbol,
    interval,
    limit: String(normalizeLimit(limit)),
  });
  const normalizedEndTime = normalizeEndTime(endTime);
  if (normalizedEndTime !== undefined) params.set("endTime", String(normalizedEndTime));

  try {
    const response = await fetch(`${REST_BASE[resolvedMarket]}/klines?${params.toString()}`);
    if (!response.ok) return [];
    return applyPriceScale(parseBinanceKlines(await response.json()), priceScale);
  } catch {
    return [];
  }
}

/**
 * Current traded price, independent of any timeframe's candle close. Used to
 * anchor risk-plan entries so a 15M and a 4H plan quote the same price rather
 * than each other's last-closed-bar staleness (up to a full bar old).
 */
export async function fetchBinancePriceDirect(
  symbol: string,
  market?: MarketType,
): Promise<number | null> {
  const resolvedMarket = normalizeMarket(market);
  const { symbol: exchangeSymbol, priceScale } = resolveExchangeSymbol(symbol, resolvedMarket);
  if (exchangeSymbol === "USDT") return null;
  try {
    const response = await fetch(
      `${REST_BASE[resolvedMarket]}/ticker/price?symbol=${exchangeSymbol}`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { price?: string };
    const price = Number.parseFloat(data.price ?? "");
    return Number.isFinite(price) && price > 0 ? price / priceScale : null;
  } catch {
    return null;
  }
}

export const fetchBinanceKlinesServer = createServerFn({ method: "GET" })
  .validator((data: BinanceKlinesInput): BinanceKlinesInput => ({
    symbol: typeof data?.symbol === "string" ? data.symbol : "",
    timeframe: isTokenTimeframe(data?.timeframe) ? data.timeframe : "4H",
    limit: normalizeLimit(data?.limit),
    endTime: normalizeEndTime(data?.endTime),
    market: normalizeMarket(data?.market),
  }))
  .handler(async ({ data }) => fetchBinanceKlinesDirect(data));

export async function fetchBinanceKlines(
  symbol: string,
  timeframe: TokenTimeframe,
  limit = 200,
  endTime?: number,
  market?: MarketType,
): Promise<Candle[]> {
  try {
    return await fetchBinanceKlinesServer({ data: { symbol, timeframe, limit, endTime, market } });
  } catch {
    return [];
  }
}

export const fetchBinancePriceServer = createServerFn({ method: "GET" })
  .validator((data: { symbol: string; market?: MarketType }) => ({
    symbol: typeof data?.symbol === "string" ? data.symbol : "",
    market: normalizeMarket(data?.market),
  }))
  .handler(async ({ data }) => fetchBinancePriceDirect(data.symbol, data.market));

export async function fetchBinancePrice(
  symbol: string,
  market?: MarketType,
): Promise<number | null> {
  try {
    return await fetchBinancePriceServer({ data: { symbol, market } });
  } catch {
    return null;
  }
}
