import { STEP_SECONDS } from "./mock-candles";
import type { MarketType } from "./binance";
import type { IntentAssessment, IntentVerdict, TradingIntent } from "./intent";
import type { TokenTimeframe } from "./mock-candles";
import type { RiskRewardPlan, SetupType, TradeDirection } from "./quant";

/** A closed-candle price level whose break is a machine-checkable trigger. */
export interface TriggerLevel {
  level: number;
  side: "below" | "above";
}

/**
 * Verdict hysteresis: a discretionary trader doesn't re-derive their thesis on
 * every tick — they form a view and hold it until something specific breaks
 * it. The raw engine re-evaluates from scratch on each refetch, so regime and
 * pivot wobble can flip a verdict without price actually doing anything. This
 * layer persists the last adopted verdict per symbol/market/intent and only
 * lets it change when one of its own release conditions fires:
 *
 * 1. upgrade   — the same-direction idea got *more* confirmed (wait → favored)
 * 2. invalidation — a closed execution-timeframe candle broke the level the
 *    verdict itself named as its invalidation
 * 3. context flip — the higher-timeframe trend the verdict leaned on changed
 * 4. staleness — the read aged past the intent's holding horizon
 */

/** How many execution-timeframe bars a verdict may be held before it ages out. */
export const INTENT_MAX_HOLD_BARS: Record<TradingIntent, number> = {
  scalp: 16, // 15M bars ≈ 4 hours
  intraday: 24, // 1H bars ≈ 1 day
  swing: 42, // 4H bars ≈ 1 week
  position: 30, // 1D bars ≈ 1 month
};

export interface HeldVerdict {
  symbol: string;
  market: MarketType;
  /** Execution timeframe the verdict's trigger levels live on. */
  executionTimeframe: TokenTimeframe;
  intent: TradingIntent;
  verdict: IntentVerdict;
  direction: TradeDirection;
  isCounterTrend: boolean;
  sizeMultiplier: number;
  headline: string;
  summary: string;
  triggers: string[];
  confidence: number;
  plan: RiskRewardPlan | null;
  /** Execution-timeframe setup at adoption time (feeds the shadow record). */
  setupType: SetupType;
  /** Context-timeframe lean the verdict was built on; a flip releases the hold. */
  contextBias: TradeDirection;
  heldAt: string;
  /** Closed execution-candle level that releases this hold when broken. */
  invalidation: TriggerLevel | null;
  /**
   * Closed execution-candle level whose break would strengthen/confirm the
   * verdict (resistance for a long, support for a short). Drives "trigger hit"
   * upgrade alerts while the verdict is still `wait`/`caution`.
   */
  upgradeTrigger: TriggerLevel | null;
  /** Why this hold replaced the previous one — shown once in the UI. */
  adoptedBecause?: string;
}

/** Live shadow-record evidence attached to a verdict. */
export interface RecordNote {
  note: string;
  /** True when the note explains an automatic favored → caution demotion. */
  demoted: boolean;
}

/** The assessment the UI renders: fresh context, held verdict, hold metadata. */
export type DisplayIntentAssessment = IntentAssessment & {
  hold: { heldAt: string; isHeld: boolean; adoptedBecause?: string };
  record?: RecordNote;
};

/** A fresh assessment after the shadow-record adjustment pass. */
export interface ReconcileEntry {
  assessment: IntentAssessment;
  record?: RecordNote;
  /** True when the raw verdict was "favored" before any record demotion. */
  favoredBeforeAdjustment: boolean;
}

export function holdKey(symbol: string, market: MarketType, intent: TradingIntent): string {
  return `${symbol.toUpperCase()}:${market}:${intent}`;
}

const VERDICT_RANK: Record<IntentVerdict, number> = { avoid: 0, wait: 1, caution: 2, favored: 3 };

function fmtLevel(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
}

function captureHold(
  assessment: IntentAssessment,
  symbol: string,
  market: MarketType,
  nowMs: number,
  adoptedBecause?: string,
): HeldVerdict {
  const a = assessment.execution.analytics;
  let invalidation: TriggerLevel | null = null;
  let upgradeTrigger: TriggerLevel | null = null;
  if (assessment.direction === "long") {
    const invLevel = a.support ?? assessment.execution.risk.invalidation;
    if (Number.isFinite(invLevel)) invalidation = { level: invLevel, side: "below" };
    if (a.resistance !== null && Number.isFinite(a.resistance))
      upgradeTrigger = { level: a.resistance, side: "above" };
  } else if (assessment.direction === "short") {
    const invLevel = a.resistance ?? assessment.execution.risk.invalidation;
    if (Number.isFinite(invLevel)) invalidation = { level: invLevel, side: "above" };
    if (a.support !== null && Number.isFinite(a.support))
      upgradeTrigger = { level: a.support, side: "below" };
  }

  return {
    symbol: symbol.toUpperCase(),
    market,
    executionTimeframe: assessment.definition.executionTimeframe,
    intent: assessment.intent,
    verdict: assessment.verdict,
    direction: assessment.direction,
    isCounterTrend: assessment.isCounterTrend,
    sizeMultiplier: assessment.sizeMultiplier,
    headline: assessment.headline,
    summary: assessment.summary,
    triggers: assessment.triggers,
    confidence: assessment.confidence,
    plan: assessment.plan,
    setupType: assessment.execution.setupType,
    contextBias: assessment.contextBias,
    heldAt: new Date(nowMs).toISOString(),
    invalidation,
    upgradeTrigger,
    adoptedBecause,
  };
}

