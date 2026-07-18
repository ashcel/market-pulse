// Candle Preprocessor — compress raw OHLCV candles into structured LLM
// context. Ported from tradereview's lib/services/candle-preprocessor.ts,
// retargeted at this repo's `Candle` shape (numbers already, `.time` in
// seconds rather than a string `timestamp`/`ms` field) — no parseFloat
// gymnastics needed.

import type { Candle } from "@/lib/engine/types";

import type { CandleContext, ReviewTradeSide } from "./types";

// Compute a simple ATR (Average True Range) over `period` candles.
export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Detect dominant structure: count higher-highs/lower-lows over the last N candles.
export function detectTrend(candles: Candle[]): {
  direction: "Bullish" | "Bearish" | "Ranging";
  since: string;
} {
  if (candles.length < 4) return { direction: "Ranging", since: "" };

  const last = candles.slice(-12); // analyse last 12 candles
  let higherHighs = 0;
  let lowerLows = 0;

  for (let i = 1; i < last.length; i++) {
    const prevHigh = last[i - 1].high;
    const currHigh = last[i].high;
    const prevLow = last[i - 1].low;
    const currLow = last[i].low;

    if (currHigh > prevHigh) higherHighs++;
    else if (currHigh < prevHigh) higherHighs--;

    if (currLow < prevLow) lowerLows++;
    else if (currLow > prevLow) lowerLows--;
  }

  const inflectionTime = new Date(last[0].time * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (higherHighs > 3) return { direction: "Bullish", since: inflectionTime };
  if (lowerLows > 3) return { direction: "Bearish", since: inflectionTime };
  return { direction: "Ranging", since: inflectionTime };
}

// Identify significant support / resistance pivots.
export function findKeyLevels(
  candles: Candle[],
  entryPrice: number,
): { support: number[]; resistance: number[] } {
  const support: number[] = [];
  const resistance: number[] = [];

  // Identify swing highs and lows from the last 30 candles.
  const window = candles.slice(-30);
  for (let i = 2; i < window.length - 2; i++) {
    const curr = window[i];
    const prevPrev = window[i - 2];
    const prev = window[i - 1];
    const next = window[i + 1];
    const nextNext = window[i + 2];

    const { high, low } = curr;

    const isSwingHigh =
      high > prevPrev.high && high > prev.high && high > next.high && high > nextNext.high;
    const isSwingLow = low < prevPrev.low && low < prev.low && low < next.low && low < nextNext.low;

    if (isSwingHigh) resistance.push(Number(high.toFixed(4)));
    if (isSwingLow) support.push(Number(low.toFixed(4)));
  }

  // Deduplicate within 0.2% of each other and keep closest to entry.
  const dedup = (levels: number[]) =>
    levels
      .filter((l, idx, arr) =>
        arr.every((other, j) => j === idx || Math.abs(l - other) / l > 0.002),
      )
      .sort((a, b) => Math.abs(a - entryPrice) - Math.abs(b - entryPrice))
      .slice(0, 3);

  return { support: dedup(support), resistance: dedup(resistance) };
}

// Detect if there was a liquidity sweep before entry (wick through prior extreme).
export function detectLiquiditySweep(
  beforeCandles: Candle[],
  _entryPrice: number,
): { swept: boolean; direction: "above" | "below" | null } {
  if (beforeCandles.length < 5) return { swept: false, direction: null };

  const lookback = beforeCandles.slice(-10);
  const priorHighs = lookback.map((c) => c.high);
  const priorLows = lookback.map((c) => c.low);

  const priorHigh = Math.max(...priorHighs.slice(0, -1));
  const priorLow = Math.min(...priorLows.slice(0, -1));

  const lastBefore = lookback[lookback.length - 1];
  const { high: lastHigh, low: lastLow, close: lastClose } = lastBefore;

  // Sweep above: wick exceeded prior high but closed back below it.
  if (lastHigh > priorHigh && lastClose < priorHigh) {
    return { swept: true, direction: "above" };
  }

  // Sweep below: wick broke prior low but closed back above it.
  if (lastLow < priorLow && lastClose > priorLow) {
    return { swept: true, direction: "below" };
  }

  return { swept: false, direction: null };
}

const EMPTY_CONTEXT: CandleContext = {
  trend_summary: "No candle data available",
  volatility_summary: "No candle data available",
  structure_summary: "No candle data available",
  sweep_detected: false,
  sweep_direction: null,
  key_levels: { support: [], resistance: [] },
  entry_context: "No context available",
  exit_context: "No context available",
};

/** All-"unavailable" context used when candle fetch fails — never blocks review generation. */
export function unavailableCandleContext(): CandleContext {
  return {
    trend_summary: "Candle data unavailable",
    volatility_summary: "Candle data unavailable",
    structure_summary: "Candle data unavailable",
    sweep_detected: false,
    sweep_direction: null,
    key_levels: { support: [], resistance: [] },
    entry_context: "No candle context available",
    exit_context: "No candle context available",
  };
}

export function preprocessCandles(
  beforeCandles: Candle[],
  duringCandles: Candle[],
  afterCandles: Candle[],
  entryPrice: number,
  exitPrice: number,
  side: ReviewTradeSide,
): CandleContext {
  const allCandles = [...beforeCandles, ...duringCandles, ...afterCandles];
  if (allCandles.length === 0) {
    return EMPTY_CONTEXT;
  }

  // --- Trend ---
  const trend = detectTrend(beforeCandles.length > 0 ? beforeCandles : allCandles);
  const trendLabel =
    trend.direction === "Bullish"
      ? `Bullish structure, higher highs forming since ${trend.since}`
      : trend.direction === "Bearish"
        ? `Bearish structure, lower highs since ${trend.since}`
        : `Ranging / no clear trend direction`;

  // --- Volatility ---
  const atrNow = computeATR(allCandles, 14);
  const atrBaseline = computeATR(allCandles.slice(0, Math.floor(allCandles.length * 0.7)), 14);
  const atrRatio = atrBaseline > 0 ? atrNow / atrBaseline : 1;

  let volatilityLabel: string;
  if (atrRatio >= 2.5)
    volatilityLabel = `Extreme volatility — ATR ${atrRatio.toFixed(1)}x above baseline`;
  else if (atrRatio >= 1.5)
    volatilityLabel = `Elevated volatility — ATR ${atrRatio.toFixed(1)}x above baseline`;
  else if (atrRatio <= 0.6)
    volatilityLabel = `Low volatility / compression — ATR ${atrRatio.toFixed(1)}x of baseline`;
  else volatilityLabel = `Normal volatility — ATR near baseline (${atrRatio.toFixed(1)}x)`;

  // --- Structure ---
  const keyLevels = findKeyLevels(
    beforeCandles.length > 0 ? beforeCandles : allCandles,
    entryPrice,
  );

  const nearestResistance = keyLevels.resistance[0];
  const nearestSupport = keyLevels.support[0];

  let structureLabel = "No clear structure zone identified near entry";
  if (nearestResistance && Math.abs(nearestResistance - entryPrice) / entryPrice < 0.01) {
    structureLabel = `Entry near key resistance at $${nearestResistance.toLocaleString()}`;
  } else if (nearestSupport && Math.abs(nearestSupport - entryPrice) / entryPrice < 0.01) {
    structureLabel = `Entry near key support at $${nearestSupport.toLocaleString()}`;
  } else if (nearestResistance) {
    structureLabel = `Trading below resistance at $${nearestResistance.toLocaleString()}`;
  } else if (nearestSupport) {
    structureLabel = `Trading above support at $${nearestSupport.toLocaleString()}`;
  }

  // --- Liquidity Sweep ---
  const sweep = detectLiquiditySweep(beforeCandles, entryPrice);

  // --- Entry Context ---
  let entryContext = "Entry occurred with no notable pre-entry candle signal";
  if (sweep.swept) {
    const candlesAfterSweep = duringCandles.length > 0 ? duringCandles.length : 1;
    entryContext = `Entry occurred ${candlesAfterSweep} candle(s) after liquidity sweep ${sweep.direction}`;
  } else if (trend.direction !== "Ranging") {
    const aligned =
      (side === "LONG" && trend.direction === "Bullish") ||
      (side === "SHORT" && trend.direction === "Bearish");
    entryContext = aligned
      ? `Entry aligned with ${trend.direction.toLowerCase()} structure`
      : `Entry against ${trend.direction.toLowerCase()} structure (counter-trend)`;
  }

  // --- Exit Context ---
  let exitContext = "No exit data available";
  if (exitPrice > 0 && duringCandles.length > 0) {
    const highDuring = Math.max(...duringCandles.map((c) => c.high));
    const lowDuring = Math.min(...duringCandles.map((c) => c.low));
    const range = highDuring - lowDuring;

    if (range > 0) {
      const exitPosition = (exitPrice - lowDuring) / range;
      if (exitPosition > 0.8)
        exitContext = "Exit occurred near the high of the trade range (well-timed exit)";
      else if (exitPosition < 0.2) exitContext = "Exit occurred near the low of the trade range";
      else exitContext = "Exit occurred mid-range, before reaching the full extension";
    }

    if (nearestResistance && Math.abs(exitPrice - nearestResistance) / nearestResistance < 0.005) {
      exitContext += " — exited at resistance level";
    }
  }

  return {
    trend_summary: trendLabel,
    volatility_summary: volatilityLabel,
    structure_summary: structureLabel,
    sweep_detected: sweep.swept,
    sweep_direction: sweep.direction,
    key_levels: keyLevels,
    entry_context: entryContext,
    exit_context: exitContext,
  };
}
