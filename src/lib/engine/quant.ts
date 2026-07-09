import type { Candle, PivotPoint } from "./types";
import { computePivots } from "./analysis";
import {
  computeLiquidityPools,
  detectLiquiditySweeps,
  type LiquidityPool,
  type LiquiditySweep,
} from "./liquidity";
import {
  computeMarketStructure,
  structureLean,
  toAlternatingSwings,
  type MarketStructure,
} from "./structure";

export type SignalStatus = "pass" | "fail" | "warning" | "neutral";
export type TradeDecision =
  "buy-candidate" | "short-candidate" | "wait" | "no-trade" | "invalidated";
export type SetupType =
  | "breakout"
  | "failed-breakout"
  | "pullback-continuation"
  | "vwap-reclaim"
  | "lower-high-rejection"
  | "higher-low-continuation"
  | "capitulation-reversal"
  | "range-compression"
  | "trendline-break"
  | "retest-entry"
  | "exhaustion-move"
  | "no-clear-setup";
export type MarketRegime =
  | "trending-up"
  | "trending-down"
  | "range-bound"
  | "high-volatility"
  | "low-volatility"
  | "breakout-compression"
  | "mean-reversion"
  | "choppy";
export type StopMethod = "swing" | "atr" | "fixed-percent";
export type TradeDirection = "long" | "short" | "none";

export interface SignalComponent {
  name: string;
  status: SignalStatus;
  score: number;
  explanation: string;
}

export interface RiskSettings {
  accountSize: number;
  maxRiskPerTradePercent: number;
  maxDailyLossPercent: number;
  minimumRewardRisk: number;
  atrStopMultiplier: number;
  fixedStopPercent: number;
  stopMethod: StopMethod;
}

export interface RiskRewardPlan {
  direction: TradeDirection;
  entry: number;
  /** Ideal acceptable entry zone (a pullback/rally toward structure), bounded by the stop. */
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
  riskPerUnit: number;
  rewardPerUnit1: number;
  rewardPerUnit2: number;
  rewardRisk1: number;
  rewardRisk2: number;
  maxDollarRisk: number;
  positionSize: number;
  maxDollarLoss: number;
  estimatedGain1: number;
  estimatedGain2: number;
  invalidation: number;
}

export interface AnalyticsSummary {
  lastClose: number;
  changePercent: number;
  sma20: number | null;
  sma50: number | null;
  atr14: number | null;
  atrPercent: number | null;
  avgVolume20: number | null;
  volumeRatio: number | null;
  support: number | null;
  resistance: number | null;
  distanceToSupportPercent: number | null;
  distanceToResistancePercent: number | null;
}

export interface BacktestSummary {
  strategyName: string;
  strategyVersion: string;
  totalTrades: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  averageR: number;
  bestTradeR: number;
  worstTradeR: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  /** True when totalTrades is too small to trust the stats above. */
  lowSample: boolean;
}

/** Below this many replayed trades, win rate/expectancy are noise, not signal. */
export const MIN_RELIABLE_BACKTEST_TRADES = 10;

function humanizeSetup(setup: SetupType): string {
  return setup
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export interface SignalEvaluation {
  symbol: string;
  setupType: SetupType;
  decision: TradeDecision;
  direction: TradeDirection;
  /**
   * The timeframe's reconciled directional lean — what bias dots and the
   * intent layer's context/execution biases should read. `direction` is the
   * raw setup direction and may be a trade the engine itself refuses (a
   * counter-trend setup that fails the regime/structure vetoes); `lean` is
   * that direction only when the engine would actually lean it (see
   * `directionalLean`).
   */
  lean: TradeDirection;
  regime: MarketRegime;
  /** Swing-labeled market structure (HH/HL/LH/LL + trend) behind the setup call. */
  structure: MarketStructure;
  /** Liquidity pools derived from the structure's EQH/EQL clusters, strongest first. */
  liquidity: LiquidityPool[];
  /** Stop hunts on those pools: wick through the level, close back inside (time order). */
  liquiditySweeps: LiquiditySweep[];
  confidence: number;
  components: SignalComponent[];
  noTradeReasons: string[];
  reason: string;
  risk: RiskRewardPlan;
  analytics: AnalyticsSummary;
  backtest: BacktestSummary;
  strategyVersion: string;
  evaluatedAt: string;
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  accountSize: 100_000,
  maxRiskPerTradePercent: 0.75,
  maxDailyLossPercent: 2,
  minimumRewardRisk: 1.8,
  atrStopMultiplier: 1.5,
  fixedStopPercent: 2,
  stopMethod: "swing",
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Round a price with magnitude-aware precision. A fixed 2dp collapses
 * sub-dollar assets (DOGE ~$0.1, PEPE ~$0.00001) to identical levels,
 * which destroys the trade plan and risk math.
 */
function roundPrice(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0 || !Number.isFinite(value)) return value;
  if (abs >= 100) return round(value, 2);
  if (abs >= 1) return round(value, 4);
  if (abs >= 0.01) return round(value, 6);
  // Below a cent: keep 5 significant digits.
  return round(value, Math.min(12, -Math.floor(Math.log10(abs)) + 4));
}

function last<T>(items: T[]): T | null {
  return items.length ? items[items.length - 1] : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(candles: Candle[], length: number): number | null {
  if (candles.length < length) return null;
  return mean(candles.slice(-length).map((c) => c.close));
}

function atr(candles: Candle[], length: number): number | null {
  if (candles.length < length + 1) return null;
  const ranges: number[] = [];
  for (let i = candles.length - length; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    ranges.push(
      Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)),
    );
  }
  return mean(ranges);
}

