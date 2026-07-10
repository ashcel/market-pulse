import { classifyPrice, type DealingRange, type PricePosition } from "./equilibrium";
import type { ObjectiveCandidate } from "./objectives";
import type { BaseZone } from "./zones";

/**
 * POI selection and the anticipatory limit plan — the Dreimann entry model.
 * Instead of acting at the live price, the trader rests a limit at a point of
 * interest below it (a demand zone for longs; supply mirror), with the stop
 * beyond the zone's wick extreme and the target at the draw-on-liquidity
 * objective. RR is therefore measured from the *limit price*, not from where
 * price trades now — measuring from livePrice systematically misprices
 * anticipatory entries (risk R4).
 *
 * In Phase 1 a POI is a `BaseZone` — the only POI type the engine has; the
 * OB/FVG/zone unification is Phase 3's job, which widens this module's input
 * type without reshaping consumers. Pure derivation over already-computed
 * views, no state (Phase 0 posture; read by no decision until the post-0.5
 * gate). See docs/decisions/0009-poi-selection-and-limit-stop.md.
 */

export interface AnticipatoryPlan {
  direction: "long" | "short";
  /** The POI the limit rests at. */
  zone: BaseZone;
  /** Proximal edge — where the limit fills first. */
  entry: number;
  /** Beyond the distal edge: the zone's full wick extreme, no buffer (see EDR). */
  stop: number;
  /** The preferred objective (`objectives[0]`): no objective → no plan (G10's shape). */
  objective: ObjectiveCandidate;
  riskPerUnit: number;
  rewardPerUnit: number;
  rewardRisk: number;
  /** Where the entry sits in the timeframe's dealing range; null when no range exists. */
  entryPosition: PricePosition | null;
}

/** The zone edge a resting limit fills at first. */
function proximalEdge(zone: BaseZone, direction: "long" | "short"): number {
  return direction === "long" ? zone.priceHigh : zone.priceLow;
}

/**
 * Pick the POI a limit entry would rest at: among zones of the entry kind
 * whose proximal edge is at or beyond `fromPrice` in the pullback direction
 * (at/below for longs), prefer **discount-side of the dealing range first**
 * (a demand zone in premium is not the Dreimann entry; premium mirror for
 * shorts), then **fresh over tested** (a consumed zone's limit rests where
 * orders already filled), then the **nearest proximal edge**. When no dealing
 * range exists the position preference simply drops out — absence of a range
 * must not veto a read this phase doesn't act on anyway.
 */
export function selectPoi(
  zones: BaseZone[],
  direction: "long" | "short",
  fromPrice: number,
  range: DealingRange | null,
): BaseZone | null {
  const kind = direction === "long" ? "demand" : "supply";
  const wantedSide: PricePosition = direction === "long" ? "discount" : "premium";
  const onWantedSide = (zone: BaseZone) =>
    range !== null && classifyPrice(range, proximalEdge(zone, direction)) === wantedSide ? 0 : 1;

  const candidates = zones.filter(
    (zone) =>
      zone.kind === kind &&
      (direction === "long"
        ? proximalEdge(zone, direction) <= fromPrice
        : proximalEdge(zone, direction) >= fromPrice),
  );

  return (
    candidates.sort(
      (a, b) =>
        onWantedSide(a) - onWantedSide(b) ||
        (a.freshness === "fresh" ? 0 : 1) - (b.freshness === "fresh" ? 0 : 1) ||
        (direction === "long"
          ? proximalEdge(b, direction) - proximalEdge(a, direction)
          : proximalEdge(a, direction) - proximalEdge(b, direction)) ||
        a.startTime - b.startTime,
    )[0] ?? null
  );
}

/**
 * The full anticipatory read: limit at the selected POI's proximal edge, stop
 * at its distal edge (the full wick extreme — the ZEC-SL lesson: a stop
 * inside the POI's liquidity noise gets swept before the objective prints;
 * no ATR buffer, a tuned buffer is a threshold and thresholds don't ship
 * against these fixtures), target at the **preferred** objective. Null when
 * no objective candidate exists (no clean target → no plan, G10 as data),
 * when no zone qualifies, or when the geometry isn't strictly positive
 * (entry strictly between stop and objective).
 *
 * Taking the ranked `objectives` list rather than a pre-plucked winner keeps
 * the seam where later policies live (TP ladders, pool-preferring re-ranks);
 * Phase 1's rule is simply "target the preferred candidate."
 */
export function buildAnticipatoryPlan(
  zones: BaseZone[],
  direction: "long" | "short",
  fromPrice: number,
  range: DealingRange | null,
  /** Ranked candidates from `resolveObjectives`; the plan targets `[0]`. */
  objectives: ObjectiveCandidate[],
): AnticipatoryPlan | null {
  const objective = objectives[0];
  if (!objective) return null;
  const zone = selectPoi(zones, direction, fromPrice, range);
  if (!zone) return null;

  const entry = proximalEdge(zone, direction);
  const stop = direction === "long" ? zone.priceLow : zone.priceHigh;
  const riskPerUnit = direction === "long" ? entry - stop : stop - entry;
  const rewardPerUnit = direction === "long" ? objective.price - entry : entry - objective.price;
  if (riskPerUnit <= 0 || rewardPerUnit <= 0) return null;

  return {
    direction,
    zone,
    entry,
    stop,
    objective,
    riskPerUnit,
    rewardPerUnit,
    rewardRisk: rewardPerUnit / riskPerUnit,
    entryPosition: range === null ? null : classifyPrice(range, entry),
  };
}
