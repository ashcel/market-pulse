import type { LiquidityPool } from "./liquidity";
import { deriveSwingStrength, type SwingStrength } from "./strength";
import { EQUAL_LEVEL_TOLERANCE, type MarketStructure, type SwingPoint } from "./structure";

/**
 * Draw-on-liquidity objectives — "what is price drawn toward?" In the
 * Dreimann framework a trade's objective is the opposing *weak* structure:
 * the swing high whose push down failed (long) or the swing low whose push up
 * failed (short), because the stops resting beyond it are unprotected — the
 * market has no proven interest in defending it. Strong swings are the
 * opposite: defended levels, protection rather than draw, never a target.
 *
 * The resolver returns a ranked list of candidates, nearest first — the draw
 * is the first liquidity on the path, and the tail is the ordered path beyond
 * it (successive TP levels ride the same list). An empty list is a
 * first-class outcome: "no clean target" is itself the signal (the input to
 * the targets-required veto, G10), never papered over with a fabricated
 * level.
 *
 * Like `strength.ts`/`equilibrium.ts`, this is a derived view over already
 * computed views with no state of its own — bar-limited window in,
 * what-was-knowable-then out. See
 * docs/decisions/0008-objective-draw-on-liquidity.md.
 */

export interface ObjectiveCandidate {
  direction: "long" | "short";
  /** The swing whose resting liquidity is the draw (weak high above / weak low below). */
  swing: SwingPoint;
  strength: SwingStrength;
  /** The liquidity line: the coinciding intact pool's price when one exists, else the swing's. */
  price: number;
  /** Intact EQH/EQL pool coinciding with the swing, when the draw is a stacked-stops level. */
  pool: LiquidityPool | null;
}

/**
 * Ranked candidate objectives, best first — `[0]` is the preferred objective
 * (the engine/UI read); the rest are alternatives preserved for later
 * policies (TP ladders, target-plurality checks, per-intent re-ranking).
 * Empty = no clean target, never fabricated.
 *
 * Eligibility (the EDR records each choice as initial and revisable):
 * - Only swings on the far side of `fromPrice` in the trade direction —
 *   strictly above for a long, strictly below for a short.
 * - `weak` qualifies outright ("objective = weak structure"); `unresolved`
 *   qualifies too — still targetable, merely unproven, and as-of a live bar
 *   the most recent opposing swing is usually unresolved. `strong` never
 *   qualifies: a defended level is protection, not a draw.
 * - Untaken only: once a later same-kind swing has traded strictly beyond a
 *   level, the liquidity there is spent whatever its strength label says
 *   (the swing-level mirror of `liquidity.ts` `intact`).
 * - When an intact opposing pool's line coincides with a candidate (within
 *   the equality tolerance, or sitting between the candidate and
 *   `fromPrice`), the candidate's `price` is promoted to the pool line —
 *   stops rest at the cluster extreme, not the single swing print. Each pool
 *   is absorbed into at most one candidate, and duplicate price levels
 *   collapse into the pool-backed member (else the earlier swing), so the
 *   ranking never lists one liquidity line twice.
 */
export function resolveObjectives(
  structure: MarketStructure,
  pools: LiquidityPool[],
  direction: "long" | "short",
  fromPrice: number,
): ObjectiveCandidate[] {
  const kind = direction === "long" ? "high" : "low";
  const beyond = (a: number, b: number) => (direction === "long" ? a > b : a < b);

  const swings = structure.swings;
  const eligible = deriveSwingStrength(structure).filter(({ swing, strength }, index) => {
    if (swing.kind !== kind || strength === "strong") return false;
    if (!beyond(swing.price, fromPrice)) return false;
    // Untaken: no later same-kind swing traded strictly beyond this level.
    for (let j = index + 1; j < swings.length; j++) {
      if (swings[j].kind === kind && beyond(swings[j].price, swing.price)) return false;
    }
    return true;
  });

  // Pools that could carry a candidate's resting stops: opposing side, still
  // intact, on the target side of `fromPrice`. Each is assignable once.
  const available = pools.filter(
    (p) =>
      p.side === (direction === "long" ? "bsl" : "ssl") && p.intact && beyond(p.price, fromPrice),
  );
  const used = new Set<LiquidityPool>();

  const candidates = eligible
    // Nearest swing first: the draw is the first liquidity on the path.
    .sort(
      (a, b) =>
        (direction === "long" ? a.swing.price - b.swing.price : b.swing.price - a.swing.price) ||
        a.swing.time - b.swing.time,
    )
    .map(({ swing, strength }) => {
      // A pool coincides when its line matches the swing within the equality
      // tolerance, or sits between the swing and `fromPrice` (the cluster
      // extreme is on the path before the swing print). Nearest line wins.
      const matches = available
        .filter(
          (p) =>
            !used.has(p) &&
            (Math.abs(p.price - swing.price) <= swing.price * EQUAL_LEVEL_TOLERANCE ||
              beyond(swing.price, p.price)),
        )
        .sort((a, b) => Math.abs(a.price - swing.price) - Math.abs(b.price - swing.price));
      const pool = matches[0] ?? null;
      if (pool) used.add(pool);
      return { direction, swing, strength, price: pool?.price ?? swing.price, pool };
    });

  // Pool promotion can land two cluster members on the same line — one
  // liquidity level is one candidate, so duplicates collapse into the
  // pool-backed member (the pool is why the line sits there), else the
  // earlier swing. Re-sort by the final price: promotion moves a price, and
  // the ranking contract is proximity of the *liquidity line*.
  const seen = new Set<number>();
  return candidates
    .sort(
      (a, b) =>
        (direction === "long" ? a.price - b.price : b.price - a.price) ||
        (a.pool === null ? 1 : 0) - (b.pool === null ? 1 : 0) ||
        a.swing.time - b.swing.time,
    )
    .filter((c) => {
      if (seen.has(c.price)) return false;
      seen.add(c.price);
      return true;
    });
}
