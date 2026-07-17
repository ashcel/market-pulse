import { INTENT_MAX_HOLD_BARS } from "./hysteresis";
import { scalePlan } from "./intent";
import { STEP_SECONDS } from "./mock-candles";
import { walkExitLevels } from "./tracker";
import { currentProvenance } from "./version";
import type { MarketType } from "./binance";
import type { ReconcileEntry } from "./hysteresis";
import type { IntentAssessment, TradingIntent } from "./intent";
import type { TokenTimeframe } from "./mock-candles";
import type { MarketRegime, SetupType } from "./quant";
import type { Candle } from "./types";

/**
 * Shadow record: every "favored" verdict the engine issues is auto-recorded
 * and settled against real candle highs/lows — nothing is cherry-picked and
 * the user doesn't have to follow a call for it to count. The resulting
 * per-setup/per-regime hit rates are the engine's live accountability, and
 * combos with a proven negative record demote future "favored" verdicts.
 */

export type ShadowSignalStatus =
  | "active"
  | "target1-hit"
  | "target2-hit"
  | "stopped-out"
  | "expired";

export interface ShadowSignal {
  id: string;
  symbol: string;
  market: MarketType;
  intent: TradingIntent;
  direction: "long" | "short";
  setupType: SetupType;
  /** Execution-timeframe regime when the call was made. */
  regime: MarketRegime;
  timeframe: TokenTimeframe;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  confidence: number;
  openedAt: string;
  status: ShadowSignalStatus;
  closedAt?: string;
  closePrice?: number;
  resultR?: number;
  /**
   * Whether a clean draw-on-liquidity objective existed for the call's
   * direction when it was adopted (Phase 1 annotation; EDR 0008). Keys
   * nothing — the setupType|regime keyspace is untouched and records
   * predating the field settle unchanged. Exists so the Phase 0.5 analysis
   * can ask "do favored calls without a clean objective underperform?"
   * before G10 ever vetoes anything.
   */
  objectiveResolved?: boolean;
  /**
   * Provenance — which engine version / config / commit produced this record.
   * Stamped at `open()`; every stats query segments by `engineVersion` so an
   * engine change splits the record instead of pooling incompatible
   * behaviours. Optional because records predating provenance (Phase A) carry
   * none and are excluded from current-version stats.
   */
  engineVersion?: string;
  configHash?: string;
  gitSha?: string;
}

/** Below this many settled shadow trades a combo's record is noise, not evidence. */
export const MIN_SHADOW_RECORD_TRADES = 15;

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

/** Builds the shadow record entry for a newly adopted favored verdict. */
export function buildShadowSignal(
  assessment: IntentAssessment,
  symbol: string,
  market: MarketType,
  nowIso: string,
): Omit<ShadowSignal, "id" | "status"> | null {
  const plan = assessment.plan;
  if (!plan || (assessment.direction !== "long" && assessment.direction !== "short")) return null;
  return {
    symbol: symbol.toUpperCase(),
    market,
    intent: assessment.intent,
    direction: assessment.direction,
    setupType: assessment.execution.setupType,
    regime: assessment.execution.regime,
    timeframe: assessment.definition.executionTimeframe,
    entry: plan.entry,
    stop: plan.stop,
    target1: plan.target1,
    target2: plan.target2,
    confidence: assessment.confidence,
    openedAt: nowIso,
    objectiveResolved: assessment.execution.objectives.length > 0,
    ...currentProvenance(),
  };
}

/**
 * Settles one shadow signal against closed bars: first-touch-wins on
 * highs/lows (stop checked first within a bar), and a time stop — a call that
 * hits nothing within the intent's holding horizon closes as "expired" at
 * that bar's close, because "went nowhere" is also a graded outcome.
 */
export function settleShadowSignal(
  signal: ShadowSignal,
  closedBars: Candle[],
): Partial<ShadowSignal> | null {
  if (signal.status !== "active") return null;
  const openedAtSec = Date.parse(signal.openedAt) / 1000;
  if (!Number.isFinite(openedAtSec)) return null;

  const maxBars = INTENT_MAX_HOLD_BARS[signal.intent];
  const bars = closedBars.filter((c) => c.time > openedAtSec).slice(0, maxBars);
  const step = STEP_SECONDS[signal.timeframe];
  const closedAtOf = (barTime: number) => new Date((barTime + step) * 1000).toISOString();

  const exit = walkExitLevels(
    {
      direction: signal.direction,
      entry: signal.entry,
      stop: signal.stop,
      target1: signal.target1,
      target2: signal.target2,
    },
    bars,
  );
  if (exit) {
    return {
      status: exit.status,
      closePrice: exit.exitLevel,
      closedAt: closedAtOf(exit.barTime),
      resultR: exit.resultR,
    };
  }

  if (bars.length >= maxBars) {
    const lastBar = bars[maxBars - 1];
    const riskPerUnit = Math.abs(signal.entry - signal.stop);
    const resultR =
      riskPerUnit > 0
        ? round(
            (signal.direction === "long"
              ? lastBar.close - signal.entry
              : signal.entry - lastBar.close) / riskPerUnit,
          )
        : 0;
    return {
      status: "expired",
      closePrice: lastBar.close,
      closedAt: closedAtOf(lastBar.time),
      resultR,
    };
  }

  return null;
}

