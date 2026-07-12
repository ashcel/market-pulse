/**
 * The leg-scoped fine-tier anchor — the challenger H-LB trigger's one piece
 * of new logic (research/phase3-spike.md). Frozen and shared by every arm
 * that uses H-LB in this spike (the gated comparison and the fixture-sanity
 * check both import this module — one definition, no drift).
 *
 * Phase 2 found that the naive "most recent fine high" anchor fires on every
 * micro-reclaim (8+ events on TRX) and picks the wrong level (analysis in
 * phase2-spike.md, "the i.mss finding"). The fix, mirroring the leg-scoping
 * discipline `strength.ts` already uses for swing strength (EDR 0004 —
 * judge a swing by its own counter-leg, not by scanning every later swing):
 *
 *   1. The origin of the current counter-trend leg is the fine pivot that
 *      began it — the highest fine high before the run of lower lows that
 *      is currently in progress (mirror: lowest fine low before a run of
 *      higher highs, for a short bias).
 *   2. The trigger fires on the first CLOSE through that level — not any
 *      subsequent fine high on the same shelf.
 *   3. The anchor is never mutated in place. Every call recomputes it from
 *      the current bar-limited prefix, the same replay-safe pattern
 *      `computeMarketStructure` and `deriveSwingStrength` already use. A
 *      "reset" is simply what a fresh computation returns once a new leg
 *      origin has printed (a fine pivot can form intrabar above the old
 *      anchor via its wick, without a bar CLOSING through it — the fine
 *      pivot commits at wick extremes while the trigger fires on closes, so
 *      a higher fine high can supersede the anchor before anything fires).
 */

import { computeMarketStructure } from "../../../src/lib/engine/structure";
import type { SwingPoint } from "../../../src/lib/engine/structure";
import type { Candle, PivotPoint } from "../../../src/lib/engine/types";

/** computePivots with an explicit window — mirrors phase2-spike's helper. */
export function pivotsWithWindow(candles: Candle[], k: number): PivotPoint[] {
  const n = candles.length;
  if (n < 2 * k + 1) return [];
  const out: PivotPoint[] = [];
  for (let i = k; i < n - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high || (candles[j].high === candles[i].high && j < i))
        isHigh = false;
      if (candles[j].low < candles[i].low || (candles[j].low === candles[i].low && j < i))
        isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isLow) out.push({ time: candles[i].time, price: candles[i].low, kind: "low" });
    if (isHigh) out.push({ time: candles[i].time, price: candles[i].high, kind: "high" });
  }
  return out;
}

/**
 * Identify the originating swing of the current internal counter-trend leg.
 *
 * For `bias: "long"` the counter-trend leg is a decline: a run of fine lows
 * each labeled LL (a new lower low) ending at the most recent fine low. The
 * origin is the fine HIGH immediately preceding the run's earliest LL in the
 * alternating swing sequence — the top the decline broke away from. Mirror
 * for `bias: "short"` (a run of HH highs; origin is the low before it).
 *
 * Returns null when the internal tier is not currently in a counter-trend
 * run against `bias` — there is no shift in progress to anchor, exactly the
 * state where the CHoCH incumbent also has nothing to report (its `trend`
 * already agrees, or no swing has broken it yet).
 */
export function findLegOrigin(fineSwings: SwingPoint[], bias: "long" | "short"): SwingPoint | null {
  const runLabel = bias === "long" ? "LL" : "HH";
  const counterKind = bias === "long" ? "low" : "high";
  const anchorKind = bias === "long" ? "high" : "low";

  const counters = fineSwings.filter((s) => s.kind === counterKind);
  if (counters.length === 0) return null;

  // Walk backward while the run of continuation labels holds; stop at the
  // first counter swing that does NOT extend it (or the series start).
  let i = counters.length - 1;
  if (counters[i].label !== runLabel) return null; // not currently counter-trend — no leg to anchor
  while (i > 0 && counters[i - 1].label === runLabel) i--;
  const runStart = counters[i];

  const idx = fineSwings.indexOf(runStart);
  for (let j = idx - 1; j >= 0; j--) {
    if (fineSwings[j].kind === anchorKind) return fineSwings[j];
  }
  return null;
}

export interface HlbRead {
  /** The leg-scoped anchor as-of this prefix; null when no counter-trend leg is in progress. */
  origin: SwingPoint | null;
  /** True when the prefix's last bar CLOSED through `origin` (fired this bar). */
  fired: boolean;
}

/**
 * The full H-LB read for one bar-limited prefix: fine-tier structure on the
 * SAME chart as the trigger fires on (never the context chart — that is the
 * "nested" hypothesis phase2 already spiked and rejected), the leg-scoped
 * anchor, and whether this bar's close breaks it.
 *
 * `fineWindow` is the caller's `max(2, floor(pivotWindow(prefix.length)/2))`
 * — passed in rather than recomputed here so callers can share it with their
 * own caching (see phase2-spike/run-spike.ts's `StructureCache` pattern).
 */
export function readHlb(prefix: Candle[], fineWindow: number, bias: "long" | "short"): HlbRead {
  const structure = computeMarketStructure(pivotsWithWindow(prefix, fineWindow));
  const origin = findLegOrigin(structure.swings, bias);
  if (!origin) return { origin: null, fired: false };
  const close = prefix[prefix.length - 1].close;
  const fired = bias === "long" ? close > origin.price : close < origin.price;
  return { origin, fired };
}

/** Stable dedup key for an origin — same origin across bars must not re-fire. */
export function originKey(origin: SwingPoint): string {
  return `${origin.time}:${origin.kind}:${origin.price}`;
}

/**
 * The frozen stop rule's H-LB value: "the internal tier's most recent
 * opposite-kind swing before the trigger" — for H-LB that is the fine swing
 * that anchors the bottom (long) or top (short) of the counter-trend leg the
 * origin began, i.e. the most recent fine counter-kind swing strictly before
 * the origin's own time... no: before the TRIGGER bar, on the same fine
 * structure. Mirrors the CHoCH arm's `stopSwing` computation exactly, just
 * read from the fine tier instead of the standard one.
 */
export function findLegStop(
  fineSwings: SwingPoint[],
  bias: "long" | "short",
  beforeTime: number,
): SwingPoint | null {
  const stopKind = bias === "long" ? "low" : "high";
  for (let j = fineSwings.length - 1; j >= 0; j--) {
    const s = fineSwings[j];
    if (s.kind === stopKind && s.time < beforeTime) return s;
  }
  return null;
}
