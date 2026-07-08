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

/**
 * How the liquidation price sits relative to the plan's stop (its invalidation
 * level): "safe" = liquidation is comfortably beyond the stop, "thin" = beyond
 * it but by less than half a stop-distance (a stop-run wick could liquidate
 * you first), "danger" = liquidation triggers before the stop is ever hit.
 */
export type LiquidationSafety = "safe" | "thin" | "danger";

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
  /**
   * Gap between the stop and liquidation, as a fraction of entry. Positive when
   * liquidation sits beyond the stop (a cushion); negative when it sits before.
   */
  stopToLiquidationBufferPct: number;
  /** That cushion measured in stop-distances (buffer / stop distance). */
  bufferInStops: number;
  liquidationSafety: LiquidationSafety;
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

  // Signed gap from the stop to liquidation: positive when liquidation sits
  // past the stop (a cushion beyond your invalidation), negative when it sits
  // in front of it. Measured against the stop distance so "thin" means the
  // cushion is small relative to the risk you're already taking.
  const stopToLiquidationBufferPct = long
    ? (stop - liquidation) / entry
    : (liquidation - stop) / entry;
  const bufferInStops = stopFraction > 0 ? stopToLiquidationBufferPct / stopFraction : 0;
  const liquidationSafety: LiquidationSafety = liquidatesBeforeStop
    ? "danger"
    : bufferInStops < 0.5
      ? "thin"
      : "safe";

  return {
    notional,
    margin,
    liquidation,
    maxSafeLeverage,
    liquidatesBeforeStop,
    stopToLiquidationBufferPct,
    bufferInStops,
    liquidationSafety,
  };
}
