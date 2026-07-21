/**
 * Funding-harvest backtest — a PURE, deterministic simulation of the user's
 * funding-harvest strategy over historical settlement windows. Given, per
 * extreme-funding event, the settled rate and the 1-minute candles bracketing
 * settlement, it replays the exact playbook the live advisor (`funding-play.ts`)
 * describes and reports how the strategy WOULD have performed.
 *
 * The strategy replayed here (defaults in `DEFAULT_FUNDING_BACKTEST_CONFIG`):
 *   1. Harvest leg — a few minutes before settlement, enter the side that
 *      RECEIVES funding (positive rate ⇒ longs pay shorts ⇒ go SHORT; negative
 *      ⇒ go LONG). Size the position so a hard stop at `stopDistancePct` loses
 *      ~`maxLossUsd` (notional = maxLossUsd / (stopDistancePct/100)). Hold
 *      through settlement to collect the funding payment, then flatten a couple
 *      of minutes later once funding is distributed.
 *   2. Reversal leg (optional) — immediately after settlement, flip to the
 *      opposite side (no funding), same stop, hold ~30–60 min. Reported
 *      separately; it is not part of the harvest edge.
 *
 * Like `funding-play.ts` / `discovery.ts` this is a discovery/advisor layer:
 * it never touches decision or trigger semantics, ENGINE_VERSION, or any
 * forward-test record. Nothing here fetches — callers supply candles.
 *
 * ── Modeling assumptions (results are INDICATIVE and biased pessimistic) ──
 *  A. Settled rate as the flag proxy. The live user acts on the *predicted*
 *     rate shown pre-settlement; here we use the *settled* rate as both the
 *     flag and the payment. The two are usually close but not identical, so the
 *     historical entry filter is a proxy for what the user would actually have
 *     seen in the entry window.
 *  B. 1m close fills. Entry and time-based exits fill at the CLOSE of the
 *     relevant 1m candle. No sub-minute precision.
 *  C. No slippage / no spread / no partial fills / no maker rebates modeled.
 *     Every fill is a clean taker fill at the modeled price; round-trip taker
 *     fees (2 × takerFeeRate × notional) are the only friction. Real fills on a
 *     thin book near settlement are worse, so realized PnL skews below this.
 *  D. Conservative stop tie-break. Intrabar stops are checked with the candle's
 *     high/low. If a candle's range touches the stop it is treated as STOPPED at
 *     the stop price — even if that same candle also traded favorably (we assume
 *     the adverse touch came first). This can only hurt the reported result.
 *  E. Funding is received iff the position is still alive AT settlement. A stop
 *     in any candle that OPENS strictly before the settlement candle forfeits
 *     the funding entirely (you were flat when it paid). A stop at/after the
 *     settlement candle still collects funding (it pays at the settlement
 *     instant, the open of the settlement candle) and only the price exit moves.
 *  F. Funding credit = |settledRate| × notional (funding is quoted on notional;
 *     price scale cancels, so units are USD at the given notional).
 *
 * Because of B–E the numbers are deliberately conservative on fills and stops —
 * treat them as a pessimistic floor, not a promise.
 */

import { DEFAULT_FUNDING_PLAY_CONFIG } from "./funding-play";
import type { Candle } from "./types";

/** One historical extreme-funding event plus the candles bracketing it. */
export interface FundingBacktestInstance {
  /** Exchange pair, e.g. "SOLUSDT". */
  pair: string;
  /** Base asset, e.g. "SOL". */
  ticker: string;
  /** Epoch ms of the funding settlement. */
  settlementMs: number;
  /** Settled funding rate as a decimal (0.01 = 1%/interval). */
  settledRate: number;
  /** Funding interval in hours (8 by default; 4 or 1 on adjusted pairs). */
  intervalHours: number;
  /**
   * 1-minute candles (Candle.time in SECONDS, per `binance.ts`) that must span
   * at least [settlement − entryOffset − buffer, settlement + reversalHold].
   * Contiguous 1m bars are assumed; gaps around the window skip the instance.
   */
  candles1m: Candle[];
}

export interface FundingBacktestConfig {
  /** Enter the harvest leg this many minutes before settlement. */
  entryOffsetMinutes: number;
  /** Flatten the harvest leg this many minutes after settlement. */
  exitAfterMinutes: number;
  /** Hold the reversal leg this many minutes after settlement. */
  reversalHoldMinutes: number;
  /** Hard-stop distance, % of entry price (also the sizing divisor). */
  stopDistancePct: number;
  /** Max loss the stop is sized to, USD. Notional = maxLossUsd / (stopDistancePct/100). */
  maxLossUsd: number;
  /** Taker fee per side, decimal (round trip = 2×). */
  takerFeeRate: number;
}

