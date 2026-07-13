import type { TokenTimeframe } from "./mock-candles";
import type { Candle } from "./types";
import { atrSeries, SD_ZONE_TIMEFRAMES } from "./zones";

/**
 * True order blocks — the last opposing-close candle before a displacement:
 * the final down candle before conviction buying (demand) or the final up
 * candle before conviction selling (supply). A sibling detector to zones.ts'
 * base zones (tight shelf → departure), not a replacement: the two find
 * different POIs and both feed the unified POI read model. Display-plane
 * only: imported by no engine decision path (EDR 0013).
 *
 * Displacement thresholds reuse zones.ts' calibration deliberately — one set
 * of conviction constants, not two — and are unvalidated for OBs specifically
 * until a harness can measure them (pre-gate revisable).
 */

export interface OrderBlock {
  /** Bullish displacement → the opposing candle is a demand OB; mirror for supply. */
  kind: "demand" | "supply";
  /** Full range of the OB candle (body-only banding is an open EDR question). */
  priceLow: number;
  priceHigh: number;
  /** The opposing candle itself. */
  time: number;
  /** The displacement candle that validates it. */
  displacementTime: number;
  /** Displacement body / ATR14 — a quality read for ranking and display. */
  displacementAtr: number;
  /** The OB candle's wick took out the prior lookback extreme (sweep-origin OB). */
  sweptSwing: boolean;
}

export const OB_TIMEFRAMES: readonly TokenTimeframe[] = SD_ZONE_TIMEFRAMES;

/** Same conviction gate as zones.ts departures: body ≥ 1.15×ATR14, body ≥ 55% of range. */
const DISPLACEMENT_BODY_ATR = 1.15;
const DISPLACEMENT_BODY_SHARE = 0.55;
/** Indecision candles the walkback may skip between displacement and OB candle. */
export const OB_WALKBACK_MAX_SKIPS = 2;
/** A skippable candle's body cap — zones.ts' indecision threshold. */
const WALKBACK_BODY_ATR = 0.45;
/** Bars scanned behind the OB candle for the swept-extreme read. */
export const OB_SWEEP_LOOKBACK = 20;

const MAX_BLOCKS_PER_KIND = 2;

/** Every qualifying order block in the window, chronological by displacement time. */
export function detectOrderBlocks(candles: Candle[]): OrderBlock[] {
  if (candles.length < 30) return [];
  const atr = atrSeries(candles);
  const out: OrderBlock[] = [];

  for (let i = 15; i < candles.length; i++) {
    const ref = atr[i - 1];
    if (ref === null || ref <= 0) continue;

    const displacement = candles[i];
    const body = Math.abs(displacement.close - displacement.open);
    const range = displacement.high - displacement.low;
    if (body < ref * DISPLACEMENT_BODY_ATR || range <= 0 || body < range * DISPLACEMENT_BODY_SHARE)
      continue;

    const bullish = displacement.close > displacement.open;

    // Walk back to the last opposing-close candle, skipping only indecision
    // bars; a same-direction conviction candle means the leg was already
    // running — no order block, the displacement is continuation.
    let obIndex = -1;
    let skips = 0;
    for (let j = i - 1; j > 0 && skips <= OB_WALKBACK_MAX_SKIPS; j--) {
      const c = candles[j];
      const opposing = bullish ? c.close < c.open : c.close > c.open;
      if (opposing) {
        obIndex = j;
        break;
      }
      if (Math.abs(c.close - c.open) > ref * WALKBACK_BODY_ATR) break;
      skips++;
    }
    if (obIndex < 0) continue;

    const ob = candles[obIndex];
    const windowStart = Math.max(0, obIndex - OB_SWEEP_LOOKBACK);
    const prior = candles.slice(windowStart, obIndex);
    const sweptSwing =
      prior.length > 0 &&
      (bullish
        ? ob.low < Math.min(...prior.map((c) => c.low))
        : ob.high > Math.max(...prior.map((c) => c.high)));

    out.push({
      kind: bullish ? "demand" : "supply",
      priceLow: ob.low,
      priceHigh: ob.high,
      time: ob.time,
      displacementTime: displacement.time,
      displacementAtr: body / ref,
      sweptSwing,
    });
  }

  return out;
}

/**
 * Ranked display candidates (preferred = [0]): most recent displacement
 * first, stronger displacement breaking ties; overlapping same-kind
 * duplicates dropped, capped per kind — the same curation stance as
 * selectZones/selectFvgs.
 */
export function selectOrderBlocks(blocks: OrderBlock[]): OrderBlock[] {
  const ranked = [...blocks].sort(
    (a, b) => b.displacementTime - a.displacementTime || b.displacementAtr - a.displacementAtr,
  );
  const picked: OrderBlock[] = [];
  for (const block of ranked) {
    if (picked.filter((p) => p.kind === block.kind).length >= MAX_BLOCKS_PER_KIND) continue;
    const overlaps = picked.some(
      (p) =>
        p.kind === block.kind && block.priceLow <= p.priceHigh && block.priceHigh >= p.priceLow,
    );
    if (!overlaps) picked.push(block);
  }
  return picked;
}
