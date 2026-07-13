import { classifyPrice, type DealingRange, type PricePosition } from "./equilibrium";
import type { Fvg } from "./fvg";
import type { OrderBlock } from "./orderblocks";
import { derivePoiLifecycle, type PoiSource, type PoiState } from "./poi-lifecycle";
import type { Candle } from "./types";
import type { BaseZone } from "./zones";

/**
 * The unified POI read model — base zones, order blocks, and FVGs on one
 * ledger, each carrying its premium/discount position and lifecycle state.
 * This is the "Phase 3" seam poi.ts names: `UnifiedPoi` deliberately carries
 * exactly the fields `selectPoi` reads from a `BaseZone` (kind, priceLow/High,
 * startTime, state subsuming freshness), so the eventual gated cutover only
 * widens selectPoi's parameter to a structural interface both types satisfy —
 * consumers keep their shape.
 *
 * Until that pre-registered gate: **display-only**. selectPoi and
 * buildAnticipatoryPlan keep consuming `BaseZone[]`; nothing here is read by
 * any verdict, and the anticipatory/fill record stream is untouched
 * (EDR 0014). Overlapping POIs are listed, never merged — an OB inside its
 * base zone is two reads agreeing, and collapsing them would erase which
 * detector said what.
 *
 * States come from the lifecycle deriver (EDR 0015): terminal POIs
 * (invalidated/consumed) stay on the ledger, flagged, and an FVG closed fully
 * through mints its opposite-kind iFVG at the inversion bar (G6).
 */

export type { PoiSource, PoiState } from "./poi-lifecycle";

export interface UnifiedPoi {
  source: PoiSource;
  kind: "demand" | "supply";
  priceLow: number;
  priceHigh: number;
  /** Formation start — the zone base / OB candle / FVG displacement / inversion bar. */
  startTime: number;
  /** Formation confirmation — departure / displacement / third candle / inversion bar. */
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

export const TERMINAL_POI_STATES: readonly PoiState[] = ["invalidated", "consumed"];

/**
 * Every POI the detectors enumerate, chronological by formation start, with
 * lifecycle states replay-derived here. Zones may arrive as pre-freshness
 * candidates (`computeBaseZoneCandidates`) so terminal zones stay visible —
 * a full `BaseZone` satisfies the same shape and its carried freshness is
 * simply re-derived, identically, from the same window.
 */
export function buildPoiMap(
  zones: Array<Omit<BaseZone, "freshness">>,
  blocks: OrderBlock[],
  fvgs: Fvg[],
  candles: Candle[],
  range: DealingRange | null,
): UnifiedPoi[] {
  const pois: UnifiedPoi[] = [];

  for (const zone of zones) {
    const read = derivePoiLifecycle(
      candles,
      zone.endTime,
      zone.kind,
      zone.priceLow,
      zone.priceHigh,
      "base-zone",
    );
    pois.push({
      source: "base-zone",
      kind: zone.kind,
      priceLow: zone.priceLow,
      priceHigh: zone.priceHigh,
      startTime: zone.startTime,
      endTime: zone.endTime,
      state: read.state,
      position: null,
      sizeAtr: null,
    });
  }

  for (const block of blocks) {
    const read = derivePoiLifecycle(
      candles,
      block.displacementTime,
      block.kind,
      block.priceLow,
      block.priceHigh,
      "order-block",
    );
    pois.push({
      source: "order-block",
      kind: block.kind,
      priceLow: block.priceLow,
      priceHigh: block.priceHigh,
      startTime: block.time,
      endTime: block.displacementTime,
      state: read.state,
      position: null,
      sizeAtr: null,
    });
  }

  for (const fvg of fvgs) {
    const kind = fvg.kind === "bullish" ? "demand" : "supply";
    const read = derivePoiLifecycle(candles, fvg.confirmTime, kind, fvg.gapLow, fvg.gapHigh, "fvg");
    pois.push({
      source: "fvg",
      kind,
      priceLow: fvg.gapLow,
      priceHigh: fvg.gapHigh,
      startTime: fvg.time,
      endTime: fvg.confirmTime,
      state: read.state,
      position: null,
      sizeAtr: fvg.sizeAtr,
    });

    // G6: the inverted gap becomes an opposite-kind POI from the inversion
    // bar; its own lifecycle (fresh → delivery-tested → …) is replay-derived
    // like any other band. Emitted once — an invalidated iFVG never re-flips.
    if (read.inverted && read.decidedAt !== null) {
      const inverseKind = kind === "demand" ? "supply" : "demand";
      const inverseRead = derivePoiLifecycle(
        candles,
        read.decidedAt,
        inverseKind,
        fvg.gapLow,
        fvg.gapHigh,
        "ifvg",
      );
      pois.push({
        source: "ifvg",
        kind: inverseKind,
        priceLow: fvg.gapLow,
        priceHigh: fvg.gapHigh,
        startTime: read.decidedAt,
        endTime: read.decidedAt,
        state: inverseRead.state,
        position: null,
        sizeAtr: fvg.sizeAtr,
      });
    }
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
 * `mitigated` ranks with `tested` (both are non-fresh), so the ordering is
 * parity-tested against poi.ts' selection; it decides nothing until the
 * cutover gate.
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
  const terminal = (poi: UnifiedPoi) => (TERMINAL_POI_STATES.includes(poi.state) ? 1 : 0);

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
