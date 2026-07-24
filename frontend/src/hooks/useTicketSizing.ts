/**
 * Pure, client-side sizing / liquidation / leverage math for the redesigned
 * ticket's live-computed line (TRADE-FLOW §3.1). Mirrors the deterministic
 * backend constants so the instant client read agrees with the server permit:
 *
 *   - LIQ_STOP_BUFFER  = 0.20  (F2: liquidation must sit ≥20% of stop distance
 *                               BEYOND the stop, else the exchange could
 *                               liquidate before the stop fires)
 *   - MMR              = 0.005 (flat maintenance-margin rate; same estimate the
 *                               sizing module uses — funding/fees/tiered
 *                               brackets ignored, so every liq figure is an
 *                               ESTIMATE, never an exact exchange price)
 *
 * The balance-free numbers (liquidation price, liq-vs-stop distance, max
 * achievable risk% at a leverage, disabled-chip logic) are computed here for
 * an instant read; the balance-derived numbers (quantity, notional, required
 * margin) come from the server (skip-check sizing preview / permit), which is
 * the only side that holds the account balance.
 */

export const LIQ_STOP_BUFFER = 0.2;
export const MMR = 0.005;

export type Side = "LONG" | "SHORT";
export type MarginType = "ISOLATED" | "CROSSED";

/** Simplified isolated-margin liquidation estimate (leverage>1). */
export function liquidationPrice(entry: number, leverage: number, side: Side): number | null {
  if (!(entry > 0) || !(leverage > 1)) return null;
  const inv = 1 / leverage;
  return side === "LONG" ? entry * (1 - inv + MMR) : entry * (1 + inv - MMR);
}

/** Signed gap the liquidation sits BEYOND the stop, in the adverse direction. */
export function liqGapBeyondStop(
  entry: number,
  stop: number,
  leverage: number,
  side: Side,
): number | null {
  const liq = liquidationPrice(entry, leverage, side);
  if (liq === null) return null;
  return side === "LONG" ? stop - liq : liq - stop;
}

/** F2: is the liquidation a safe buffer beyond the stop at this leverage? */
export function liqBufferOk(entry: number, stop: number, leverage: number, side: Side): boolean {
  if (!(entry > 0) || !(stop > 0) || leverage <= 1) return true; // no liq risk at 1x
  const gap = liqGapBeyondStop(entry, stop, leverage, side);
  if (gap === null) return true;
  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0) return true;
  return gap >= LIQ_STOP_BUFFER * stopDistance;
}

/**
 * Largest leverage whose isolated liquidation still sits the required buffer
 * beyond the stop (closed form; matches the risk engine's F2 hint):
 *   L ≤ 1 / (MMR + (1 + buffer) * d / entry)
 */
export function maxSafeLeverage(entry: number, stop: number): number | null {
  if (!(entry > 0) || !(stop > 0)) return null;
  const d = Math.abs(entry - stop);
  if (d <= 0) return null;
  const denom = MMR + (1 + LIQ_STOP_BUFFER) * (d / entry);
  if (denom <= 0) return null;
  return 1 / denom;
}

/**
 * §3.1 max-risk-at-leverage: leverage caps notional (`balance × leverage`), so
 * max achievable risk% = `leverage × (stopDistance / entry) × 100`. Balance
 * cancels out, so this is computable client-side without the balance.
 */
export function maxRiskPercentAtLeverage(
  entry: number,
  stop: number,
  leverage: number,
): number | null {
  if (!(entry > 0) || !(stop > 0) || !(leverage > 0)) return null;
  const d = Math.abs(entry - stop);
  return leverage * (d / entry) * 100;
}

export interface TicketSizingRead {
  stopDistance: number | null;
  liquidationPrice: number | null;
  liqGapBeyondStop: number | null;
  liqBufferOk: boolean;
  maxRiskPercentAtLeverage: number | null;
  /** The requested risk% capped to what the leverage+stop allow (§3.1). */
  cappedRiskPercent: number;
  isCapped: boolean;
  maxSafeLeverage: number | null;
}

/** One synchronous read of every balance-free number the live line needs. */
export function computeTicketSizingRead(params: {
  entry: number;
  stop: number;
  side: Side;
  leverage: number;
  riskPercent: number;
}): TicketSizingRead {
  const { entry, stop, side, leverage, riskPercent } = params;
  const valid = entry > 0 && stop > 0 && entry !== stop;
  const stopDistance = valid ? Math.abs(entry - stop) : null;
  const maxRisk = valid ? maxRiskPercentAtLeverage(entry, stop, leverage) : null;
  const isCapped = maxRisk !== null && riskPercent > maxRisk + 1e-9;
  return {
    stopDistance,
    liquidationPrice: valid ? liquidationPrice(entry, leverage, side) : null,
    liqGapBeyondStop: valid ? liqGapBeyondStop(entry, stop, leverage, side) : null,
    liqBufferOk: valid ? liqBufferOk(entry, stop, leverage, side) : true,
    maxRiskPercentAtLeverage: maxRisk,
    cappedRiskPercent: isCapped && maxRisk !== null ? maxRisk : riskPercent,
    isCapped,
    maxSafeLeverage: valid ? maxSafeLeverage(entry, stop) : null,
  };
}

/** The standard leverage chip ladder (capped at the constitution max). */
export const LEVERAGE_CHIPS = [1, 2, 3, 5, 10] as const;

export interface LeverageChip {
  value: number;
  disabled: boolean;
  /** Present when disabled — the reason (F2 buffer violated / over max). */
  reason?: string;
}

/** Build the leverage chips with F2 + constitution-max disabling. */
export function buildLeverageChips(params: {
  entry: number;
  stop: number;
  side: Side;
  maxLeverage: number;
}): LeverageChip[] {
  const { entry, stop, side, maxLeverage } = params;
  const valid = entry > 0 && stop > 0 && entry !== stop;
  return LEVERAGE_CHIPS.map((value) => {
    if (value > maxLeverage) {
      return { value, disabled: true, reason: `over your ${maxLeverage}× max` };
    }
    if (valid && !liqBufferOk(entry, stop, value, side)) {
      return { value, disabled: true, reason: "liq would sit inside your stop" };
    }
    return { value, disabled: false };
  });
}
