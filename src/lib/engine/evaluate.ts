import { buildAnticipatorySignal, type AnticipatorySignal } from "./anticipatory";
import { reconcileHolds, type DisplayIntentAssessment, type HeldVerdict } from "./hysteresis";
import { assessIntents, type ZonesByTimeframe } from "./intent";
import {
  applyRecordAdjustment,
  buildShadowSignal,
  type ShadowComboStat,
  type ShadowSignal,
} from "./shadow";
import type { MarketType } from "./binance";
import type { TokenTimeframe } from "./mock-candles";
import type { PerpRead } from "./perp";
import type { SignalEvaluation } from "./quant";
import type { SessionLevel } from "./sessions";

/**
 * The framework-free decision pipeline for one token (Phase A′). This is the
 * exact `assess → record-adjust → reconcile-holds → open records` sequence that
 * `useReconciledAssessments` used to inline, lifted out so the **server worker**
 * (the forward-test system of record) and the **client hook** (live UI) run one
 * identical code path. No React, no stores, no I/O — pure in, pure out.
 */

export interface EvaluateInput {
  symbol: string;
  market: MarketType;
  evalsByTimeframe: Partial<Record<TokenTimeframe, SignalEvaluation>>;
  zonesByTimeframe: ZonesByTimeframe;
  perp: PerpRead | null;
  sessionLevels: SessionLevel[];
  /** Live shadow-record combo stats used to demote proven-negative setups. */
  comboStats: ShadowComboStat[];
  /** Standing verdict holds keyed by holdKey (the caller owns persistence). */
  holds: Record<string, HeldVerdict>;
  nowMs: number;
}

export type ShadowOpenInput = Omit<ShadowSignal, "id" | "status">;
export type AnticipatoryOpenInput = Omit<AnticipatorySignal, "id" | "status">;

export interface EvaluateOutput {
  /** What the UI shows (verdicts after hysteresis + record adjustment). */
  display: DisplayIntentAssessment[];
  /** Hold records that changed and must be persisted, keyed by holdKey. */
  holdUpdates: Record<string, HeldVerdict>;
  /** Newly-favored calls to open in the shadow record. */
  shadowToOpen: ShadowOpenInput[];
  /** Every displayed plan opens/refreshes an anticipatory fill record (EDR 0010). */
  anticipatoryToOpen: AnticipatoryOpenInput[];
}

export function evaluateSymbol(input: EvaluateInput): EvaluateOutput | null {
  const raw = assessIntents(
    input.evalsByTimeframe,
    input.zonesByTimeframe,
    input.perp,
    input.sessionLevels,
  );
  if (raw.length === 0) return null;

  const entries = raw.map((assessment) => applyRecordAdjustment(assessment, input.comboStats));
  const result = reconcileHolds({
    symbol: input.symbol,
    market: input.market,
    entries,
    holds: input.holds,
    nowMs: input.nowMs,
  });

  const nowIso = new Date(input.nowMs).toISOString();
  const shadowToOpen = result.openedFavored
    .map((a) => buildShadowSignal(a, input.symbol, input.market, nowIso))
    .filter((x): x is ShadowOpenInput => x !== null);
  const anticipatoryToOpen = result.display
    .map((a) => buildAnticipatorySignal(a, input.symbol, input.market, nowIso))
    .filter((x): x is AnticipatoryOpenInput => x !== null);

  return {
    display: result.display,
    holdUpdates: result.updates,
    shadowToOpen,
    anticipatoryToOpen,
  };
}
