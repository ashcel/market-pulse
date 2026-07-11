/**
 * Setup validity check against the **live** WebSocket price.
 *
 * The engine core (`intent.ts`, `hysteresis.ts`) grades setups from the last
 * *closed* bar's `lastClose` — correct for the shadow/anticipatory record
 * grading, which only sees closed bars. But the UI has a live price tick
 * streaming in, and a plan built when price was sitting on support can stay
 * displayed as "favored" long after price has run past the entry zone into
 * negative R:R. This pure function is the UI-layer gate that suppresses
 * stale/invalidated setups before they reach the chart, the Follow button,
 * or the plan display.
 *
 * Two severity levels:
 *
 * - **invalidated** — live price has already touched or passed the stop. The
 *   setup is dead; no position should be entered at any price.
 * - **stale** — the setup's geometry no longer pays at the live price: R:R is
 *   zero/negative, price has chased far past the entry zone, or price has
 *   already reached the first target. The thesis might still be right, but
 *   the *this plan* is no longer executable — a new plan at the current price
 *   would have different levels.
 */

export type SetupValiditySeverity = "valid" | "invalidated" | "stale";

export interface SetupValidityResult {
  valid: boolean;
  reason?: string;
  severity: SetupValiditySeverity;
}

/** The plan shape this function needs — a structural subset of `RiskRewardPlan`. */
export interface SetupValidityPlan {
  direction: "long" | "short";
  entry: number;
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
}

/**
 * How far past the entry zone price may travel (in risk units) before the
 * setup is considered stale. 2× means "price has moved twice the initial
 * risk past the zone edge" — far enough that the original entry geometry is
 * meaningless, but not so far that it's necessarily an invalidation.
 */
const STALE_DISTANCE_RISK_MULTIPLE = 2;

/**
 * Returns the validity of a plan against the live price.
 *
 * Bad data (NaN, zero, Infinity, non-finite plan levels) returns
 * `{ valid: true }` — when we can't assess freshness we don't block, because
 * the rest of the engine already gates on having a real plan.
 */
export function validateSetupFreshness(
  plan: SetupValidityPlan,
  livePrice: number,
): SetupValidityResult {
  // Guard: bad price data — don't block on garbage.
  if (!Number.isFinite(livePrice) || livePrice <= 0) {
    return { valid: true, severity: "valid" };
  }

  const { direction, entry, entryLow, entryHigh, stop, target1 } = plan;

  // Guard: bad plan data — don't block on garbage.
  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(target1) ||
    !Number.isFinite(entryLow) ||
    !Number.isFinite(entryHigh)
  ) {
    return { valid: true, severity: "valid" };
  }

  const long = direction === "long";
  const riskPerUnit = Math.abs(entry - stop);

  // Guard: degenerate plan — no risk means no meaningful geometry.
  if (riskPerUnit <= 0) {
    return { valid: true, severity: "valid" };
  }

  // ── Level 1: Invalidated — price already touched stop ──────────────────
  if (long ? livePrice <= stop : livePrice >= stop) {
    return {
      valid: false,
      severity: "invalidated",
      reason: `Price has reached the stop level — the setup is invalidated.`,
    };
  }

  // ── Level 2a: Price already at/past target1 — no room to target ────────
  if (long ? livePrice >= target1 : livePrice <= target1) {
    return {
      valid: false,
      severity: "stale",
      reason: `Price has already reached the first target — this plan is no longer executable.`,
    };
  }

  // ── Level 2b: Negative R:R at live price ───────────────────────────────
  const reward = long ? target1 - livePrice : livePrice - target1;
  const risk = long ? livePrice - stop : stop - livePrice;
  if (risk <= 0 || reward / risk <= 0) {
    return {
      valid: false,
      severity: "stale",
      reason: `Reward-to-risk is zero or negative at the current price.`,
    };
  }

  // ── Level 2c: Price chased too far past the entry zone ─────────────────
  const staleDistance = STALE_DISTANCE_RISK_MULTIPLE * riskPerUnit;
  if (long ? livePrice > entryHigh + staleDistance : livePrice < entryLow - staleDistance) {
    return {
      valid: false,
      severity: "stale",
      reason: `Price has moved well past the entry zone — the setup is stale.`,
    };
  }

  return { valid: true, severity: "valid" };
}