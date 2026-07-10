import { INTENT_MAX_HOLD_BARS } from "./hysteresis";
import { STEP_SECONDS } from "./mock-candles";
import type { MarketType } from "./binance";
import type { IntentAssessment, IntentVerdict, TradingIntent } from "./intent";
import type { TokenTimeframe } from "./mock-candles";
import type { MarketRegime, SetupType } from "./quant";
import type { SwingStrength } from "./strength";
import type { Candle } from "./types";

/**
 * Phase 0.5 — the limit-fill / no-fill harness over `AnticipatoryPlan`.
 *
 * A shadow record (shadow.ts) grades calls that enter at the live price; an
 * anticipatory plan instead rests a limit at a POI below the market and may
 * simply never fill. Grading it honestly therefore needs a third outcome:
 * **never-filled is neither a win nor a loss** — it carries no R — and a fill
 * model must decide *when* the position exists before any stop/objective walk
 * can run. Without this, no expectancy claim about anticipatory entries is
 * honest (risk R5); the Phase 1 graduation gate (target cap + G10 veto)
 * reads this record before anything goes live.
 *
 * Records are kept in their own store, never mixed into the shadow record's
 * setupType|regime combo stats — those drive live verdict demotions, and this
 * harness must stay measurement-only (R2).
 * See docs/decisions/0010-anticipatory-fill-model.md.
 */

export type AnticipatorySignalStatus =
  | "pending" // limit resting, not yet filled
  | "never-filled" // horizon expired without a touch — its own graded outcome, no R
  | "filled" // position open, neither stop nor objective reached yet
  | "objective-hit"
  | "stopped-out"
  | "expired"; // filled, then went nowhere within the hold window

const OPEN_STATUSES: readonly AnticipatorySignalStatus[] = ["pending", "filled"];