// The regime thresholds below (ATR%, range width, slope) are absolute
// percentages calibrated on 4H bars. Volatility grows roughly with the square
// root of bar duration, so shorter bars must scale them down — otherwise every
// intraday chart reads as "compression" and never produces a trade direction.
const BASELINE_BAR_SECONDS = 4 * 60 * 60;

function volatilityScale(candles: Candle[]): number {
  if (candles.length < 2) return 1;
  const step = candles[candles.length - 1].time - candles[candles.length - 2].time;
  if (step <= 0) return 1;
  return Math.min(1, Math.sqrt(step / BASELINE_BAR_SECONDS));
}

function slope(values: number[]): number {
  if (values.length < 2) return 0;
  return (values[values.length - 1] - values[0]) / values.length;
}

function nearestSupport(candles: Candle[], pivots: PivotPoint[]): number | null {
  const close = last(candles)?.close;
  if (!isFiniteNumber(close)) return null;
  const supports = pivots
    .filter((p) => p.kind === "low" && p.price < close)
    .map((p) => p.price)
    .sort((a, b) => b - a);
  // Exclude current candle: use previous 20, not last 20 (which includes current)
  const prevCandles = candles.slice(-21, -1);
  return supports[0] ?? (prevCandles.length ? Math.min(...prevCandles.map((c) => c.low)) : close);
}

function nearestResistance(candles: Candle[], pivots: PivotPoint[]): number | null {
  const close = last(candles)?.close;
  if (!isFiniteNumber(close)) return null;
  const resistances = pivots
    .filter((p) => p.kind === "high" && p.price > close)
    .map((p) => p.price)
    .sort((a, b) => a - b);
  // Exclude current candle: use previous 20, not last 20 (which includes current)
  const prevCandles = candles.slice(-21, -1);
  return (
    resistances[0] ?? (prevCandles.length ? Math.max(...prevCandles.map((c) => c.high)) : close)
  );
}

export function analyticsFor(candles: Candle[], pivots: PivotPoint[]): AnalyticsSummary {
  const current = last(candles);
  const prev = candles.length > 1 ? candles[candles.length - 2] : null;
  const lastClose = current?.close ?? 0;
  const atr14 = atr(candles, 14);
  const avgVolume20 = mean(candles.slice(-20).map((c) => c.volume));
  const support = candles.length ? nearestSupport(candles, pivots) : null;
  const resistance = candles.length ? nearestResistance(candles, pivots) : null;
  return {
    lastClose: roundPrice(lastClose),
    changePercent:
      prev && prev.close !== 0 ? round(((lastClose - prev.close) / prev.close) * 100, 2) : 0,
    sma20: sma(candles, 20) === null ? null : roundPrice(sma(candles, 20) as number),
    sma50: sma(candles, 50) === null ? null : roundPrice(sma(candles, 50) as number),
    atr14: atr14 === null ? null : roundPrice(atr14),
    atrPercent: atr14 && lastClose ? round((atr14 / lastClose) * 100, 2) : null,
    avgVolume20: avgVolume20 === null ? null : Math.round(avgVolume20),
    volumeRatio:
      avgVolume20 && current && avgVolume20 > 0 ? round(current.volume / avgVolume20, 2) : null,
    support: support === null ? null : roundPrice(support),
    resistance: resistance === null ? null : roundPrice(resistance),
    distanceToSupportPercent:
      support && lastClose ? round(((lastClose - support) / lastClose) * 100, 2) : null,
    distanceToResistancePercent:
      resistance && lastClose ? round(((resistance - lastClose) / lastClose) * 100, 2) : null,
  };
}

