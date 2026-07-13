import type { Candle } from "./types";

/**
 * The POI actionability lifecycle — an explicit state machine derived by
 * candle replay, stateless like every engine view (bar-limited window in,
 * what-was-knowable-then out). It extends zoneFreshness' semantics in two
 * ways: terminal states are **retained and named** (invalidated/consumed)
 * instead of dropping the POI, and a deep single visit reads as `mitigated`
 * rather than `tested`. Collapsing mitigated→tested and mapping terminal→null
 * reproduces zoneFreshness exactly — pinned by a parity test (EDR 0015).
 *
 * Display-plane only: consumed by poi-map.ts and the UI, read by no verdict.
 */

export type PoiSource = "base-zone" | "order-block" | "fvg" | "ifvg";

export type PoiState = "fresh" | "tested" | "mitigated" | "invalidated" | "consumed";

/** A single visit penetrating at least this fraction of the band reads as mitigated. */
export const MITIGATED_PENETRATION = 0.5;

export interface PoiLifecycleRead {
  state: PoiState;
  /** Distinct revisits after the post-formation linger. */
  touches: number;
  /** FVG/iFVG only: deepest fraction of the gap traded through, 0..1. */
  filledFraction: number | null;
  /** Bar time a terminal state was decided (first-touch-decides); null while live. */
  decidedAt: number | null;
  /** FVG only: a bar closed fully through the gap — the band inverts (G6). */
  inverted: boolean;
}

/**
 * Replay every closed bar after `afterTime` (the formation bar — departure /
 * displacement / FVG confirm) against the band:
 *
 * - **invalidated**: a close beyond the distal edge — traded through. For an
 *   FVG this is the G6 inversion: `inverted` is set and the caller mints the
 *   opposite-kind iFVG POI at `decidedAt`.
 * - **consumed**: a second distinct revisit — the resting orders are spent.
 * - **mitigated**: one visit that penetrated ≥ half the band and held.
 * - **tested**: one shallow visit, held. **fresh**: never revisited.
 *
 * The initial linger right after formation is part of forming, not a test —
 * zoneFreshness' rule, kept verbatim: nothing counts (touches or depth) until
 * price has left the band once. Terminal states freeze at `decidedAt`; the
 * replay stops there, so a decided state is identical for every longer window
 * (prefix-replay safety).
 */
export function derivePoiLifecycle(
  candles: Candle[],
  afterTime: number,
  kind: "demand" | "supply",
  priceLow: number,
  priceHigh: number,
  source: PoiSource,
): PoiLifecycleRead {
  const height = priceHigh - priceLow;
  const gapFill = (deepest: number) => (source === "fvg" || source === "ifvg" ? deepest : null);

  let touches = 0;
  let inside = true;
  let everLeft = false;
  let deepest = 0;

  for (const c of candles) {
    if (c.time <= afterTime) continue;

    if (kind === "demand" ? c.close < priceLow : c.close > priceHigh) {
      return {
        state: "invalidated",
        touches,
        filledFraction: gapFill(1),
        decidedAt: c.time,
        inverted: source === "fvg",
      };
    }

    const touching = kind === "demand" ? c.low <= priceHigh : c.high >= priceLow;
    if (touching && everLeft) {
      const raw =
        height > 0
          ? kind === "demand"
            ? (priceHigh - c.low) / height
            : (c.high - priceLow) / height
          : 1;
      deepest = Math.max(deepest, Math.min(1, Math.max(0, raw)));
    }
    if (touching && !inside) {
      touches++;
      if (touches >= 2) {
        return {
          state: "consumed",
          touches,
          filledFraction: gapFill(deepest),
          decidedAt: c.time,
          inverted: false,
        };
      }
    }
    if (!touching) everLeft = true;
    inside = touching;
  }

  const state: PoiState =
    touches === 0 ? "fresh" : deepest >= MITIGATED_PENETRATION ? "mitigated" : "tested";
  return { state, touches, filledFraction: gapFill(deepest), decidedAt: null, inverted: false };
}