/**
 * Defaults pulled from / consistent with `DEFAULT_FUNDING_PLAY_CONFIG` so the
 * backtest sizes and charges exactly like the live advisor.
 */
export const DEFAULT_FUNDING_BACKTEST_CONFIG: FundingBacktestConfig = {
  entryOffsetMinutes: 15,
  exitAfterMinutes: 2,
  reversalHoldMinutes: 60,
  stopDistancePct: DEFAULT_FUNDING_PLAY_CONFIG.defaultStopDistancePct,
  maxLossUsd: DEFAULT_FUNDING_PLAY_CONFIG.maxLossUsd,
  takerFeeRate: DEFAULT_FUNDING_PLAY_CONFIG.takerFeeRate,
};

export interface LegResult {
  /** Net leg PnL, USD: priceMoveUsd + fundingUsd − feesUsd. */
  pnlUsd: number;
  /** Funding collected, USD (harvest only; 0 on the reversal leg). */
  fundingUsd: number;
  /** PnL from the price move on notional, USD (signed by side). */
  priceMoveUsd: number;
  /** Round-trip taker fees, USD (positive cost). */
  feesUsd: number;
  /** Whether the protective stop was hit during the hold. */
  stopped: boolean;
  /** Max adverse excursion over the hold, % of entry (positive). */
  maePct: number;
  /** Max favorable excursion over the hold, % of entry (positive). */
  mfePct: number;
}

export interface FundingInstanceResult {
  pair: string;
  settlementMs: number;
  settledRate: number;
  /** Harvest side (the side that receives funding). */
  side: "long" | "short";
  harvest: LegResult;
  reversal: LegResult;
}

/** |rate| band aggregate (bands are half-open on the low end). */
export interface FundingRateBucket {
  /** Human label, e.g. "0.5–1%". */
  label: string;
  /** Inclusive lower bound on |rate| (decimal). */
  minAbsRate: number;
  /** Exclusive upper bound on |rate| (decimal); Infinity for the top band. */
  maxAbsRate: number;
  n: number;
  /** Harvest-leg win rate in this band, 0–1. */
  winRate: number;
  /** Harvest-leg average PnL in this band, USD. */
  avgPnl: number;
}

export interface EquityPoint {
  settlementMs: number;
  /** Cumulative harvest PnL after this settlement, USD. */
  equity: number;
}

export interface FundingBacktestReport {
  pair: string;
  ticker: string;
  /** Number of instances that simulated (skipped ones excluded). */
  n: number;
  /** Harvest-leg win rate, 0–1. */
  winRateHarvest: number;
  /** Reversal-leg win rate, 0–1. */
  winRateReversal: number;
  /** Total harvest PnL, USD. */
  totalPnl: number;
  /** Mean harvest PnL per instance, USD. */
  avgPnl: number;
  /** Median harvest PnL per instance, USD. */
  medianPnl: number;
  /**
   * Harvest per-trade expectancy, USD: winRate·avgWin + lossRate·avgLoss
   * (avgLoss negative). Equals `avgPnl` by construction; surfaced separately
   * as the conventional expectancy read.
   */
  expectancy: number;
  /** Largest peak-to-trough drop of the sequential harvest equity curve, USD (≥0). */
  maxDrawdown: number;
  /** |rate| bands: 0.5–1%, 1–2%, ≥2%. */
  buckets: FundingRateBucket[];
  /** Cumulative harvest equity, chronological — for charting. */
  equityCurve: EquityPoint[];
  /** Per-instance detail, chronological. */
  instances: FundingInstanceResult[];
  /** Config the report was produced under (for provenance in the UI). */
  config: FundingBacktestConfig;
}

const SECONDS_PER_MINUTE = 60;

/**
 * Index of the 1m candle that CONTAINS `targetSec` (open ≤ target < open+60).
 * Candles are assumed contiguous and 1m; returns -1 if none contains it.
 */
function candleIndexAt(candles: Candle[], targetSec: number): number {
  for (let i = 0; i < candles.length; i++) {
    const open = candles[i].time;
    if (targetSec >= open && targetSec < open + SECONDS_PER_MINUTE) return i;
  }
  return -1;
}

interface LegSim {
  stopped: boolean;
  /** Index of the candle the stop filled in, or -1 if never stopped. */
  stopIndex: number;
  /** Fill price of the exit (stop price when stopped, else exit-candle close). */
  exitPrice: number;
  maePct: number;
  mfePct: number;
}

/**
 * Walk one leg from just after the entry candle through the exit candle,
 * applying the conservative intrabar stop (assumption D) and tracking MAE/MFE.
 * `entryIndex` is the entry candle; scanning starts at entryIndex+1 because the
 * fill is at the entry candle's close.
 */