export function classifyRegime(candles: Candle[]): MarketRegime {
  if (candles.length < 30) return "range-bound";
  const current = last(candles);
  if (!current) return "range-bound";
  const closes = candles.slice(-30).map((c) => c.close);
  const ma20 = sma(candles, 20);
  const ma50 = sma(candles, 50);
  const atr14 = atr(candles, 14);
  const atrBase = atr(candles.slice(0, -10), 14);
  const rangeHigh = Math.max(...candles.slice(-20).map((c) => c.high));
  const rangeLow = Math.min(...candles.slice(-20).map((c) => c.low));
  const scale = volatilityScale(candles);
  const compression = atr14 && current.close ? atr14 / current.close < 0.012 * scale : false;
  const rangeWidth = current.close ? (rangeHigh - rangeLow) / current.close : 0;
  const maSlope = slope(closes.slice(-10));

  if (atr14 && atrBase && atr14 > atrBase * 1.45) return "high-volatility";
  if (compression && rangeWidth < 0.055 * scale) return "breakout-compression";
  if (atr14 && current.close && atr14 / current.close < 0.008 * scale) return "low-volatility";
  if (ma20 && ma50 && current.close > ma20 && ma20 > ma50 && maSlope > 0) return "trending-up";
  if (ma20 && ma50 && current.close < ma20 && ma20 < ma50 && maSlope < 0) return "trending-down";
  if (rangeWidth < 0.06 * scale) return "range-bound";
  if (Math.abs(maSlope) < current.close * 0.0008 * scale) return "choppy";
  return "mean-reversion";
}

/**
 * A sweep classifies the setup only while its candle is among this many most
 * recent closed bars — a raid from further back is history, not a trigger.
 */
export const SWEEP_SETUP_RECENCY_BARS = 3;

function sweepIsRecent(sweep: LiquiditySweep, candles: Candle[]): boolean {
  if (candles.length === 0) return false;
  const cutoff = candles[Math.max(0, candles.length - SWEEP_SETUP_RECENCY_BARS)].time;
  return sweep.time >= cutoff;
}

export function classifySetup(
  candles: Candle[],
  pivots: PivotPoint[],
  regime: MarketRegime,
  structure: MarketStructure = computeMarketStructure(pivots),
  sweeps: LiquiditySweep[] = detectLiquiditySweeps(computeLiquidityPools(structure), candles),
): SetupType {
  const current = last(candles);
  const prev = candles.length > 1 ? candles[candles.length - 2] : null;
  if (!current || !prev || candles.length < 30) return "no-clear-setup";
  const support = nearestSupport(candles, pivots);
  const resistance = nearestResistance(candles, pivots);
  const atr14 = atr(candles, 14) ?? current.close * 0.02;
  const ma20 = sma(candles, 20);
  const volumeRatio = analyticsFor(candles, pivots).volumeRatio ?? 1;

  if (resistance && prev.close <= resistance && current.close > resistance && volumeRatio >= 1.2) {
    return "breakout";
  }
  // A recent liquidity sweep is the principled version of the raw checks
  // below: the level is a pool (stops actually rest there, not just any
  // nearby pivot), and first-touch-decides already separated raid from
  // acceptance. Buy-side stops raided and rejected traps breakout longs —
  // the failed-breakout short; sell-side raided and rejected is the flush
  // that clears sellers — the capitulation-reversal long. A fresh acceptance
  // on the current bar (the breakout branch above) still outranks a raid
  // from a bar or two back.
  const latestSweep = last(sweeps); // sweeps arrive time-ordered
  const recentSweep = latestSweep && sweepIsRecent(latestSweep, candles) ? latestSweep : null;
  if (recentSweep) {
    return recentSweep.side === "bsl" ? "failed-breakout" : "capitulation-reversal";
  }
  if (resistance && prev.high > resistance && current.close < resistance) {
    return "failed-breakout";
  }
  if (regime === "breakout-compression") return "range-compression";
  if (ma20 && current.close > ma20 && current.low <= ma20 * 1.01 && current.close > current.open) {
    return "pullback-continuation";
  }
  // Structure carries the swing comparison now: the most recent low being a
  // higher-low, or the most recent high a lower-high, off the maintained state.
  if (structure.lastLow?.label === "HL") {
    return "higher-low-continuation";
  }
  if (structure.lastHigh?.label === "LH") {
    return "lower-high-rejection";
  }
  if (support && current.low < support - atr14 * 0.35 && current.close > support) {
    return "capitulation-reversal";
  }
  if (resistance && Math.abs(current.close - resistance) < atr14 * 0.45) return "retest-entry";
  if (current.high - current.low > atr14 * 2.5) return "exhaustion-move";
  return "no-clear-setup";
}

