import { createServerFn } from "@tanstack/react-start";

import { isTokenTimeframe } from "./mock-candles";
import type { TokenTimeframe } from "./mock-candles";
import type { Candle } from "./types";

const BINANCE_INTERVALS: Record<TokenTimeframe, string> = {
  "15M": "15m",
  "30M": "30m",
  "1H": "1h",
  "4H": "4h",
  "1D": "1d",
  "1W": "1w",
};

export interface BinanceKlinesInput {
  symbol: string;
  timeframe: TokenTimeframe;
  limit?: number;
}

type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]];

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 200;
  return Math.min(1000, Math.max(1, Math.trunc(limit)));
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

export async function fetchBinanceKlinesDirect({
  symbol,
  timeframe,
  limit = 200,
}: BinanceKlinesInput): Promise<Candle[]> {
  const ticker = normalizeSymbol(symbol);
  const interval = BINANCE_INTERVALS[timeframe];
  if (!ticker || !interval) return [];

  const params = new URLSearchParams({
    symbol: `${ticker}USDT`,
    interval,
    limit: String(normalizeLimit(limit)),
  });

  try {
    const response = await fetch(`https://api.binance.com/api/v3/klines?${params.toString()}`);
    if (!response.ok) return [];
    return parseBinanceKlines(await response.json());
  } catch {
    return [];
  }
}

export const fetchBinanceKlinesServer = createServerFn({ method: "GET" })
  .validator(
    (data: BinanceKlinesInput): BinanceKlinesInput => ({
      symbol: typeof data?.symbol === "string" ? data.symbol : "",
      timeframe: isTokenTimeframe(data?.timeframe) ? data.timeframe : "4H",
      limit: normalizeLimit(data?.limit),
    }),
  )
  .handler(async ({ data }) => fetchBinanceKlinesDirect(data));

export async function fetchBinanceKlines(
  symbol: string,
  timeframe: TokenTimeframe,
  limit = 200,
): Promise<Candle[]> {
  try {
    return await fetchBinanceKlinesServer({ data: { symbol, timeframe, limit } });
  } catch {
    return [];
  }
}
