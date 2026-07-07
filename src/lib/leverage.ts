// Perpetual-futures position math. Leverage does NOT change the risk-based
// position size (that's fixed by the stop distance and your risk %); it only
// changes the margin you must post and where you'd get liquidated. So these are
// display-layer derivations from the engine's existing risk plan — the plan
// itself is untouched.

import type { TradeDirection } from "@/lib/engine/quant";

export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 50;

// Rough maintenance-margin buffer so the liquidation estimate isn't wildly
// optimistic. Real Binance MMR is tiered (~0.4% at the low tiers); this is a
// planning aid, not an exact figure — fees and funding are also ignored.
const MAINTENANCE_MARGIN_RATE = 0.005;

export function clampLeverage(value: number): number {
  if (!Number.isFinite(value)) return MIN_LEVERAGE;
  return Math.min(MAX_LEVERAGE, Math.max(MIN_LEVERAGE, Math.round(value)));
}

export interface LeverageMetrics {
  /** Position value at entry (positionSize × entry). */
  notional: number;
  /** Margin you must post = notional / leverage. */
  margin: number;
  /** Estimated isolated-margin liquidation price. */
  liquidation: number;
  /** Highest leverage that still keeps liquidation beyond the stop. */
  maxSafeLeverage: number;
  /** True when liquidation would trigger before the stop (danger). */
  liquidatesBeforeStop: boolean;
}

export function computeLeverageMetrics(
  entry: number,
  stop: number,
  positionSize: number,
  direction: TradeDirection,
  leverage: number,
): LeverageMetrics | null {
  if (!(entry > 0) || !(positionSize > 0) || !(leverage >= 1)) return null;
  // Treat a directionless plan as long-side for display purposes.
  const long = direction !== "short";
  const notional = positionSize * entry;
  const margin = notional / leverage;

  // Naive isolated liquidation: the adverse move that erodes the posted margin,
  // less a maintenance buffer.
  const moveFraction = 1 / leverage - MAINTENANCE_MARGIN_RATE;
  const liquidation = long ? entry * (1 - moveFraction) : entry * (1 + moveFraction);

  const stopFraction = Math.abs(entry - stop) / entry;
  // Liquidation stays beyond the stop while 1/lev − mmr > stopFraction, i.e.
  // lev < 1 / (stopFraction + mmr).
  const maxSafeLeverage = Math.max(
    1,
    Math.min(MAX_LEVERAGE, Math.floor(1 / (stopFraction + MAINTENANCE_MARGIN_RATE))),
  );
  const liquidatesBeforeStop = long ? liquidation > stop : liquidation < stop;

  return { notional, margin, liquidation, maxSafeLeverage, liquidatesBeforeStop };
}