export function buildRiskPlan(
  candles: Candle[],
  pivots: PivotPoint[],
  direction: TradeDirection,
  settings: RiskSettings = DEFAULT_RISK_SETTINGS,
  /**
   * Real-time price to anchor entry/stop/target on. Setup classification stays
   * gated on the last *closed* bar (so decisions don't flip mid-candle), but an
   * "entry" the trader can actually act on must be current — otherwise a 4H
   * plan quotes a close up to 4h stale next to a 15M plan only minutes stale.
   */
  livePrice?: number,
): RiskRewardPlan {
  const current = last(candles);
  const entry =
    livePrice && Number.isFinite(livePrice) && livePrice > 0 ? livePrice : (current?.close ?? 0);
  const atr14 = atr(candles, 14) ?? entry * 0.02;
  const support = nearestSupport(candles, pivots) ?? entry - atr14 * 1.5;
  const resistance = nearestResistance(candles, pivots) ?? entry + atr14 * 2;
  // A swing stop belongs under the level the market *defended* — the
  // alternation-collapsed leg extreme — not the nearest raw pivot, which can
  // be an interior touch of a single leg that one wick runs through. Raw
  // levels stay in use for targets and the entry zone, where nearest-touch
  // proximity is the honest read (evidence: sr-candidates.test.ts).
  const swings = toAlternatingSwings(pivots);
  const defendedSupport = nearestSupport(candles, swings) ?? support;
  const defendedResistance = nearestResistance(candles, swings) ?? resistance;
  const maxDollarRisk = settings.accountSize * (settings.maxRiskPerTradePercent / 100);

  let stop = entry;
  if (direction === "long") {
    if (settings.stopMethod === "fixed-percent")
      stop = entry * (1 - settings.fixedStopPercent / 100);
    else if (settings.stopMethod === "atr") stop = entry - atr14 * settings.atrStopMultiplier;
    else stop = Math.min(defendedSupport, entry - atr14 * 0.7);
  } else if (direction === "short") {
    if (settings.stopMethod === "fixed-percent")
      stop = entry * (1 + settings.fixedStopPercent / 100);
    else if (settings.stopMethod === "atr") stop = entry + atr14 * settings.atrStopMultiplier;
    else stop = Math.max(defendedResistance, entry + atr14 * 0.7);
  }

  // Ideal entry zone: a bounded pullback (long) or rally (short) toward
  // structure, never worse than just past the stop. Current price is always
  // one edge — the "still acceptable, but you're paying up" side.
  const pullback = atr14 * 1.1;
  let entryLow = entry;
  let entryHigh = entry;
  if (direction === "long") {
    entryLow = Math.min(entry, Math.max(support, entry - pullback, stop + atr14 * 0.1));
  } else if (direction === "short") {
    entryHigh = Math.max(entry, Math.min(resistance, entry + pullback, stop - atr14 * 0.1));
  }

  const riskPerUnit = direction === "none" ? 0 : Math.abs(entry - stop);
  const target1 =
    direction === "long"
      ? Math.max(resistance, entry + riskPerUnit * 1.8)
      : direction === "short"
        ? Math.min(support, entry - riskPerUnit * 1.8)
        : entry;
  const target2 =
    direction === "long"
      ? entry + riskPerUnit * 3
      : direction === "short"
        ? entry - riskPerUnit * 3
        : entry;
  const rewardPerUnit1 = Math.abs(target1 - entry);
  const rewardPerUnit2 = Math.abs(target2 - entry);
  // Crypto positions are fractional — sizing must not floor to whole units or
  // high-priced assets (BTC) resolve to zero for small accounts.
  const positionSize = riskPerUnit > 0 ? round(maxDollarRisk / riskPerUnit, 6) : 0;

  return {
    direction,
    entry: roundPrice(entry),
    entryLow: roundPrice(entryLow),
    entryHigh: roundPrice(entryHigh),
    stop: roundPrice(stop),
    target1: roundPrice(target1),
    target2: roundPrice(target2),
    riskPerUnit: roundPrice(riskPerUnit),
    rewardPerUnit1: roundPrice(rewardPerUnit1),
    rewardPerUnit2: roundPrice(rewardPerUnit2),
    rewardRisk1: riskPerUnit > 0 ? round(rewardPerUnit1 / riskPerUnit, 2) : 0,
    rewardRisk2: riskPerUnit > 0 ? round(rewardPerUnit2 / riskPerUnit, 2) : 0,
    maxDollarRisk: round(maxDollarRisk),
    positionSize,
    maxDollarLoss: round(positionSize * riskPerUnit),
    estimatedGain1: round(positionSize * rewardPerUnit1),
    estimatedGain2: round(positionSize * rewardPerUnit2),
    invalidation: roundPrice(stop),
  };
}

