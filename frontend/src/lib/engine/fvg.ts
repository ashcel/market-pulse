import type { TokenTimeframe } from "./mock-candles";
import type { Candle } from "./types";
import { atrSeries, SD_ZONE_TIMEFRAMES } from "./zones";

/**
 * Fair value gaps (G5) — the 3-candle imbalance: bullish when
 * `low[i] > high[i-2]`, the gap being `[high[i-2], low[i]]`; bearish mirror.
 * Detection is a single forward pass over closed bars, so a gap confirmed at
 * bar `i` uses only bars ≤ `i` — replay-safe by construction.
 *
 * Deliberately detection-only: filled/inverted state (iFVG, G6) is the
 * lifecycle deriver's job, not this module's — an FVG's identity is fixed at
 * formation, what happened to it since is a replay question. Display-plane
 * only for now: read by no verdict, no selectPoi input (EDR 0012).
 */

export interface Fvg {
  /** A bullish gap is a demand-side POI; bearish mirror. */
  kind: "bullish" | "bearish";
  gapLow: number;
  gapHigh: number;
  /** The displacement (middle) candle that left the imbalance. */
  time: number;
  /** The third candle — the closed bar that confirms the gap exists. */
  confirmTime: number;
  /** Gap height / ATR14 as of the bar before the displacement (G7's input); null when ATR is unavailable. */
  sizeAtr: number | null;
  /** Gap height as % of the gap's mid price. */
  sizePct: number;
}

// FVGs inherit the supply/demand timeframe gate: on 15M/30M the 3-candle
// imbalance fires constantly on noise. Widening to intraday TFs is a display
// decision to revisit once the lifecycle view exists.
export const FVG_TIMEFRAMES: readonly TokenTimeframe[] = SD_ZONE_TIMEFRAMES;

/**
 * G7 normalized size floor: gaps smaller than this fraction of ATR14 are
 * spread noise, not imbalance. Applied only when ATR is measurable — a gap in
 * the first bars of a window is kept with `sizeAtr: null` rather than judged
 * by a reference that doesn't exist yet.
 */
export const MIN_FVG_SIZE_ATR = 0.25;

const MAX_FVGS_PER_KIND = 3;

/** Every qualifying gap in the window, chronological by confirm time. */
export function detectFvgs(candles: Candle[]): Fvg[] {
  if (candles.length < 3) return [];
  const atr = atrSeries(candles);
  const out: Fvg[] = [];

  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2];
    const third = candles[i];
    const bullish = third.low > first.high;
    const bearish = third.high < first.low;
    if (!bullish && !bearish) continue;

    const gapLow = bullish ? first.high : third.high;
    const gapHigh = bullish ? third.low : first.low;
    const gap = gapHigh - gapLow;
    if (gap <= 0) continue;

    // Reference ATR predates the displacement candle so the displacement's
    // own true range can't inflate the yardstick (same stance as zones.ts).
    const ref = atr[i - 2];
    const sizeAtr = ref !== null && ref > 0 ? gap / ref : null;
    if (sizeAtr !== null && sizeAtr < MIN_FVG_SIZE_ATR) continue;

    const mid = (gapLow + gapHigh) / 2;
    out.push({
      kind: bullish ? "bullish" : "bearish",
      gapLow,
      gapHigh,
      time: candles[i - 1].time,
      confirmTime: third.time,
      sizeAtr,
      sizePct: mid > 0 ? (gap / mid) * 100 : 0,
    });
  }

  return out;
}

/**
 * The display-ready subset: ranked candidates (preferred = [0]) — most recent
 * first, larger gap breaking ties — with overlapping same-kind duplicates
 * dropped and a cap per kind, mirroring how zones.ts curates bands.
 */
export function selectFvgs(fvgs: Fvg[]): Fvg[] {
  const ranked = [...fvgs].sort(
    (a, b) => b.confirmTime - a.confirmTime || (b.sizeAtr ?? 0) - (a.sizeAtr ?? 0),
  );
  const picked: Fvg[] = [];
  for (const fvg of ranked) {
    if (picked.filter((p) => p.kind === fvg.kind).length >= MAX_FVGS_PER_KIND) continue;
    const overlaps = picked.some(
      (p) => p.kind === fvg.kind && fvg.gapLow <= p.gapHigh && fvg.gapHigh >= p.gapLow,
    );
    if (!overlaps) picked.push(fvg);
  }
  return picked;
}
