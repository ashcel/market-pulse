import { useEffect, useMemo } from "react";

import { buildAnticipatorySignal } from "@/lib/engine/anticipatory";
import { assessIntents, type ZonesByTimeframe } from "@/lib/engine/intent";
import { reconcileHolds, type DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { applyRecordAdjustment, buildShadowSignal, shadowComboStats } from "@/lib/engine/shadow";
import { useAnticipatorySignalsStore } from "@/stores/anticipatory-signals";
import { useShadowSignalsStore } from "@/stores/shadow-signals";
import { useVerdictHoldsStore } from "@/stores/verdict-holds";
import type { MarketType } from "@/lib/engine/binance";
import type { PerpRead } from "@/lib/engine/perp";
import type { SessionLevel } from "@/lib/engine/sessions";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

/**
 * The full decision pipeline for one token: raw per-intent assessments →
 * live shadow-record adjustment (demote combos with a proven bad record) →
 * verdict hysteresis (hold each verdict until its own trigger breaks). The
 * two persistence effects run after render: adopt/refresh the held verdicts,
 * and open a shadow record for every newly-favored call.
 */
export function useReconciledAssessments(
  symbol: string,
  market: MarketType,
  evalsByTimeframe: Partial<Record<TokenTimeframe, SignalEvaluation>>,
  zonesByTimeframe: ZonesByTimeframe,
  perp: PerpRead | null,
  sessionLevels: SessionLevel[],
  ready: boolean,
): DisplayIntentAssessment[] {
  const holds = useVerdictHoldsStore((s) => s.holds);
  const applyHolds = useVerdictHoldsStore((s) => s.applyHolds);
  const shadowSignals = useShadowSignalsStore((s) => s.signals);
  const openShadow = useShadowSignalsStore((s) => s.open);
  const openAnticipatory = useAnticipatorySignalsStore((s) => s.open);

  const comboStats = useMemo(() => shadowComboStats(shadowSignals), [shadowSignals]);

  const result = useMemo(() => {
    const raw = assessIntents(evalsByTimeframe, zonesByTimeframe, perp, sessionLevels);
    if (raw.length === 0) return null;
    const entries = raw.map((assessment) => applyRecordAdjustment(assessment, comboStats));
    return reconcileHolds({ symbol, market, entries, holds, nowMs: Date.now() });
    // `holds` is intentionally excluded: re-running on our own persisted write
    // would loop. A fresh evaluation (new evals) is what re-reconciles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, market, evalsByTimeframe, zonesByTimeframe, perp, sessionLevels, comboStats]);

  useEffect(() => {
    if (!ready || !result) return;
    if (Object.keys(result.updates).length > 0) applyHolds(result.updates);
    for (const assessment of result.openedFavored) {
      const input = buildShadowSignal(assessment, symbol, market, new Date().toISOString());
      if (input) openShadow(input);
    }
    // Phase 0.5: every displayed assessment with an anticipatory plan opens a
    // fill-model record — at any verdict stage, since a resting limit exists
    // precisely while the trigger is unconfirmed. The store ignores the call
    // while the same symbol/market/intent record is still open, so the plan
    // is frozen at adoption (EDR 0010). Measurement only; read by no verdict.
    for (const assessment of result.display) {
      const input = buildAnticipatorySignal(assessment, symbol, market, new Date().toISOString());
      if (input) openAnticipatory(input);
    }
  }, [ready, result, applyHolds, openShadow, openAnticipatory, symbol, market]);

  return result?.display ?? [];
}