/**
 * The reconciled directional lean of one timeframe. The setup direction
 * leads, but a direction the engine itself refuses to trade — one that
 * fights the confirmed regime or the swing-structure lean, the two hard
 * vetoes in `evaluateSignal` — must not leak out as the timeframe's lean.
 * When the setup direction is suppressed (or absent), the lean is whatever
 * the regime and the structure agree on: either alone may supply it, but
 * when both speak and disagree the honest lean is none.
 */
export function directionalLean(
  direction: TradeDirection,
  regime: MarketRegime,
  structure: MarketStructure,
): TradeDirection {
  const regimeLean: TradeDirection =
    regime === "trending-up" ? "long" : regime === "trending-down" ? "short" : "none";
  const structLean = structureLean(structure);
  if (direction !== "none") {
    const fightsRegime = regimeLean !== "none" && regimeLean !== direction;
    const fightsStructure = structLean !== "none" && structLean !== direction;
    if (!fightsRegime && !fightsStructure) return direction;
  }
  if (regimeLean === structLean) return regimeLean;
  if (regimeLean === "none") return structLean;
  if (structLean === "none") return regimeLean;
  return "none";
}

function decisionFromSetup(setup: SetupType): TradeDirection {
  if (setup === "failed-breakout" || setup === "lower-high-rejection") return "short";
  if (
    setup === "breakout" ||
    setup === "pullback-continuation" ||
    setup === "higher-low-continuation" ||
    setup === "vwap-reclaim" ||
    setup === "retest-entry" ||
    setup === "capitulation-reversal"
  ) {
    return "long";
  }
  return "none";
}

function statusScore(status: SignalStatus, pass: number, warn = -5): number {
  if (status === "pass") return pass;
  if (status === "warning") return warn;
  if (status === "fail") return -Math.abs(warn);
  return 0;
}