function simulateLeg(
  candles: Candle[],
  entryIndex: number,
  exitIndex: number,
  side: "long" | "short",
  entryPrice: number,
  stopDistancePct: number,
): LegSim {
  const stopPrice =
    side === "short"
      ? entryPrice * (1 + stopDistancePct / 100)
      : entryPrice * (1 - stopDistancePct / 100);
  let maePct = 0;
  let mfePct = 0;
  for (let i = entryIndex + 1; i <= exitIndex; i++) {
    const c = candles[i];
    const adverse =
      side === "short"
        ? ((c.high - entryPrice) / entryPrice) * 100
        : ((entryPrice - c.low) / entryPrice) * 100;
    const favorable =
      side === "short"
        ? ((entryPrice - c.low) / entryPrice) * 100
        : ((c.high - entryPrice) / entryPrice) * 100;
    if (adverse > maePct) maePct = adverse;
    if (favorable > mfePct) mfePct = favorable;
    const touched = side === "short" ? c.high >= stopPrice : c.low <= stopPrice;
    if (touched) {
      return { stopped: true, stopIndex: i, exitPrice: stopPrice, maePct, mfePct };
    }
  }
  return { stopped: false, stopIndex: -1, exitPrice: candles[exitIndex].close, maePct, mfePct };
}

/** Signed price PnL on notional for a side. */
function priceMoveUsd(
  side: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  notionalUsd: number,
): number {
  const move =
    side === "short"
      ? (entryPrice - exitPrice) / entryPrice
      : (exitPrice - entryPrice) / entryPrice;
  return move * notionalUsd;
}

/**
 * Simulate one funding event. Returns null (instance skipped) when the supplied
 * candles do not cover every window boundary the strategy needs — empty/short
 * input never throws, it is simply excluded from the report.
 */
export function simulateFundingInstance(
  instance: FundingBacktestInstance,
  config: FundingBacktestConfig = DEFAULT_FUNDING_BACKTEST_CONFIG,
): FundingInstanceResult | null {
  const { candles1m, settledRate, settlementMs } = instance;
  if (!Array.isArray(candles1m) || candles1m.length < 2) return null;
  if (!Number.isFinite(settledRate) || settledRate === 0) return null;

  const settlementSec = Math.floor(settlementMs / 1000);
  const entrySec = settlementSec - config.entryOffsetMinutes * SECONDS_PER_MINUTE;
  const harvestExitSec = settlementSec + config.exitAfterMinutes * SECONDS_PER_MINUTE;
  const reversalExitSec = settlementSec + config.reversalHoldMinutes * SECONDS_PER_MINUTE;

  const entryIndex = candleIndexAt(candles1m, entrySec);
  const settlementIndex = candleIndexAt(candles1m, settlementSec);
  const harvestExitIndex = candleIndexAt(candles1m, harvestExitSec);
  const reversalExitIndex = candleIndexAt(candles1m, reversalExitSec);

  // Every window boundary must exist and be ordered; otherwise skip.
  if (
    entryIndex < 0 ||
    settlementIndex < 0 ||
    harvestExitIndex < 0 ||
    reversalExitIndex < 0 ||
    !(entryIndex < settlementIndex) ||
    !(settlementIndex <= harvestExitIndex) ||
    !(harvestExitIndex <= reversalExitIndex)
  ) {
    return null;
  }

  const notionalUsd = config.maxLossUsd / (config.stopDistancePct / 100);
  const feesUsd = 2 * config.takerFeeRate * notionalUsd;

  // Positive funding ⇒ longs pay shorts ⇒ the receiving side is SHORT.
  const harvestSide: "long" | "short" = settledRate > 0 ? "short" : "long";

  // ── Harvest leg ──
  const harvestEntryPrice = candles1m[entryIndex].close;
  const harvestSim = simulateLeg(
    candles1m,
    entryIndex,
    harvestExitIndex,
    harvestSide,
    harvestEntryPrice,
    config.stopDistancePct,
  );
  // Funding is received unless stopped in a candle opening strictly before the
  // settlement candle (assumption E).
  const stoppedBeforeSettlement =
    harvestSim.stopped && candles1m[harvestSim.stopIndex].time < settlementSec;
  const fundingUsd = stoppedBeforeSettlement ? 0 : Math.abs(settledRate) * notionalUsd;
  const harvestPriceMove = priceMoveUsd(
    harvestSide,
    harvestEntryPrice,
    harvestSim.exitPrice,
    notionalUsd,
  );
  const harvest: LegResult = {
    pnlUsd: harvestPriceMove + fundingUsd - feesUsd,
    fundingUsd,
    priceMoveUsd: harvestPriceMove,
    feesUsd,
    stopped: harvestSim.stopped,
    maePct: harvestSim.maePct,
    mfePct: harvestSim.mfePct,
  };

  // ── Reversal leg (opposite side, no funding, independent stop) ──
  // Enters at the harvest exit candle (settlement + exitAfter) close.
  const reversalSide: "long" | "short" = harvestSide === "short" ? "long" : "short";
  const reversalEntryPrice = candles1m[harvestExitIndex].close;
  const reversalSim = simulateLeg(
    candles1m,
    harvestExitIndex,
    reversalExitIndex,
    reversalSide,
    reversalEntryPrice,
    config.stopDistancePct,
  );
  const reversalPriceMove = priceMoveUsd(
    reversalSide,
    reversalEntryPrice,
    reversalSim.exitPrice,
    notionalUsd,
  );
  const reversal: LegResult = {
    pnlUsd: reversalPriceMove - feesUsd,
    fundingUsd: 0,
    priceMoveUsd: reversalPriceMove,
    feesUsd,
    stopped: reversalSim.stopped,
    maePct: reversalSim.maePct,
    mfePct: reversalSim.mfePct,
  };

  return {
    pair: instance.pair,
    settlementMs,
    settledRate,
    side: harvestSide,
    harvest,
    reversal,
  };
}

