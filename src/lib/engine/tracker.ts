import { STEP_SECONDS } from "./mock-candles";
import type { MarketType } from "./binance";
import type { TradingIntent } from "./intent";
import type { TokenTimeframe } from "./mock-candles";
import type { SetupType, TradeDirection } from "./quant";
import type { Candle } from "./types";

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
  /** Binance market the signal priced against; absent on older records (spot). */
  market?: MarketType;
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

export interface ExitLevels {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target1: number;
  target2: number;
}

export interface ExitEvent {
  status: "stopped-out" | "target1-hit" | "target2-hit";
  /** The level that produced the exit (stop or target price). */
  exitLevel: number;
  /** Open time (sec) of the bar that touched the level. */
  barTime: number;
  resultR: number;
}

/**
 * Walks closed bars first-touch-wins using intrabar highs/lows. Within a
 * single bar the stop is checked first (conservative, same precedence as
 * `runBacktest`), then target 2, then target 1.
 */
export function walkExitLevels(levels: ExitLevels, bars: Candle[]): ExitEvent | null {
  const long = levels.direction === "long";
  const riskPerUnit = Math.abs(levels.entry - levels.stop);
  const resultR = (exit: number) =>
    riskPerUnit > 0
      ? round((long ? exit - levels.entry : levels.entry - exit) / riskPerUnit, 2)
      : 0;

  for (const bar of bars) {
    if (long ? bar.low <= levels.stop : bar.high >= levels.stop) {
      return {
        status: "stopped-out",
        exitLevel: levels.stop,
        barTime: bar.time,
        resultR: resultR(levels.stop),
      };
    }
    if (long ? bar.high >= levels.target2 : bar.low <= levels.target2) {
      return {
        status: "target2-hit",
        exitLevel: levels.target2,
        barTime: bar.time,
        resultR: resultR(levels.target2),
      };
    }
    if (long ? bar.high >= levels.target1 : bar.low <= levels.target1) {
      return {
        status: "target1-hit",
        exitLevel: levels.target1,
        barTime: bar.time,
        resultR: resultR(levels.target1),
      };
    }
  }
  return null;
}

/**
 * Catch-up settlement against closed klines: unlike `evaluateTrackedSignal`
 * (polled last price), this sees intrabar highs/lows, so wicks through a
 * level between polls are no longer missed. Only bars that opened after the
 * follow time count — the bar in progress at follow time partially predates
 * the entry.
 */
export function settleTrackedSignalWithCandles(
  signal: TrackedSignal,
  closedBars: Candle[],
): Partial<TrackedSignal> | null {
  if (isTerminalStatus(signal.status)) return null;
  const followedAtSec = Date.parse(signal.followedAt) / 1000;
  if (!Number.isFinite(followedAtSec)) return null;

  const bars = closedBars.filter((c) => c.time > followedAtSec);
  const exit = walkExitLevels(
    {
      direction: signal.direction,
      entry: signal.entryPrice,
      stop: signal.stop,
      target1: signal.target1,
      target2: signal.target2,
    },
    bars,
  );
  if (!exit) return null;

  return {
    status: exit.status,
    closePrice: exit.exitLevel,
    closedAt: new Date((exit.barTime + STEP_SECONDS[signal.timeframe]) * 1000).toISOString(),
    resultR: exit.resultR,
  };
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
