/**
 * Turning a plan the user is looking at into forecast input — the platform
 * equivalent of `notifier-bot/src/forecast/input.js`.
 *
 * Same seeding rule as the bot (`symbol|kind|YYYY-MM-DD`), so a Ticket opened
 * for a setup the bot already messaged about renders the *same* projection. A
 * picture that changes on every render invites reading it as a live prediction.
 *
 * Never allowed to throw at the call site: a Ticket with no cone is a normal
 * Ticket, a thrown forecast is a blank page. Callers get `null`.
 */

import { djb2, generateForecast, type ForecastCandleInput, type ForecastResult } from "./engine";

export * from "./engine";

/** Below ~20 bars the ATR and drift estimates are noise, not a projection. */
export const MIN_REAL_CANDLES = 20;

export interface ForecastPlanInput {
  symbol: string;
  /** Detector id / setup name — part of the seed, so one symbol can hold
   *  several distinct projections on the same day. */
  kind: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  candles: ForecastCandleInput[];
  regime?: string | null;
  /** 0..1. Absent = the engine's own default. */
  signalStrength?: number;
  /** Overrides the date component of the seed; for tests. */
  day?: string;
}

export function buildForecast(plan: ForecastPlanInput): ForecastResult | null {
  try {
    const candles = plan.candles.slice(-60);
    if (candles.length < MIN_REAL_CANDLES) return null;
    if (![plan.entry, plan.stop, plan.target].every((n) => Number.isFinite(n) && n > 0))
      return null;
    // A plan whose stop sits on the wrong side of entry is not a plan; the
    // projection would be drawn against a band that makes no sense.
    const validSides =
      plan.direction === "long"
        ? plan.stop < plan.entry && plan.target > plan.entry
        : plan.stop > plan.entry && plan.target < plan.entry;
    if (!validSides) return null;

    const day = plan.day ?? new Date().toISOString().slice(0, 10);
    return generateForecast({
      candles,
      direction: plan.direction,
      takeProfit: plan.target,
      stopLoss: plan.stop,
      entry: plan.entry,
      regime: plan.regime ?? null,
      signalStrength: plan.signalStrength,
      seed: djb2(`${plan.symbol}|${plan.kind}|${day}`),
    });
  } catch {
    return null;
  }
}
