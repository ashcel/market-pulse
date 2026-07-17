import { EQUAL_LEVEL_TOLERANCE, type EqualLevel, type MarketStructure } from "./structure";
import type { Candle } from "./types";

/**
 * Liquidity pools: where resting stop orders cluster. Equal highs accumulate
 * buy-side liquidity just above them (shorts' stop-losses plus breakout buy
 * stops); equal lows accumulate sell-side liquidity just below (longs' stops
 * plus breakdown sell stops). Each EQH/EQL cluster from the market-structure
 * engine therefore maps to one pool at the cluster's extreme — the price the
 * stops actually rest behind.
 *
 * This module only *derives* pools from the structure output; it never
 * re-detects equality and adds no state of its own, so it inherits the
 * structure engine's determinism and replay safety. `detectLiquiditySweeps`
 * then adds the one candle-level read pools can't make alone: whether the
 * first break of a level was a stop hunt or an acceptance. See
 * docs/decisions/0002-liquidity-pool-confidence.md and
 * 0003-liquidity-sweep-definition.md.
 */

/** Buy-side liquidity rests above equal highs; sell-side below equal lows. */
export type LiquiditySide = "bsl" | "ssl";

/**
 * The explainable inputs behind a pool's confidence, each normalized to
 * [0, 1]. Exposed so a consumer (UI, tests, the AI analyst) can always answer
 * "why this score" from the pool object alone.
 */
export interface LiquidityPoolComponents {
  /** More equal touches = more stops accumulated. 2 touches → 0.5, 3 → 0.85, 4+ → 1. */
  touches: number;
  /** How tightly the cluster's swings match: 1 = tick-identical, 0 = at the tolerance edge. */
  tightness: number;
  /** How recent the cluster's last touch is within the swing sequence: fresh → 1, ancient → ~0. */
  recency: number;
}

export interface LiquidityPool {
  side: LiquiditySide;
  /** The liquidity line — the cluster's extreme, where the resting stops sit. */
  price: number;
  /** The EQH/EQL cluster this pool is derived from. */
  cluster: EqualLevel;
  /**
   * True while no later swing has traded beyond the level. A later swing high
   * above a BSL line (or low below an SSL line) triggered the resting stops,
   * so the pool is spent. This is structural bookkeeping only — whether that
   * break was a genuine breakout or a sweep-and-reclaim is a candle-level
   * question this module does not answer.
   */
  intact: boolean;
  /** 0–100, the weighted blend of `components` (see LIQUIDITY_WEIGHTS). */
  confidence: number;
  /**
   * Qualitative band over `confidence`, for surfaces that must not present
   * the ordinal score as a probability (see docs/decisions/0002). Derived,
   * not independently computed — thresholds match ConfidenceGauge's tone
   * bands.
   */
  tier: "Strong" | "Moderate" | "Weak";
  components: LiquidityPoolComponents;
}

function confidenceTier(confidence: number): LiquidityPool["tier"] {
  return confidence >= 70 ? "Strong" : confidence >= 45 ? "Moderate" : "Weak";
}

/**
 * Component weights. Touches dominate because stacked stops are the essence
 * of a pool; recency outweighs tightness because an old shelf, however clean,
 * has had its orders repositioned; tightness refines between the two.
 */
export const LIQUIDITY_WEIGHTS = {
  touches: 0.4,
  tightness: 0.25,
  recency: 0.35,
} as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 2 touches → 0.5, 3 → 0.85, 4+ → 1: a double top is the baseline, not the ceiling. */
function touchesScore(touches: number): number {
  return clamp01(0.5 + (touches - 2) * 0.35);
}

/**
 * 1 when every member printed the identical price, falling linearly to 0 as
 * the cluster's span approaches the widest the equality tolerance allows
 * (members sit within ±tolerance of the anchor, so the span can reach 2×).
 * A zero tolerance means every member matched exactly: tightness is 1.
 */
function tightnessScore(cluster: EqualLevel, equalTolerance: number): number {
  if (equalTolerance <= 0) return 1;
  const prices = cluster.swings.map((s) => s.price);
  const anchor = cluster.swings[0].price;
  const span = Math.max(...prices) - Math.min(...prices);
  return clamp01(1 - span / anchor / (2 * equalTolerance));
}

/**
 * Position of the cluster's last touch within the swing sequence, as a
 * fraction: the most recent swing scores 1, the first ~0. Swing-indexed
 * rather than time-indexed so the score is timeframe-agnostic and needs no
 * candle data. Recomputed per evaluation, so an aging pool decays — which is
 * replay-safe: the value at any point in history depends only on the swings
 * that existed then.
 */
function recencyScore(lastMemberIndex: number, swingCount: number): number {
  if (swingCount <= 0) return 0;
  return clamp01((lastMemberIndex + 1) / swingCount);
}

