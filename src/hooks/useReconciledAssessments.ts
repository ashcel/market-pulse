import { useEffect, useMemo } from "react";

import { evaluateSymbol } from "@/lib/engine/evaluate";
import { type DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { type ZonesByTimeframe } from "@/lib/engine/intent";
import { useForwardTestRecord } from "@/hooks/useForwardTestRecord";
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
 * with a proven bad record) → verdict hysteresis. Combo stats come read-only
 * from the server's forward-test record (WS5) — the autonomous worker is the
 * sole writer of shadow/anticipatory records now, so this hook only adopts
 * held verdicts locally and otherwise just displays the server's read.
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
  const { data: forwardTest } = useForwardTestRecord();
  const comboStats = forwardTest?.shadow.combos ?? [];

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
  }, [ready, result, applyHolds]);

  return result?.display ?? [];
}