export function evaluateSignal(
  symbol: string,
  candles: Candle[],
  pivots: PivotPoint[],
  settings: RiskSettings = DEFAULT_RISK_SETTINGS,
  /** Wider history for the backtest sample; defaults to `candles` when the caller has nothing extra. */
  backtestCandles: Candle[] = candles,
  /** Real-time price to anchor the risk plan's entry on; see `buildRiskPlan`. */
  livePrice?: number,
): SignalEvaluation {
  const current = last(candles);
  const analytics = analyticsFor(candles, pivots);
  const structure = computeMarketStructure(pivots);
  const liquidity = computeLiquidityPools(structure);
  const liquiditySweeps = detectLiquiditySweeps(liquidity, candles);
  const regime = classifyRegime(candles);
  const setupType = classifySetup(candles, pivots, regime, structure, liquiditySweeps);
  const direction = decisionFromSetup(setupType);
  const risk = buildRiskPlan(candles, pivots, direction, settings, livePrice);
  const components: SignalComponent[] = [];
  const add = (name: string, status: SignalStatus, score: number, explanation: string) => {
    components.push({ name, status, score, explanation });
  };

  const trendAligned =
    direction === "long"
      ? regime === "trending-up" || regime === "breakout-compression" || regime === "range-bound"
      : direction === "short"
        ? regime === "trending-down" || regime === "choppy"
        : false;
  // Trading straight into a confirmed opposing trend (long in trending-down,
  // short in trending-up) isn't just "not aligned" — it's the setup a
  // discretionary trader refuses outright, not one they take at a discount.
  const againstConfirmedTrend =
    (direction === "long" && regime === "trending-down") ||
    (direction === "short" && regime === "trending-up");
  add(
    "Trend alignment",
    direction === "none"
      ? "neutral"
      : trendAligned
        ? "pass"
        : againstConfirmedTrend
          ? "fail"
          : "warning",
    direction === "none"
      ? 0
      : statusScore(trendAligned ? "pass" : againstConfirmedTrend ? "fail" : "warning", 20, -8),
    direction === "none"
      ? "No directional setup is strong enough to require trend confirmation."
      : trendAligned
        ? `The current regime supports a ${direction} thesis.`
        : againstConfirmedTrend
          ? `This ${direction} setup fights a confirmed ${regime} regime — that's the wrong side of the tape.`
          : `The current regime does not cleanly support a ${direction} thesis.`,
  );

  // Swing structure is the engine's second trend opinion — the HH/HL/LH/LL
  // read the chart draws. The MA-based regime and the swing read can disagree
  // (price above a rising 20MA while printing LH/LL), and until now only the
  // regime affected the score. `structureLean` folds the trend and the still-
  // live BOS/CHoCH into one directional read — the same definition the
  // per-timeframe lean uses, so the score and the lean can never disagree.
  const structLean = structureLean(structure);
  const inTrend = structure.trend !== "range";
  const eventName = structure.event === "choch" ? "CHoCH" : "BOS";
  let structureStatus: SignalStatus;
  let structureNote: string;
  if (direction === "none") {
    structureStatus = "neutral";
    structureNote = "No directional setup to test against swing structure.";
  } else if (structLean === direction) {
    structureStatus = "pass";
    structureNote = inTrend
      ? structure.trend === "uptrend"
        ? "Swing structure agrees: higher highs and higher lows support the long."
        : "Swing structure agrees: lower highs and lower lows support the short."
      : `Structure is ranging, but the latest break is a ${eventName} in the ${direction} direction — an early structural turn in the trade's favor.`;
  } else if (structLean !== "none") {
    structureStatus = "fail";
    structureNote = inTrend
      ? `Swing structure prints a ${structure.trend === "uptrend" ? "HH/HL uptrend" : "LH/LL downtrend"} — this ${direction} fights the structural trend.`
      : `Structure is ranging and the latest break is a ${eventName} against the ${direction} — the most recent structural evidence points the other way.`;
  } else {
    structureStatus = "warning";
    structureNote =
      "Swing structure is range-bound — no HH/HL or LH/LL sequence confirms this direction yet.";
  }
  add(
    "Structure alignment",
    structureStatus,
    direction === "none" ? 0 : statusScore(structureStatus, 15, -8),
    structureNote,
  );

  const volumeOk = (analytics.volumeRatio ?? 0) >= 1.15;
  add(
    "Volume confirmation",
    volumeOk ? "pass" : "warning",
    statusScore(volumeOk ? "pass" : "warning", 15, -6),
    volumeOk
      ? `Current volume is ${analytics.volumeRatio}x the 20-bar average.`
      : "Volume is not yet meaningfully above the 20-bar average.",
  );

  const midpoint = current ? (current.high + current.low) / 2 : 0;
  const bullishClose = current ? current.close > Math.max(current.open, midpoint) : false;
  const bearishClose = current ? current.close < Math.min(current.open, midpoint) : false;
  const closeConfirmed = direction === "short" ? bearishClose : bullishClose;
  add(
    "Candle close confirmation",
    closeConfirmed ? "pass" : "warning",
    statusScore(closeConfirmed ? "pass" : "warning", 12, -5),
    closeConfirmed
      ? `The latest candle closed decisively in the ${direction === "short" ? "lower" : "upper"} half of its range.`
      : "The latest candle has not confirmed with a decisive close.",
  );

  const rrOk = risk.rewardRisk1 >= settings.minimumRewardRisk;
  add(
    "Reward/risk",
    direction === "none" ? "neutral" : rrOk ? "pass" : "fail",
    direction === "none" ? 0 : statusScore(rrOk ? "pass" : "fail", 18, -18),
    direction === "none"
      ? "No trade plan is active."
      : rrOk
        ? `Target 1 offers ${risk.rewardRisk1}R, above the ${settings.minimumRewardRisk}R minimum.`
        : `Target 1 offers only ${risk.rewardRisk1}R, below the ${settings.minimumRewardRisk}R minimum.`,
  );

  const structureFloor = 0.35 * volatilityScale(candles);
  const nearResistance =
    direction === "long" &&
    analytics.distanceToResistancePercent !== null &&
    analytics.distanceToResistancePercent <
      Math.max(structureFloor, (analytics.atrPercent ?? 1) * 0.55);
  const nearSupport =
    direction === "short" &&
    analytics.distanceToSupportPercent !== null &&
    analytics.distanceToSupportPercent <
      Math.max(structureFloor, (analytics.atrPercent ?? 1) * 0.55);
  add(
    "Support/resistance location",
    nearResistance || nearSupport ? "warning" : "pass",
    statusScore(nearResistance || nearSupport ? "warning" : "pass", 12, -8),
    nearResistance
      ? "Long entry is close to nearby resistance."
      : nearSupport
        ? "Short entry is close to nearby support."
        : "Price has enough room to the next nearby structure level.",
  );

  // Liquidity context: pools mark where resting stops cluster. Entering a
  // long just below an intact buy-side pool is the textbook stop-hunt entry —
  // the raid through the level rejects and traps the buyer — so it warns with
  // the same proximity scale the S/R check uses. The mirror positive: a
  // recent sweep on the trade's far side means the stops that would have
  // fueled a move against it were just cleared.
  const poolProximityPct = Math.max(structureFloor, (analytics.atrPercent ?? 1) * 0.55);
  const poolAhead =
    direction === "none"
      ? undefined
      : liquidity.find((pool) => {
          if (!pool.intact || analytics.lastClose <= 0) return false;
          const distancePct =
            (Math.abs(pool.price - analytics.lastClose) / analytics.lastClose) * 100;
          if (direction === "long")
            return (
              pool.side === "bsl" &&
              pool.price > analytics.lastClose &&
              distancePct < poolProximityPct
            );
          return (
            pool.side === "ssl" &&
            pool.price < analytics.lastClose &&
            distancePct < poolProximityPct
          );
        });
  const supportiveSweep =
    direction === "none"
      ? undefined
      : liquiditySweeps.find(
          (sweep) =>
            sweep.side === (direction === "long" ? "ssl" : "bsl") && sweepIsRecent(sweep, candles),
        );
  add(
    "Liquidity context",
    direction === "none" ? "neutral" : poolAhead ? "warning" : "pass",
    direction === "none" ? 0 : statusScore(poolAhead ? "warning" : "pass", 10, -6),
    direction === "none"
      ? "No directional setup to test against resting liquidity."
      : poolAhead
        ? direction === "long"
          ? `Long entry sits just below an intact buy-side liquidity pool at ${roundPrice(poolAhead.price)} — the level stop raids reject from.`
          : `Short entry sits just above an intact sell-side liquidity pool at ${roundPrice(poolAhead.price)} — the level stop raids reject from.`
        : supportiveSweep
          ? `The ${supportiveSweep.side === "ssl" ? "sell-side stops below" : "buy-side stops above"} were just swept and rejected — the fuel for a move against this trade is spent.`
          : "No intact liquidity pool sits in the trade's immediate path.",
  );

  const extension =
    analytics.sma20 && analytics.atr14
      ? Math.abs(analytics.lastClose - analytics.sma20) / analytics.atr14
      : 0;
  const extended = extension > 2.7;
  add(
    "Extension from mean",
    extended ? "warning" : "pass",
    statusScore(extended ? "warning" : "pass", 8, -6),
    extended
      ? `Price is ${round(extension, 1)} ATR from the 20MA; chasing risk is elevated.`
      : "Price is not excessively extended from its 20-period mean.",
  );

  const noTradeReasons: string[] = [];
  if (setupType === "no-clear-setup") noTradeReasons.push("No clear setup is classified.");
  if (regime === "choppy") noTradeReasons.push("Market regime is choppy/noisy.");
  if (againstConfirmedTrend)
    noTradeReasons.push(`Setup direction is against the confirmed ${regime} regime.`);
  // Fighting the swing structure is the same hard veto as fighting the regime:
  // the discretionary trader does not take the long while the chart prints
  // LH/LL, whatever the moving averages say.
  if (structureStatus === "fail")
    noTradeReasons.push("Setup direction fights the swing-structure read.");
  if (!rrOk && direction !== "none")
    noTradeReasons.push("Reward/risk is below the configured minimum.");
  if (nearResistance) noTradeReasons.push("Price is too close to resistance for a long trade.");
  if (nearSupport) noTradeReasons.push("Price is too close to support for a short trade.");
  if (poolAhead)
    noTradeReasons.push(
      direction === "long"
        ? "Long entry sits just below an intact buy-side liquidity pool."
        : "Short entry sits just above an intact sell-side liquidity pool.",
    );
  if (!volumeOk) noTradeReasons.push("Volume confirmation is missing.");
  if (extended)
    noTradeReasons.push("Price is extended more than the configured ATR distance from mean.");
  if (risk.positionSize <= 0 && direction !== "none")
    noTradeReasons.push("Position size resolves to zero under current risk settings.");

  const rawConfidence = components.reduce((sum, c) => sum + c.score, 35);
  const confidence = Math.max(0, Math.min(100, Math.round(rawConfidence)));
  let decision: TradeDecision = "wait";
  if (setupType === "failed-breakout" && confidence >= 55 && noTradeReasons.length === 0)
    decision = "short-candidate";
  else if (direction === "short" && confidence >= 55 && noTradeReasons.length === 0)
    decision = "short-candidate";
  else if (direction === "long" && confidence >= 55 && noTradeReasons.length === 0)
    decision = "buy-candidate";
  else if (noTradeReasons.length > 0)
    decision = setupType === "failed-breakout" ? "invalidated" : "no-trade";

  const reason =
    noTradeReasons.length > 0
      ? noTradeReasons[0]
      : decision === "buy-candidate"
        ? "A long candidate is forming with confirmed structure, acceptable reward/risk, and explainable support."
        : decision === "short-candidate"
          ? "A short candidate is forming with bearish structure and acceptable risk controls."
          : "The setup is not mature enough; wait for confirmation.";

  return {
    symbol,
    setupType,
    decision,
    direction,
    lean: directionalLean(direction, regime, structure),
    regime,
    structure,
    liquidity,
    liquiditySweeps,
    confidence,
    components,
    noTradeReasons,
    reason,
    risk,
    analytics,
    backtest: runBacktest(backtestCandles, settings, setupType),
    strategyVersion: "QuantDeskSignal_v1",
    evaluatedAt: new Date().toISOString(),
  };
}