const BUCKET_BANDS: Array<Pick<FundingRateBucket, "label" | "minAbsRate" | "maxAbsRate">> = [
  { label: "0.5–1%", minAbsRate: 0.005, maxAbsRate: 0.01 },
  { label: "1–2%", minAbsRate: 0.01, maxAbsRate: 0.02 },
  { label: "≥2%", minAbsRate: 0.02, maxAbsRate: Number.POSITIVE_INFINITY },
];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function winRate(pnls: number[]): number {
  if (pnls.length === 0) return 0;
  return pnls.filter((p) => p > 0).length / pnls.length;
}

/**
 * Aggregate simulated instances into a report. `instances` may be raw
 * (unsimulated) events — anything that fails to simulate is silently dropped,
 * so an empty or all-skipped input yields a well-formed zeroed report rather
 * than throwing.
 */
export function runFundingBacktest(
  pair: string,
  ticker: string,
  rawInstances: FundingBacktestInstance[],
  config: FundingBacktestConfig = DEFAULT_FUNDING_BACKTEST_CONFIG,
): FundingBacktestReport {
  const results = rawInstances
    .map((inst) => simulateFundingInstance(inst, config))
    .filter((r): r is FundingInstanceResult => r !== null)
    .sort((a, b) => a.settlementMs - b.settlementMs);

  const harvestPnls = results.map((r) => r.harvest.pnlUsd);
  const reversalPnls = results.map((r) => r.reversal.pnlUsd);
  const totalPnl = harvestPnls.reduce((s, p) => s + p, 0);
  const n = results.length;
  const avgPnl = n > 0 ? totalPnl / n : 0;

  // Conventional expectancy: winRate·avgWin + lossRate·avgLoss. Equals avgPnl.
  const wins = harvestPnls.filter((p) => p > 0);
  const losses = harvestPnls.filter((p) => p <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
  const expectancy = n > 0 ? (wins.length / n) * avgWin + (losses.length / n) * avgLoss : 0;

  // Sequential equity curve + max drawdown (largest peak-to-trough drop).
  const equityCurve: EquityPoint[] = [];
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of results) {
    equity += r.harvest.pnlUsd;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    equityCurve.push({ settlementMs: r.settlementMs, equity });
  }

  const buckets: FundingRateBucket[] = BUCKET_BANDS.map((band) => {
    const inBand = results.filter((r) => {
      const abs = Math.abs(r.settledRate);
      return abs >= band.minAbsRate && abs < band.maxAbsRate;
    });
    const pnls = inBand.map((r) => r.harvest.pnlUsd);
    return {
      label: band.label,
      minAbsRate: band.minAbsRate,
      maxAbsRate: band.maxAbsRate,
      n: inBand.length,
      winRate: winRate(pnls),
      avgPnl: pnls.length > 0 ? pnls.reduce((s, p) => s + p, 0) / pnls.length : 0,
    };
  });

  return {
    pair,
    ticker,
    n,
    winRateHarvest: winRate(harvestPnls),
    winRateReversal: winRate(reversalPnls),
    totalPnl,
    avgPnl,
    medianPnl: median(harvestPnls),
    expectancy,
    maxDrawdown,
    buckets,
    equityCurve,
    instances: results,
    config,
  };
}
