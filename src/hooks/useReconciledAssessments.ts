import { useEffect, useMemo } from "react";

import { evaluateSymbol } from "@/lib/engine/evaluate";
import { type DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { type ZonesByTimeframe } from "@/lib/engine/intent";
import { shadowComboStats } from "@/lib/engine/shadow";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { useAnticipatorySignalsStore } from "@/stores/anticipatory-signals";
import { useShadowSignalsStore } from "@/stores/shadow-signals";
import { useVerdictHoldsStore } from "@/stores/verdict-holds";
import type { MarketType } from "@/lib/engine/binance";
import type { PerpRead } from "@/lib/engine/perp";
import type { SessionLevel } from "@/lib/engine/sessions";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

/**
 * The full decision pipeline for one token, wrapping the framework-free
 * `evaluateSymbol` (shared verbatim with the server worker) in React state:
 * raw per-intent assessments → live shadow-record adjustment (demote combos
 * with a proven bad record) → verdict hysteresis. The two persistence effects
 * run after render: adopt/refresh the held verdicts, and open shadow +
 * anticipatory records. Combo stats are segmented to the current
 * `ENGINE_VERSION` so a proven-negative record from an older engine can't
 * demote the current one.
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

  const comboStats = useMemo(
    () => shadowComboStats(shadowSignals, ENGINE_VERSION),
    [shadowSignals],
  );

  const result = useMemo(() => {
    return evaluateSymbol({
      symbol,
      market,
      evalsByTimeframe,
      zonesByTimeframe,
      perp,
      sessionLevels,
      comboStats,
      holds,
      nowMs: Date.now(),
    });
    // `holds` is intentionally excluded: re-running on our own persisted write
    // would loop. A fresh evaluation (new evals) is what re-reconciles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, market, evalsByTimeframe, zonesByTimeframe, perp, sessionLevels, comboStats]);

  useEffect(() => {
    if (!ready || !result) return;
    if (Object.keys(result.holdUpdates).length > 0) applyHolds(result.holdUpdates);
    for (const input of result.shadowToOpen) openShadow(input);
    // Phase 0.5: every displayed assessment with an anticipatory plan opens a
    // fill-model record — at any verdict stage, since a resting limit exists
    // precisely while the trigger is unconfirmed. The store ignores the call
    // while the same symbol/market/intent record is still open, so the plan
    // is frozen at adoption (EDR 0010). Measurement only; read by no verdict.
    for (const input of result.anticipatoryToOpen) openAnticipatory(input);
  }, [ready, result, applyHolds, openShadow, openAnticipatory]);

  return result?.display ?? [];
}
