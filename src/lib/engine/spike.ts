import type { Candle } from "./types";

/**
 * Vertical-spike + abnormal-volume + immediate-rejection detection — a
 * discovery/attention signal, NOT a trading decision. It answers "a pair just
 * lurched and got slapped back, look now", the same way `discovery.ts` answers
 * "there is action here". Deliberately outside the trading engine: it touches
 * no decision/trigger semantics, no ENGINE_VERSION, and writes no forward-test
 * record, so its thresholds can be tuned freely without restarting the
 * evidence clock.
 *
 * The pattern is a single-candle event on a short timeframe (15m by default):
 * one bar whose range is abnormally large vs its recent history, printed on
 * abnormally heavy volume, that closes with a dominant opposing wick — i.e.
 * the move was rejected within the bar ("immediate"). An up-spike rejected is
 * an exhaustion tell; a down-spike rejected is an absorption tell — but this
 * module never says long/short. It points attention; the token page's real
 * engine gives the verdict.
 *
 * Detection uses only closed bars and a strictly *trailing* reference window
 * (the bars before the spike), so a spike confirmed at bar `i` never reads
 * from bars > `i` — replay-safe by construction, like `fvg.ts`.
 */

export interface SpikeEvent {
  /** Direction of the spike that was rejected (up-spike = pushed up then faded). */
  direction: "up" | "down";
  /** The spike bar's open time. */
  time: number;
  /** Bars from the end of the series (0 = latest closed bar). Callers gate recency. */
  barsAgo: number;
  /** Bar range ÷ trailing mean range — how vertical the move was. */
  rangeMult: number;
  /** Bar volume ÷ trailing mean volume — how abnormal the participation was. */
  volumeMult: number;
  /** Rejection wick as a fraction of the bar range (0..1) — how hard it was slapped back. */
  rejectionFraction: number;
  /** Bar range as % of its mid price — the raw size of the lurch. */
  rangePct: number;
  /** Non-directional attention line ("Sharp up-spike rejected on 3.4× volume"). */
  reason: string;
}

/** Trailing bars used as the "normal" reference for range and volume. */
export const REF_WINDOW = 20;
/** Bar range must be at least this multiple of the trailing mean range. */
export const SPIKE_RANGE_MULT = 2.5;
/** Bar volume must be at least this multiple of the trailing mean volume. */
export const SPIKE_VOLUME_MULT = 3;
/** The rejection wick must be at least this fraction of the bar range. */
export const REJECT_FRACTION = 0.6;
/**
 * Only the last N closed bars count as "immediate" — a spike-and-reject three
 * bars ago is history, not a current condition worth alerting on.
 */
export const RECENCY_WINDOW = 2;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Evaluates one candidate bar `i` against its trailing reference window.
 * Returns the event if it clears all three gates, else null. `prevClose` is
 * the previous bar's close — where the market was before the lurch.
 */
function evaluateBar(candles: Candle[], i: number): SpikeEvent | null {
  const bar = candles[i];
  const range = bar.high - bar.low;
  if (range <= 0) return null;

  const ref = candles.slice(i - REF_WINDOW, i);
  const meanRange = mean(ref.map((c) => c.high - c.low));
  const meanVolume = mean(ref.map((c) => c.volume));
  if (meanRange <= 0 || meanVolume <= 0) return null;

  const rangeMult = range / meanRange;
  const volumeMult = bar.volume / meanVolume;
  if (rangeMult < SPIKE_RANGE_MULT || volumeMult < SPIKE_VOLUME_MULT) return null;

  // Rejection is read from the dominant wick: an up-spike leaves its rejection
  // as the upper wick (pushed high, closed back down), a down-spike as the
  // lower wick. The larger wick names the direction that got rejected.
  const bodyHigh = Math.max(bar.open, bar.close);
  const bodyLow = Math.min(bar.open, bar.close);
  const upperWick = bar.high - bodyHigh;
  const lowerWick = bodyLow - bar.low;
  const direction: "up" | "down" = upperWick >= lowerWick ? "up" : "down";
  const rejectionFraction = (direction === "up" ? upperWick : lowerWick) / range;
  if (rejectionFraction < REJECT_FRACTION) return null;

  const mid = (bar.high + bar.low) / 2;
  const rangePct = mid > 0 ? (range / mid) * 100 : 0;

  return {
    direction,
    time: bar.time,
    barsAgo: candles.length - 1 - i,
    rangeMult,
    volumeMult,
    rejectionFraction,
    rangePct,
    reason: `Sharp ${direction}-spike rejected on ${volumeMult.toFixed(1)}× volume`,
  };
}

/**
 * The most recent spike-and-reject within the recency window, or null. Scans
 * newest-first and returns the first qualifying bar, so `barsAgo` is minimal.
 * Needs at least `REF_WINDOW + 1` bars to have any trailing reference.
 */
export function detectSpike(candles: Candle[]): SpikeEvent | null {
  const last = candles.length - 1;
  const oldest = Math.max(REF_WINDOW, last - RECENCY_WINDOW + 1);
  for (let i = last; i >= oldest; i--) {
    const event = evaluateBar(candles, i);
    if (event) return event;
  }
  return null;
}
