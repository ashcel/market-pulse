import type { TradingIntent } from "./intent";
import type { TokenTimeframe } from "./mock-candles";
import type { SetupType, TradeDirection } from "./quant";

/** "active" is the only open state — following a signal means you've already entered. */
export type TrackedSignalStatus = "active" | "target1-hit" | "target2-hit" | "stopped-out";

export function isTerminalStatus(status: TrackedSignalStatus): boolean {
  return status !== "active";
}

export interface TrackedSignal {
  id: string;
  symbol: string;
  intent: TradingIntent;
  direction: Exclude<TradeDirection, "none">;
  setupType: SetupType;
  /** Execution timeframe the plan was built on. */
  timeframe: TokenTimeframe;
  /** The engine's ideal entry zone at follow time, kept for reference against the actual entry price. */
  entryLow: number;
  entryHigh: number;
  /** The price the user confirmed they actually entered at. */
  entryPrice: number;
  stop: number;
  target1: number;
  target2: number;
  confidenceAtFollow: number;
  followedAt: string;
  status: TrackedSignalStatus;
  closePrice?: number;
  closedAt?: string;
  resultR?: number;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Advances one tracked signal against a fresh price tick. Returns a patch to
 * merge, or null when nothing changed. First-touch-wins, same walk-forward
 * philosophy as `runBacktest` in quant.ts: whichever of stop/target1/target2
 * price reaches first closes the trade.
 *
 * Known limitation: this only sees polled last price, not intrabar highs/
 * lows, so a wick through a level between polls can be missed — an accepted
 * v1 gap (see the "Ideal entry range + signal tracker" plan).
 */
export function evaluateTrackedSignal(
  signal: TrackedSignal,
  latestPrice: number,
  nowIso: string,
): Partial<TrackedSignal> | null {
  if (!Number.isFinite(latestPrice) || latestPrice <= 0) return null;
  if (isTerminalStatus(signal.status)) return null;

  const long = signal.direction === "long";
  const riskPerUnit = Math.abs(signal.entryPrice - signal.stop);
  const resultR = (exit: number) =>
    riskPerUnit > 0
      ? round((long ? exit - signal.entryPrice : signal.entryPrice - exit) / riskPerUnit, 2)
      : 0;

  const stopHit = long ? latestPrice <= signal.stop : latestPrice >= signal.stop;
  if (stopHit) {
    return {
      status: "stopped-out",
      closePrice: latestPrice,
      closedAt: nowIso,
      resultR: resultR(signal.stop),
    };
  }
  const target2Hit = long ? latestPrice >= signal.target2 : latestPrice <= signal.target2;
  if (target2Hit) {
    return {
      status: "target2-hit",
      closePrice: latestPrice,
      closedAt: nowIso,
      resultR: resultR(signal.target2),
    };
  }
  const target1Hit = long ? latestPrice >= signal.target1 : latestPrice <= signal.target1;
  if (target1Hit) {
    return {
      status: "target1-hit",
      closePrice: latestPrice,
      closedAt: nowIso,
      resultR: resultR(signal.target1),
    };
  }
  return null;
}

export interface TrackedSignalSummary {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number;
  averageR: number;
  /** True when the closed sample is too small (<5) for winRate/averageR to be meaningful. */
  lowSample: boolean;
}

const MIN_RELIABLE_TRACKED_TRADES = 5;

/** Aggregate stats over followed signals. */
export function summarizeTrackedSignals(signals: TrackedSignal[]): TrackedSignalSummary {
  const closed = signals.filter((s) => isTerminalStatus(s.status));
  const wins = closed.filter((s) => s.status === "target1-hit" || s.status === "target2-hit");
  const losses = closed.filter((s) => s.status === "stopped-out");
  const rValues = closed.map((s) => s.resultR ?? 0);
  const averageR = rValues.length ? rValues.reduce((sum, r) => sum + r, 0) / rValues.length : 0;

  return {
    total: signals.length,
    open: signals.filter((s) => !isTerminalStatus(s.status)).length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : 0,
    averageR: round(averageR, 2),
    lowSample: closed.length > 0 && closed.length < MIN_RELIABLE_TRACKED_TRADES,
  };
}