/**
 * Why an existing hold must be released in favor of the fresh assessment, or
 * null when the hold stands. `note` is surfaced in the UI so the user sees
 * what actually changed the answer.
 */
function releaseReason(
  held: HeldVerdict,
  fresh: IntentAssessment,
  nowMs: number,
): { note?: string } | null {
  const def = fresh.definition;
  const heldAtMs = Date.parse(held.heldAt);
  const maxAgeMs = INTENT_MAX_HOLD_BARS[held.intent] * STEP_SECONDS[def.executionTimeframe] * 1000;
  if (!Number.isFinite(heldAtMs) || nowMs - heldAtMs > maxAgeMs) return {};

  if (held.invalidation) {
    const lastClose = fresh.execution.analytics.lastClose;
    const broken =
      held.invalidation.side === "below"
        ? lastClose < held.invalidation.level
        : lastClose > held.invalidation.level;
    if (broken) {
      return {
        note: `${def.executionTimeframe} closed ${held.invalidation.side} ${fmtLevel(held.invalidation.level)}, releasing the prior "${held.headline}" read.`,
      };
    }
  }

  if (fresh.contextBias !== "none" && fresh.contextBias !== held.contextBias) {
    return {
      note: `The ${def.contextTimeframe} trend now leans ${fresh.contextBias} — the context this verdict was built on changed.`,
    };
  }

  const upgrade =
    VERDICT_RANK[fresh.verdict] > VERDICT_RANK[held.verdict] &&
    (held.direction === "none" || fresh.direction === held.direction);
  if (upgrade) {
    return fresh.verdict === "favored"
      ? { note: `Confirmation completed — upgraded from "${held.verdict}".` }
      : {};
  }

  return null;
}

/** Rebuilds the display assessment from a standing hold + fresh context. */
function displayFromHold(
  held: HeldVerdict,
  fresh: IntentAssessment,
  record?: RecordNote,
): DisplayIntentAssessment {
  return {
    ...fresh,
    verdict: held.verdict,
    direction: held.direction,
    isCounterTrend: held.isCounterTrend,
    sizeMultiplier: held.sizeMultiplier,
    headline: held.headline,
    summary: held.summary,
    triggers: held.triggers,
    confidence: held.confidence,
    plan: held.plan,
    hold: { heldAt: held.heldAt, isHeld: true, adoptedBecause: held.adoptedBecause },
    record,
  };
}

export interface ReconcileResult {
  display: DisplayIntentAssessment[];
  /** Hold records that changed and must be persisted (keyed by holdKey). */
  updates: Record<string, HeldVerdict>;
  /** Newly adopted verdicts that were favored pre-adjustment — shadow-record candidates. */
  openedFavored: IntentAssessment[];
}

export function reconcileHolds(input: {
  symbol: string;
  market: MarketType;
  entries: ReconcileEntry[];
  holds: Record<string, HeldVerdict>;
  nowMs: number;
}): ReconcileResult {
  const display: DisplayIntentAssessment[] = [];
  const updates: Record<string, HeldVerdict> = {};
  const openedFavored: IntentAssessment[] = [];

  for (const entry of input.entries) {
    const fresh = entry.assessment;
    const key = holdKey(input.symbol, input.market, fresh.intent);
    const held = input.holds[key];
    const release = held ? releaseReason(held, fresh, input.nowMs) : {};

    if (held && release === null) {
      display.push(displayFromHold(held, fresh, entry.record));
      continue;
    }

    const adopted = captureHold(fresh, input.symbol, input.market, input.nowMs, release?.note);
    updates[key] = adopted;
    if (entry.favoredBeforeAdjustment) openedFavored.push(fresh);
    display.push({
      ...fresh,
      hold: { heldAt: adopted.heldAt, isHeld: false, adoptedBecause: adopted.adoptedBecause },
      record: entry.record,
    });
  }

  return { display, updates, openedFavored };
}