export function isOpenAnticipatoryStatus(status: AnticipatorySignalStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export interface AnticipatorySignal {
  id: string;
  symbol: string;
  market: MarketType;
  intent: TradingIntent;
  direction: "long" | "short";
  /** Execution-timeframe setup/regime at adoption — comparable to the shadow record's cohorts. */
  setupType: SetupType;
  regime: MarketRegime;
  timeframe: TokenTimeframe;
  /**
   * The verdict at adoption. Anticipation is recorded at *every* verdict
   * stage — a resting limit exists precisely while the trigger is still
   * unconfirmed, so "does anticipation during wait pay like it does during
   * favored?" is a question this field lets the analysis ask.
   */
  verdict: IntentVerdict;
  /** The limit price — the POI's proximal edge. */
  entry: number;
  /** Beyond the POI's distal edge (EDR 0009). */
  stop: number;
  /** The preferred draw-on-liquidity objective's price (EDR 0008). */
  objective: number;
  objectiveStrength: SwingStrength;
  zoneFreshness: "fresh" | "tested";
  /** Planned RR from the limit, frozen at adoption. */
  rewardRisk: number;
  openedAt: string;
  status: AnticipatorySignalStatus;
  /** Open time (ISO) of the closed bar that touched the limit. */
  filledAt?: string;
  closedAt?: string;
  closePrice?: number;
  /** Realized R measured from the limit; absent for never-filled — no position, no R. */
  resultR?: number;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Builds the record for an assessment whose anticipatory plan should start
 * being graded; null when the assessment has no plan. The record freezes the
 * plan at adoption — a resting limit stays where it was placed; if the
 * derived plan later moves, the next record (after this one settles) grades
 * the new one.
 */
export function buildAnticipatorySignal(
  assessment: IntentAssessment,
  symbol: string,
  market: MarketType,
  nowIso: string,
): Omit<AnticipatorySignal, "id" | "status"> | null {
  const plan = assessment.anticipatoryPlan;
  if (!plan) return null;
  return {
    symbol: symbol.toUpperCase(),
    market,
    intent: assessment.intent,
    direction: plan.direction,
    setupType: assessment.execution.setupType,
    regime: assessment.execution.regime,
    timeframe: assessment.definition.executionTimeframe,
    verdict: assessment.verdict,
    entry: plan.entry,
    stop: plan.stop,
    objective: plan.objective.price,
    objectiveStrength: plan.objective.strength,
    zoneFreshness: plan.zone.freshness,
    rewardRisk: round(plan.rewardRisk),
    openedAt: nowIso,
  };
}

/**
 * Walks the filled position over closed bars, the fill bar first. Within a
 * bar the stop is checked before the objective (the walkExitLevels
 * convention). The fill bar itself is asymmetric: only the stop can resolve
 * on it — the bar was travelling *into* the limit, so a same-bar stop print
 * is plausible continuation, while a same-bar objective print may have
 * happened before the fill existed and gets no credit (EDR 0010).
 */
function walkFilledPosition(
  signal: AnticipatorySignal,
  bars: Candle[],
  firstIsFillBar: boolean,
  maxBars: number,
  closedAtOf: (barTime: number) => string,
): Partial<AnticipatorySignal> | null {
  const long = signal.direction === "long";
  const riskPerUnit = Math.abs(signal.entry - signal.stop);
  const resultR = (exit: number) =>
    riskPerUnit > 0 ? round((long ? exit - signal.entry : signal.entry - exit) / riskPerUnit) : 0;

  const window = bars.slice(0, maxBars);
  for (const [i, bar] of window.entries()) {
    if (long ? bar.low <= signal.stop : bar.high >= signal.stop) {
      return {
        status: "stopped-out",
        closePrice: signal.stop,
        closedAt: closedAtOf(bar.time),
        resultR: resultR(signal.stop),
      };
    }
    if (i === 0 && firstIsFillBar) continue;
    if (long ? bar.high >= signal.objective : bar.low <= signal.objective) {
      return {
        status: "objective-hit",
        closePrice: signal.objective,
        closedAt: closedAtOf(bar.time),
        resultR: resultR(signal.objective),
      };
    }
  }

  if (window.length >= maxBars) {
    const last = window[maxBars - 1];
    return {
      status: "expired",
      closePrice: last.close,
      closedAt: closedAtOf(last.time),
      resultR: resultR(last.close),
    };
  }
  return null;
}

/**
 * Settles one anticipatory record against closed bars. Re-entrant: called
 * repeatedly as new bars close, it returns the next patch to merge or null
 * when nothing changed, and a patch it has issued can never be contradicted
 * by later data (fills and level touches cannot un-happen; horizons only
 * complete once).
 *
 * Pending: the first closed bar after adoption whose range touches the limit
 * (inclusive) fills it — first-touch-decides, fill modeled at the limit price
 * exactly. No touch within the intent's holding horizon closes the record
 * "never-filled" with no R. On a fill the position walk continues in the
 * same pass, so a single settlement can move pending → stopped-out.
 */
export function settleAnticipatorySignal(
  signal: AnticipatorySignal,
  closedBars: Candle[],
): Partial<AnticipatorySignal> | null {
  const openedAtSec = Date.parse(signal.openedAt) / 1000;
  if (!Number.isFinite(openedAtSec)) return null;
  const maxBars = INTENT_MAX_HOLD_BARS[signal.intent];
  const step = STEP_SECONDS[signal.timeframe];
  const closedAtOf = (barTime: number) => new Date((barTime + step) * 1000).toISOString();
  const long = signal.direction === "long";
  const touchesLimit = (bar: Candle) => (long ? bar.low <= signal.entry : bar.high >= signal.entry);

  if (signal.status === "pending") {
    const bars = closedBars.filter((c) => c.time > openedAtSec).slice(0, maxBars);
    const fillIndex = bars.findIndex(touchesLimit);
    if (fillIndex === -1) {
      if (bars.length >= maxBars) {
        return { status: "never-filled", closedAt: closedAtOf(bars[maxBars - 1].time) };
      }
      return null; // still resting
    }
    const filledAt = new Date(bars[fillIndex].time * 1000).toISOString();
    // The position walk sees every bar from the fill onward — its horizon is
    // maxBars from the fill, not from adoption, so a filled anticipatory
    // record gets the same hold window a shadow record does.
    const positionBars = closedBars.filter((c) => c.time >= bars[fillIndex].time);
    const outcome = walkFilledPosition(signal, positionBars, true, maxBars, closedAtOf);
    return { status: "filled", filledAt, ...outcome };
  }

  if (signal.status === "filled") {
    const filledAtSec = signal.filledAt ? Date.parse(signal.filledAt) / 1000 : Number.NaN;
    if (!Number.isFinite(filledAtSec)) return null;
    const bars = closedBars.filter((c) => c.time >= filledAtSec);
    if (bars.length === 0) return null;
    // The fill-bar asymmetry only applies when the batch actually starts at
    // the fill bar; a shorter fetch window starting later walks normally.
    return walkFilledPosition(signal, bars, bars[0].time === filledAtSec, maxBars, closedAtOf);
  }

  return null; // terminal
}

export interface AnticipatoryRecordSummary {
  total: number;
  /** Limits still resting. */
  pending: number;
  /** Positions filled and still open. */
  open: number;
  neverFilled: number;
  /** Filled records, settled or not. */
  filled: number;
  /** filled ÷ (filled + neverFilled) — how often the pullback actually comes. */
  fillRate: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Average R over settled positions only — never-filled carries no R by design. */
  averageR: number;
  lowSample: boolean;
}

/** Below this many settled positions the record is noise, not evidence (same bar as shadow). */
export const MIN_ANTICIPATORY_RECORD_TRADES = 15;

export function summarizeAnticipatoryRecord(
  signals: AnticipatorySignal[],
): AnticipatoryRecordSummary {
  const pending = signals.filter((s) => s.status === "pending");
  const open = signals.filter((s) => s.status === "filled");
  const neverFilled = signals.filter((s) => s.status === "never-filled");
  const settled = signals.filter(
    (s) => s.status === "objective-hit" || s.status === "stopped-out" || s.status === "expired",
  );
  const filled = open.length + settled.length;
  const fillDecided = filled + neverFilled.length;
  const wins = settled.filter((s) => (s.resultR ?? 0) > 0);
  const losses = settled.filter((s) => s.status === "stopped-out");
  const rValues = settled.map((s) => s.resultR ?? 0);
  const averageR = rValues.length ? rValues.reduce((sum, r) => sum + r, 0) / rValues.length : 0;

  return {
    total: signals.length,
    pending: pending.length,
    open: open.length,
    neverFilled: neverFilled.length,
    filled,
    fillRate: fillDecided ? round((filled / fillDecided) * 100, 1) : 0,
    settled: settled.length,
    wins: wins.length,
    losses: losses.length,
    winRate: settled.length ? round((wins.length / settled.length) * 100, 1) : 0,
    averageR: round(averageR),
    lowSample: settled.length > 0 && settled.length < MIN_ANTICIPATORY_RECORD_TRADES,
  };
}
