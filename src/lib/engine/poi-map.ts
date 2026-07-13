import { classifyPrice, type DealingRange, type PricePosition } from "./equilibrium";
import type { Fvg } from "./fvg";
import type { OrderBlock } from "./orderblocks";
import type { Candle } from "./types";
import type { BaseZone } from "./zones";

/**
 * The unified POI read model — base zones, order blocks, and FVGs on one
 * ledger, each carrying its premium/discount position and state. This is the
 * "Phase 3" seam poi.ts names: `UnifiedPoi` deliberately carries exactly the
 * fields `selectPoi` reads from a `BaseZone` (kind, priceLow/High, startTime,
 * state subsuming freshness), so the eventual gated cutover only widens
 * selectPoi's parameter to a structural interface both types satisfy —
 * consumers keep their shape.
 *
 * Until that pre-registered gate: **display-only**. selectPoi and
 * buildAnticipatoryPlan keep consuming `BaseZone[]`; nothing here is read by
 * any verdict, and the anticipatory/fill record stream is untouched
 * (EDR 0014). Overlapping POIs are listed, never merged — an OB inside its
 * base zone is two reads agreeing, and collapsing them would erase which
 * detector said what.
 */

export type PoiSource = "base-zone" | "order-block" | "fvg" | "ifvg";

/**
 * fresh/tested today (the zoneFreshness vocabulary); mitigated, invalidated,
 * and consumed arrive with the lifecycle deriver, which also retains terminal
 * POIs instead of dropping them.
 */
export type PoiState = "fresh" | "tested" | "mitigated" | "invalidated" | "consumed";

export interface UnifiedPoi {
  source: PoiSource;
  kind: "demand" | "supply";
  priceLow: number;
  priceHigh: number;
  /** Formation start — the zone base / OB candle / FVG displacement candle. */
  startTime: number;
  /** Formation confirmation — departure / displacement / third candle. */
  endTime: number;
  state: PoiState;
  /** Where the proximal edge sits in the dealing range; null without a range. */
  position: PricePosition | null;
  /** Normalized size where the detector measures one (FVGs); null otherwise. */
  sizeAtr: number | null;
}

/** The edge a resting limit fills at first: top of demand, bottom of supply. */
function proximalPrice(poi: Pick<UnifiedPoi, "kind" | "priceLow" | "priceHigh">): number {
  return poi.kind === "demand" ? poi.priceHigh : poi.priceLow;
}

const TERMINAL_STATES: readonly PoiState[] = ["invalidated", "consumed"];

/**
 * Post-formation touch scan — zoneFreshness' exact semantics, applied to OB
 * and FVG bands: null when traded through (close beyond the distal edge) or
 * revisited twice; fresh/tested otherwise. The initial linger at the band
 * right after formation is part of forming, not a test. Replaced by the
 * lifecycle deriver (which retains terminal states) in the next phase.
 */
function touchState(
  candles: Candle[],
  afterTime: number,
  kind: "demand" | "supply",
  low: number,
  high: number,
): Extract<PoiState, "fresh" | "tested"> | null {
  let touches = 0;
  let inside = true;
  for (const c of candles) {
    if (c.time <= afterTime) continue;
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
 * Every POI the detectors currently stand behind, chronological by formation
 * start. Zones arrive with their freshness already replay-derived; OBs and
 * FVGs get the same touch scan here.
 */
export function buildPoiMap(
  zones: BaseZone[],
  blocks: OrderBlock[],
  fvgs: Fvg[],
  candles: Candle[],
  range: DealingRange | null,
): UnifiedPoi[] {
  const pois: UnifiedPoi[] = [];

  for (const zone of zones) {
    pois.push({
      source: "base-zone",
      kind: zone.kind,
      priceLow: zone.priceLow,
      priceHigh: zone.priceHigh,
      startTime: zone.startTime,
      endTime: zone.endTime,
      state: zone.freshness,
      position: null,
      sizeAtr: null,
    });
  }

  for (const block of blocks) {
    const state = touchState(
      candles,
      block.displacementTime,
      block.kind,
      block.priceLow,
      block.priceHigh,
    );
    if (state === null) continue;
    pois.push({
      source: "order-block",
      kind: block.kind,
      priceLow: block.priceLow,
      priceHigh: block.priceHigh,
      startTime: block.time,
      endTime: block.displacementTime,
      state,
      position: null,
      sizeAtr: null,
    });
  }

  for (const fvg of fvgs) {
    const kind = fvg.kind === "bullish" ? "demand" : "supply";
    const state = touchState(candles, fvg.confirmTime, kind, fvg.gapLow, fvg.gapHigh);
    if (state === null) continue;
    pois.push({
      source: "fvg",
      kind,
      priceLow: fvg.gapLow,
      priceHigh: fvg.gapHigh,
      startTime: fvg.time,
      endTime: fvg.confirmTime,
      state,
      position: null,
      sizeAtr: fvg.sizeAtr,
    });
  }

  for (const poi of pois) {
    poi.position = range === null ? null : classifyPrice(range, proximalPrice(poi));
  }

  return pois.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

/**
 * Ranked candidate list (preferred = [0]) under **exactly** selectPoi's
 * ordering (EDR 0009): among POIs of the entry kind whose proximal edge the
 * pullback can reach, discount-side first (premium for shorts), fresh over
 * tested, nearest proximal edge, earliest startTime. Terminal-state POIs sink
 * below live ones but stay listed — the lifecycle view needs them visible.
 * This mirrors, and is parity-tested against, poi.ts' selection; it decides
 * nothing until the cutover gate.
 */
export function rankPois(
  pois: UnifiedPoi[],
  direction: "long" | "short",
  fromPrice: number,
  range: DealingRange | null,
): UnifiedPoi[] {
  const kind = direction === "long" ? "demand" : "supply";
  const wantedSide: PricePosition = direction === "long" ? "discount" : "premium";
  const onWantedSide = (poi: UnifiedPoi) =>
    range !== null && classifyPrice(range, proximalPrice(poi)) === wantedSide ? 0 : 1;
  const terminal = (poi: UnifiedPoi) => (TERMINAL_STATES.includes(poi.state) ? 1 : 0);

  return pois
    .filter(
      (poi) =>
        poi.kind === kind &&
        (direction === "long" ? proximalPrice(poi) <= fromPrice : proximalPrice(poi) >= fromPrice),
    )
    .sort(
      (a, b) =>
        terminal(a) - terminal(b) ||
        onWantedSide(a) - onWantedSide(b) ||
        (a.state === "fresh" ? 0 : 1) - (b.state === "fresh" ? 0 : 1) ||
        (direction === "long"
          ? proximalPrice(b) - proximalPrice(a)
          : proximalPrice(a) - proximalPrice(b)) ||
        a.startTime - b.startTime,
    );
}
