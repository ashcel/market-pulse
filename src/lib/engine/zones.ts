import type { TokenTimeframe } from "./mock-candles";
import type { Candle } from "./types";

/**
 * A true demand/supply base: a tight cluster of indecision candles followed
 * by an explosive departure. Demand = bullish departure, supply = bearish.
 */
export interface BaseZone {
  kind: "demand" | "supply";
  priceLow: number;
  priceHigh: number;
  /** First candle of the base. */
  startTime: number;
  /** The departure candle that confirmed the zone. */
  endTime: number;
  /** "fresh" = never revisited since forming; "tested" = revisited once and held. */
  freshness: "fresh" | "tested";
}

// Base detection needs each candle to summarize a meaningful auction. On 15M/30M
// a 200-bar window is 2–4 days of intraday churn — "bases" there are mostly
// noise, so supply/demand zones are only computed on these timeframes.
export const SD_ZONE_TIMEFRAMES: readonly TokenTimeframe[] = ["1H", "4H", "1D", "1W"];

const MAX_BASE_CANDLES = 5;
const MAX_ZONES_PER_KIND = 2;

/** Rolling simple-average true range; null until `length` bars are available. */
export function atrSeries(candles: Candle[], length = 14): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    sum += tr;
    if (i >= length) {
      const first = candles[i - length];
      const firstPrev = i - length > 0 ? candles[i - length - 1].close : first.close;
      sum -= Math.max(
        first.high - first.low,
        Math.abs(first.high - firstPrev),
        Math.abs(first.low - firstPrev),
      );
    }
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/** A detected base before the freshness replay — what the lifecycle view enumerates. */
export interface BaseZoneCandidate extends Omit<BaseZone, "freshness"> {
  /** Index of the departure candle; post-formation replays start after it. */
  departureIndex: number;
}

/**
 * Every base the detector stands behind geometrically, before the freshness
 * filter drops traded-through/consumed ones. `computeBaseZones` is exactly
 * candidates → zoneFreshness → selectZones (characterization-pinned); the
 * lifecycle view consumes candidates directly so terminal zones stay visible.
 */
export function computeBaseZoneCandidates(candles: Candle[]): BaseZoneCandidate[] {
  if (candles.length < 30) return [];
  const atr = atrSeries(candles);
  const zones: BaseZoneCandidate[] = [];

  for (let i = 15; i < candles.length; i++) {
    const ref = atr[i - 1];
    if (ref === null || ref <= 0) continue;

    // Conviction departure: the body dwarfs recent true range and the candle
    // isn't mostly wick.
    const departure = candles[i];
    const body = Math.abs(departure.close - departure.open);
    const range = departure.high - departure.low;
    if (body < ref * 1.15 || range <= 0 || body < range * 0.55) continue;

    // Walk back over indecision candles to collect the base.
    let start = i - 1;
    while (
      start > 0 &&
      i - start <= MAX_BASE_CANDLES &&
      Math.abs(candles[start].close - candles[start].open) <= ref * 0.45
    ) {
      start--;
    }
    const base = candles.slice(start + 1, i);
    if (base.length === 0 || base.length > MAX_BASE_CANDLES) continue;

    // The base must be a tight shelf, not a volatile chop cluster.
    const baseHigh = Math.max(...base.map((c) => c.high));
    const baseLow = Math.min(...base.map((c) => c.low));
    if (baseHigh - baseLow > ref * 1.4) continue;

    // Distal edge = full wick extreme; proximal edge = candle bodies (with a
    // minimum thickness so single-doji bases still draw as a band).
    const bullish = departure.close > departure.open;
    const bounds = bullish
      ? {
          kind: "demand" as const,
          priceLow: baseLow,
          priceHigh: Math.max(...base.map((c) => Math.max(c.open, c.close)), baseLow + ref * 0.2),
        }
      : {
          kind: "supply" as const,
          priceHigh: baseHigh,
          priceLow: Math.min(...base.map((c) => Math.min(c.open, c.close)), baseHigh - ref * 0.2),
        };

    zones.push({
      ...bounds,
      startTime: candles[start + 1].time,
      endTime: departure.time,
      departureIndex: i,
    });
  }

  return zones;
}

export function computeBaseZones(candles: Candle[]): BaseZone[] {
  const zones: BaseZone[] = [];
  for (const candidate of computeBaseZoneCandidates(candles)) {
    const freshness = zoneFreshness(
      candles,
      candidate.departureIndex + 1,
      candidate.kind,
      candidate.priceLow,
      candidate.priceHigh,
    );
    if (freshness === null) continue;
    const { departureIndex: _departureIndex, ...zone } = candidate;
    zones.push({ ...zone, freshness });
  }
  return selectZones(zones);
}

/**
 * Replays price action after the departure. Returns null when the zone is
 * invalidated: a close beyond the distal edge (traded through) or a second
 * revisit (consumed).
 */
function zoneFreshness(
  candles: Candle[],
  fromIndex: number,
  kind: BaseZone["kind"],
  low: number,
  high: number,
): BaseZone["freshness"] | null {
  let touches = 0;
  // Price often lingers at the proximal edge right after departure — that
  // initial contact is part of forming, not a test.
  let inside = true;
  for (let k = fromIndex; k < candles.length; k++) {
    const c = candles[k];
    if (kind === "demand" ? c.close < low : c.close > high) return null;
    const touching = kind === "demand" ? c.low <= high : c.high >= low;
    if (touching && !inside) {
      touches++;
      if (touches >= 2) return null;
    }
    inside = touching;
  }
  return touches === 0 ? "fresh" : "tested";
}

/**
 * Candidate curation under `selectZones`' exact rules, for the lifecycle
 * ledger. Curating before the freshness filter can pick a recently-dead base
 * over an older live one `computeBaseZones` would keep — a display-plane
 * divergence the lifecycle view accepts to show terminal zones at all.
 */
export function selectZoneCandidates(candidates: BaseZoneCandidate[]): BaseZoneCandidate[] {
  return selectZones(candidates);
}

/** Most recent zones win; overlapping same-kind duplicates and overflow are dropped. */
function selectZones<T extends Omit<BaseZone, "freshness">>(zones: T[]): T[] {
  const picked: T[] = [];
  for (const zone of [...zones].sort((a, b) => b.endTime - a.endTime)) {
    if (picked.filter((p) => p.kind === zone.kind).length >= MAX_ZONES_PER_KIND) continue;
    const overlaps = picked.some(
      (p) => p.kind === zone.kind && zone.priceLow <= p.priceHigh && zone.priceHigh >= p.priceLow,
    );
    if (!overlaps) picked.push(zone);
  }
  return picked.sort((a, b) => a.startTime - b.startTime);
}