function poolFrom(
  cluster: EqualLevel,
  structure: MarketStructure,
  equalTolerance: number,
): LiquidityPool {
  const side: LiquiditySide = cluster.kind === "eqh" ? "bsl" : "ssl";
  const lastMember = cluster.swings[cluster.swings.length - 1];
  // Cluster members are the same objects the structure's swings array holds,
  // so reference lookup is exact; the time+kind fallback only guards against
  // a consumer handing us a reconstructed (deserialized) structure.
  let lastIndex = structure.swings.indexOf(lastMember);
  if (lastIndex === -1) {
    lastIndex = structure.swings.findIndex(
      (s) => s.time === lastMember.time && s.kind === lastMember.kind,
    );
  }

  let intact = true;
  for (let i = lastIndex + 1; i < structure.swings.length; i++) {
    const swing = structure.swings[i];
    if (swing.kind !== lastMember.kind) continue;
    if (side === "bsl" ? swing.price > cluster.price : swing.price < cluster.price) {
      intact = false;
      break;
    }
  }

  const components: LiquidityPoolComponents = {
    touches: touchesScore(cluster.swings.length),
    tightness: tightnessScore(cluster, equalTolerance),
    recency: recencyScore(lastIndex, structure.swings.length),
  };
  const confidence = Math.round(
    100 *
      (LIQUIDITY_WEIGHTS.touches * components.touches +
        LIQUIDITY_WEIGHTS.tightness * components.tightness +
        LIQUIDITY_WEIGHTS.recency * components.recency),
  );

  return {
    side,
    price: cluster.price,
    cluster,
    intact,
    confidence,
    tier: confidenceTier(confidence),
    components,
  };
}

/**
 * Derive liquidity pools from the structure's EQH/EQL clusters. Pass the same
 * `equalTolerance` the structure was computed with — it calibrates the
 * tightness score's scale. Pools are returned strongest-first (confidence
 * desc, then price asc, then side) so consumers can take the top of the list;
 * spent pools are included with `intact: false` for callers that want the
 * history, and filtered by presentation.
 */
export function computeLiquidityPools(
  structure: MarketStructure,
  equalTolerance: number = EQUAL_LEVEL_TOLERANCE,
): LiquidityPool[] {
  const pools = [
    ...structure.equalHighs.map((c) => poolFrom(c, structure, equalTolerance)),
    ...structure.equalLows.map((c) => poolFrom(c, structure, equalTolerance)),
  ];
  return pools.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.price - b.price ||
      (a.side === b.side ? 0 : a.side === "bsl" ? -1 : 1),
  );
}

/**
 * A liquidity sweep: the stop hunt. A closed candle's wick traded through a
 * pool's level — triggering the stops resting behind it — but the candle
 * closed back on the near side, so the move was a raid, not an acceptance.
 * A BSL sweep (wick above equal highs, close back below) traps breakout
 * longs and often precedes a move down; an SSL sweep is the mirror.
 */
export interface LiquiditySweep {
  /** Which liquidity was taken: buy-side above equal highs, sell-side below equal lows. */
  side: LiquiditySide;
  /** The pool that was swept — the same object exposed in the pools list. */
  pool: LiquidityPool;
  /** Bar time of the closed candle that performed the sweep. */
  time: number;
  /** The wick extreme: how deep into the stops the raid reached. */
  extreme: number;
  /** The sweep candle's close, back on the near side of the level. */
  close: number;
  /** Wick distance beyond the level, as a fraction of the level. */
  penetration: number;
}

/**
 * Detect sweeps of the given pools on *closed* candles. For each pool, the
 * first candle after the pool's completing touch whose wick penetrates the
 * level decides the outcome once and for all: close back on the near side is
 * a sweep (event emitted); close beyond the level is a breakout (no event) —
 * either way the resting stops are spent, so a pool yields at most one sweep
 * and scanning stops at the first penetration. First-touch-decides is what
 * makes the result append-only under new candles: a sweep already emitted
 * can never be un-emitted by later data.
 *
 * Candle-level truth deliberately outranks swing-level bookkeeping here: a
 * wick that runs the stops but never confirms as a pivot leaves the pool
 * `intact` by swing accounting while this detector still reports the sweep —
 * that gap is exactly why this function exists (see EDR 0002/0003).
 */
export function detectLiquiditySweeps(pools: LiquidityPool[], candles: Candle[]): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  for (const pool of pools) {
    const lastTouch = pool.cluster.swings[pool.cluster.swings.length - 1];
    for (const candle of candles) {
      // The pool exists only once its completing touch has printed; the touch
      // bar itself (whose extreme *is* the level) can't sweep its own pool.
      if (candle.time <= lastTouch.time) continue;
      const penetrated = pool.side === "bsl" ? candle.high > pool.price : candle.low < pool.price;
      if (!penetrated) continue;
      const rejected =
        pool.side === "bsl" ? candle.close <= pool.price : candle.close >= pool.price;
      if (rejected) {
        const extreme = pool.side === "bsl" ? candle.high : candle.low;
        sweeps.push({
          side: pool.side,
          pool,
          time: candle.time,
          extreme,
          close: candle.close,
          penetration: Math.abs(extreme - pool.price) / pool.price,
        });
      }
      break;
    }
  }
  return sweeps.sort(
    (a, b) =>
      a.time - b.time ||
      a.pool.price - b.pool.price ||
      (a.side === b.side ? 0 : a.side === "bsl" ? -1 : 1),
  );
}