export interface ShadowRecordSummary {
  total: number;
  open: number;
  closed: number;
  wins: number;
  winRate: number;
  averageR: number;
  lowSample: boolean;
}

export function summarizeShadowRecord(signals: ShadowSignal[]): ShadowRecordSummary {
  const closed = signals.filter((s) => s.status !== "active");
  const wins = closed.filter((s) => (s.resultR ?? 0) > 0);
  const rValues = closed.map((s) => s.resultR ?? 0);
  const averageR = rValues.length ? rValues.reduce((sum, r) => sum + r, 0) / rValues.length : 0;
  return {
    total: signals.length,
    open: signals.length - closed.length,
    closed: closed.length,
    wins: wins.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : 0,
    averageR: round(averageR),
    lowSample: closed.length > 0 && closed.length < MIN_SHADOW_RECORD_TRADES,
  };
}

export interface ShadowComboStat {
  setupType: SetupType;
  regime: MarketRegime;
  closed: number;
  winRate: number;
  averageR: number;
  /** True when the sample is large enough and expectancy is negative. */
  demoted: boolean;
}

/**
 * Live record per setup-type × regime combo, most-traded first. When
 * `engineVersion` is given the record is segmented to that engine — the whole
 * point of provenance: a change in engine behaviour must not pool into one
 * hit-rate. Omit it (tests, aggregate views) to pool every version.
 */
export function shadowComboStats(
  signals: ShadowSignal[],
  engineVersion?: string,
): ShadowComboStat[] {
  const scoped =
    engineVersion === undefined
      ? signals
      : signals.filter((s) => s.engineVersion === engineVersion);
  const buckets = new Map<string, { setupType: SetupType; regime: MarketRegime; r: number[] }>();
  for (const s of scoped) {
    if (s.status === "active") continue;
    const key = `${s.setupType}|${s.regime}`;
    const bucket = buckets.get(key) ?? { setupType: s.setupType, regime: s.regime, r: [] };
    bucket.r.push(s.resultR ?? 0);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((b) => {
      const wins = b.r.filter((r) => r > 0).length;
      const averageR = round(b.r.reduce((sum, r) => sum + r, 0) / b.r.length);
      return {
        setupType: b.setupType,
        regime: b.regime,
        closed: b.r.length,
        winRate: round((wins / b.r.length) * 100, 1),
        averageR,
        demoted: b.r.length >= MIN_SHADOW_RECORD_TRADES && averageR < 0,
      };
    })
    .sort((a, b) => b.closed - a.closed);
}

/**
 * The accountability loop: a "favored" verdict whose setup/regime combo has a
 * proven negative live record is demoted to caution at half size — the engine
 * stops recommending full size on trades it demonstrably loses. Combos with a
 * meaningful record (good or bad) also get an evidence note either way.
 */
export function applyRecordAdjustment(
  assessment: IntentAssessment,
  comboStats: ShadowComboStat[],
): ReconcileEntry {
  const favoredBeforeAdjustment = assessment.verdict === "favored";
  const combo = comboStats.find(
    (s) =>
      s.setupType === assessment.execution.setupType && s.regime === assessment.execution.regime,
  );
  if (!combo || combo.closed < MIN_SHADOW_RECORD_TRADES) {
    return { assessment, favoredBeforeAdjustment };
  }

  const setupLabel = humanize(assessment.execution.setupType);
  const regimeLabel = humanize(assessment.execution.regime);
  const signedR = `${combo.averageR >= 0 ? "+" : ""}${combo.averageR}R`;

  if (favoredBeforeAdjustment && combo.demoted) {
    return {
      assessment: {
        ...assessment,
        verdict: "caution",
        sizeMultiplier: 0.5,
        plan: assessment.plan ? scalePlan(assessment.plan, 0.5) : null,
        headline: `${assessment.headline} — demoted by live record`,
        summary: `${assessment.summary} However, the engine's own shadow record for this exact situation is negative — treat it as a half-size trade at best.`,
      },
      record: {
        note: `Auto-demoted: shadow-tracked ${setupLabel} calls in a ${regimeLabel} tape average ${signedR} over ${combo.closed} settled trades.`,
        demoted: true,
      },
      favoredBeforeAdjustment,
    };
  }

  return {
    assessment,
    record: {
      note: `Live shadow record for ${setupLabel} in a ${regimeLabel} tape: ${combo.winRate}% win rate, ${signedR} avg over ${combo.closed} settled trades.`,
      demoted: false,
    },
    favoredBeforeAdjustment,
  };
}
