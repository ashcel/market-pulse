import { BINANCE_INTERVALS } from "@/lib/engine/binance";
import { generateMockCandles } from "@/lib/engine/mock-candles";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

const INTERVAL_TO_TIMEFRAME = new Map<string, TokenTimeframe>(
  Object.entries(BINANCE_INTERVALS).map(([tf, interval]) => [interval, tf as TokenTimeframe]),
);

function candlesToKlineRows(candles: ReturnType<typeof generateMockCandles>): unknown[] {
  return candles.map((c) => [
    c.time * 1000,
    String(c.open),
    String(c.high),
    String(c.low),
    String(c.close),
    String(c.volume),
    c.time * 1000 + 999,
    "0",
    0,
    "0",
    "0",
    "0",
  ]);
}

/**
 * Deterministic stand-in for Binance's REST API: routes /klines and
 * /ticker/price to `generateMockCandles` keyed by the requested symbol +
 * interval, so `computeAlignment`/`fetchSessionLevels` (the exact functions
 * both the worker and the UI's server fns call) see the same fixture candles
 * a real fetch would have returned. Shared by every worker/UI parity test so
 * they all see one fixture, not lookalike reimplementations.
 */
export function installFakeBinance(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const symbolParam = url.searchParams.get("symbol") ?? "";
    const ticker = symbolParam.replace(/USDT$/, "");

    if (url.pathname.endsWith("/klines")) {
      const interval = url.searchParams.get("interval") ?? "";
      const timeframe = INTERVAL_TO_TIMEFRAME.get(interval);
      const limit = Number(url.searchParams.get("limit") ?? "200");
      if (!timeframe) return new Response("[]", { status: 200 });
      const candles = generateMockCandles(ticker, timeframe, limit);
      return new Response(JSON.stringify(candlesToKlineRows(candles)), { status: 200 });
    }
    if (url.pathname.endsWith("/ticker/price")) {
      return new Response(JSON.stringify({ price: "100" }), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
}
