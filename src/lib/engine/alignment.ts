import { createServerFn } from "@tanstack/react-start";

import { computePivots } from "./analysis";
import { fetchBinanceKlinesDirect } from "./binance";
import { generateMockCandles, TOKEN_TIMEFRAMES } from "./mock-candles";
import { evaluateSignal } from "./quant";
import type { TokenTimeframe } from "./mock-candles";
import type { TradeDecision, TradeDirection } from "./quant";

export interface TimeframeAlignmentEntry {
  timeframe: TokenTimeframe;
  direction: TradeDirection;
  decision: TradeDecision;
}

function evaluateTimeframes(
  candlesByTimeframe: Array<[TokenTimeframe, ReturnType<typeof generateMockCandles>]>,
  symbol: string,
): TimeframeAlignmentEntry[] {
  return candlesByTimeframe.map(([timeframe, candles]) => {
    const evaluation = evaluateSignal(symbol, candles, computePivots(candles));
    return { timeframe, direction: evaluation.direction, decision: evaluation.decision };
  });
}

export function buildDemoAlignment(symbol: string): TimeframeAlignmentEntry[] {
  const ticker = symbol.toUpperCase();
  return evaluateTimeframes(
    TOKEN_TIMEFRAMES.map((timeframe) => [timeframe, generateMockCandles(ticker, timeframe)]),
    ticker,
  );
}

const alignmentCache = new Map<string, { at: number; data: TimeframeAlignmentEntry[] }>();
const ALIGNMENT_TTL_MS = 60_000;

async function computeAlignment(symbol: string): Promise<TimeframeAlignmentEntry[]> {
  const ticker = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!ticker) return [];

  const now = Date.now();
  const cached = alignmentCache.get(ticker);
  if (cached && now - cached.at < ALIGNMENT_TTL_MS) return cached.data;

  const series = await Promise.all(
    TOKEN_TIMEFRAMES.map(async (timeframe) => {
      const candles = await fetchBinanceKlinesDirect({ symbol: ticker, timeframe, limit: 200 });
      return [timeframe, candles.length > 0 ? candles : generateMockCandles(ticker, timeframe)] as [
        TokenTimeframe,
        ReturnType<typeof generateMockCandles>,
      ];
    }),
  );

  const data = evaluateTimeframes(series, ticker);
  alignmentCache.set(ticker, { at: now, data });
  return data;
}

export const fetchTimeframeAlignmentServer = createServerFn({ method: "GET" })
  .validator((data: { symbol: string }) => ({
    symbol: typeof data?.symbol === "string" ? data.symbol : "",
  }))
  .handler(async ({ data }) => computeAlignment(data.symbol));

/** Client-facing helper: server evaluation, falling back to the deterministic demo build. */
export async function fetchTimeframeAlignment(symbol: string): Promise<TimeframeAlignmentEntry[]> {
  try {
    return await fetchTimeframeAlignmentServer({ data: { symbol } });
  } catch {
    return buildDemoAlignment(symbol);
  }
}