export function runBacktest(
  candles: Candle[],
  settings: RiskSettings = DEFAULT_RISK_SETTINGS,
  setupType: SetupType = "no-clear-setup",
): BacktestSummary {
  const trades: number[] = [];
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const direction = decisionFromSetup(setupType);
  for (let i = 55; direction !== "none" && i < candles.length - 5; i++) {
    const window = candles.slice(0, i + 1);
    const c = candles[i];
    // Replay-safe: compute pivots from only the bars available at this point
    // in time. This ensures the replay uses exactly the same information the
    // live engine would have at bar i — no future-data leakage.
    const windowPivots = computePivots(window);
    const regime = classifyRegime(window);
    const setup = classifySetup(window, windowPivots, regime);
    if (setup !== setupType) continue;

    const atr14 = atr(window, 14) ?? c.close * 0.02;
    const rr = Math.max(settings.minimumRewardRisk, 1.8);
    const stop =
      direction === "long"
        ? c.close - atr14 * settings.atrStopMultiplier
        : c.close + atr14 * settings.atrStopMultiplier;
    const target = direction === "long" ? c.close + atr14 * rr : c.close - atr14 * rr;
    const riskPerUnit = Math.abs(c.close - stop);
    if (riskPerUnit <= 0) continue;

    let r = 0;
    for (let j = i + 1; j < Math.min(candles.length, i + 11); j++) {
      if (direction === "long") {
        if (candles[j].low <= stop) {
          r = -1;
          break;
        }
        if (candles[j].high >= target) {
          r = (target - c.close) / riskPerUnit;
          break;
        }
      } else {
        if (candles[j].high >= stop) {
          r = -1;
          break;
        }
        if (candles[j].low <= target) {
          r = (c.close - target) / riskPerUnit;
          break;
        }
      }
    }
    if (r === 0) {
      const exitClose = candles[Math.min(candles.length - 1, i + 10)].close;
      r =
        direction === "long"
          ? (exitClose - c.close) / riskPerUnit
          : (c.close - exitClose) / riskPerUnit;
    }
    trades.push(round(r, 2));
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const wins = trades.filter((r) => r > 0);
  const losses = trades.filter((r) => r < 0);
  let cw = 0;
  let cl = 0;
  let maxCw = 0;
  let maxCl = 0;
  for (const r of trades) {
    if (r > 0) {
      cw++;
      cl = 0;
    } else if (r < 0) {
      cl++;
      cw = 0;
    }
    maxCw = Math.max(maxCw, cw);
    maxCl = Math.max(maxCl, cl);
  }
  const averageWin = mean(wins) ?? 0;
  const averageLossAbs = Math.abs(mean(losses) ?? 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const lossRate = trades.length ? losses.length / trades.length : 0;
  const grossWin = wins.reduce((sum, r) => sum + r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r, 0));
  return {
    strategyName: humanizeSetup(setupType),
    strategyVersion: "SetupReplay_v2",
    totalTrades: trades.length,
    winRate: round(winRate * 100, 1),
    averageWin: round(averageWin, 2),
    averageLoss: round(averageLossAbs, 2),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? 99 : 0,
    expectancy: round(winRate * averageWin - lossRate * averageLossAbs, 2),
    maxDrawdown: round(maxDrawdown, 2),
    averageR: round(mean(trades) ?? 0, 2),
    bestTradeR: round(trades.length ? Math.max(...trades) : 0, 2),
    worstTradeR: round(trades.length ? Math.min(...trades) : 0, 2),
    consecutiveWins: maxCw,
    consecutiveLosses: maxCl,
    lowSample: trades.length > 0 && trades.length < MIN_RELIABLE_BACKTEST_TRADES,
  };
}
