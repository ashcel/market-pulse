import type { PivotPoint } from "./types";

/**
 * Market structure as swing traders read it: an interleaved sequence of swing
 * highs and lows, each labeled relative to the prior swing of its own kind, and
 * a trend state derived from those labels. This replaces ad-hoc "is the last
 * low higher than the one before it?" comparisons scattered through the engine
 * with a single maintained structural state that downstream consumers can read.
 */

/** A swing high vs. the previous high (HH/LH) or a low vs. the previous low (HL/LL). */
export type SwingLabel = "HH" | "HL" | "LH" | "LL";

/** Dominant structural state derived from the most recent labeled swings. */
export type StructureTrend = "uptrend" | "downtrend" | "range";

/**
 * A break of a prior swing extreme. It's a Break Of Structure when it extends
 * the prevailing trend (a new HH in an uptrend, a new LL in a downtrend) and a
 * Change Of Character when it breaks against it (a new HH in a downtrend, a new
 * LL in an uptrend) — the first structural hint of a reversal.
 */
export type StructureEvent = "bos" | "choch";

export interface SwingPoint extends PivotPoint {
  /**
   * This swing relative to the previous swing of the same kind: HH/LH for
   * highs, HL/LL for lows. Null for the first high and the first low, which
   * have no prior same-kind swing to compare against.
   *
   * An extreme-extending label (HH/LL) requires a *strict* break of the prior
   * same-kind swing. A swing that merely matches the prior level (a double top
   * or double bottom) failed to extend, so it takes the internal label: an
   * equal high is an LH, an equal low is an HL. This keeps a flat range —
   * equal highs and equal lows — reading as a range rather than a downtrend.
   */
  label: SwingLabel | null;
  /**
   * The structural break this swing produced, or null. Retained per-swing so
   * consumers can reconstruct the full BOS/CHoCH history from `swings` without
   * re-deriving it; `event`/`eventSwing` on the structure expose only the
   * latest one.
   */
  event: StructureEvent | null;
}

export interface MarketStructure {
  /**
   * The swing legs in time order — a *strictly alternating* high/low sequence,
   * each tagged with its swing label. Consecutive same-kind pivots are collapsed
   * to the leg extreme first (see `toAlternatingSwings`), so classification
   * compares real alternating legs rather than raw same-kind adjacency.
   */
  swings: SwingPoint[];
  /** Structural state as of the most recent swings. */
  trend: StructureTrend;
  /** Most recent swing high (labeled); null when no high has formed yet. */
  lastHigh: SwingPoint | null;
  /** Most recent swing low (labeled); null when no low has formed yet. */
  lastLow: SwingPoint | null;
  /**
   * The most recent structural break in the whole series, or null when no swing
   * has broken structure yet. This is the latest event only — it reflects the
   * last thing that happened structurally (not necessarily the very last
   * swing), and each earlier break is preserved on its own `SwingPoint.event`
   * in `swings` for consumers that need the full history.
   */
  event: StructureEvent | null;
  /** The swing that produced `event`; null when `event` is null. */
  eventSwing: SwingPoint | null;
}

/** An uptrend prints higher highs and higher lows; a downtrend, the mirror. */
function trendFrom(highLabel: SwingLabel | null, lowLabel: SwingLabel | null): StructureTrend {
  if (highLabel === "HH" && lowLabel === "HL") return "uptrend";
  if (highLabel === "LH" && lowLabel === "LL") return "downtrend";
  return "range";
}

/**
 * Collapse confirmed pivots into a strictly alternating high/low/high/low
 * sequence. `computePivots` can emit consecutive same-kind pivots — a run of
 * local highs with no confirmed low between them — but those belong to a single
 * swing leg, not a progression of legs. Comparing them same-kind ("this high vs.
 * the previous high") would fabricate an HH/LH from noise inside one leg. So we
 * keep only each run's extreme: the highest high, the lowest low.
 *
 * The result is what makes HH/HL/LH/LL classification trustworthy — every label
 * is a comparison of genuine, alternation-validated swing legs. The pass is a
 * pure forward fold (no lookahead): the current, still-forming leg's extreme can
 * still change as more same-kind pivots confirm, exactly as it would live, but
 * every completed leg (one with an opposite-kind leg after it) is frozen.
 *
 * Ties keep the earlier pivot, so the output is deterministic.
 */
export function toAlternatingSwings(pivots: PivotPoint[]): PivotPoint[] {
  const legs: PivotPoint[] = [];
  for (const pivot of pivots) {
    const current = legs[legs.length - 1];
    if (!current || current.kind !== pivot.kind) {
      legs.push(pivot);
      continue;
    }
    // Same kind as the running leg: extend it only if this pivot is the more
    // extreme extreme. `>`/`<` (not `>=`/`<=`) is what makes ties keep the
    // earlier pivot already in `legs`.
    const extendsLeg =
      pivot.kind === "high" ? pivot.price > current.price : pivot.price < current.price;
    if (extendsLeg) legs[legs.length - 1] = pivot;
  }
  return legs;
}

/**
 * Normalize the confirmed pivots into alternating swing legs (see
 * `toAlternatingSwings`), then label each leg against the previous leg of its
 * kind, maintaining the running trend and the latest structural break. Pass the
 * full pivot set from `computePivots` — this is replay-safe, so backtests can
 * rebuild structure from a bar-limited window.
 */
export function computeMarketStructure(pivots: PivotPoint[]): MarketStructure {
  const swings: SwingPoint[] = [];
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  let trend: StructureTrend = "range";
  let event: StructureEvent | null = null;
  let eventSwing: SwingPoint | null = null;

  for (const pivot of toAlternatingSwings(pivots)) {
    // The extreme label (HH/LL) needs a strict break of the prior same-kind
    // swing; an equal level takes the internal label (LH/HL). See SwingPoint.
    let label: SwingLabel | null = null;
    if (pivot.kind === "high") {
      if (lastHigh) label = pivot.price > lastHigh.price ? "HH" : "LH";
    } else if (lastLow) {
      label = pivot.price < lastLow.price ? "LL" : "HL";
    }

    // A swing only breaks structure when it takes out the prior same-kind
    // extreme — a new high above the last high (HH) or a new low below the last
    // low (LL). LH and HL are internal swings that confirm nothing. `trend`
    // still holds the state from before this swing, which decides whether the
    // break continues or reverses the prevailing trend. While that prior state
    // is still `range`, the swing is structure *forming*, not breaking: there
    // is no established trend to continue or reverse, so no event is emitted
    // until one exists (the next same-direction break becomes the first BOS).
    let swingEvent: StructureEvent | null = null;
    if ((label === "HH" || label === "LL") && trend !== "range") {
      const reverses =
        (label === "HH" && trend === "downtrend") || (label === "LL" && trend === "uptrend");
      swingEvent = reverses ? "choch" : "bos";
    }

    const swing: SwingPoint = { ...pivot, label, event: swingEvent };
    swings.push(swing);
    if (swingEvent) {
      event = swingEvent;
      eventSwing = swing;
    }

    if (pivot.kind === "high") lastHigh = swing;
    else lastLow = swing;

    trend = trendFrom(lastHigh?.label ?? null, lastLow?.label ?? null);
  }

  return { swings, trend, lastHigh, lastLow, event, eventSwing };
}
