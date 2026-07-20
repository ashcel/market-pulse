import { useQueries } from "@tanstack/react-query";
import { useAssets } from "./queries";
import { fetchTimeframeAlignment } from "@/lib/engine/alignment";
import { assessIntents } from "@/lib/engine/intent";
import type { IntentAssessment } from "@/lib/engine/intent";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { ZonesByTimeframe } from "@/lib/engine/intent";
import { usePreferencesStore } from "@/stores/preferences";

export interface ActionableSetup {
  ticker: string;
  assessment: IntentAssessment;
  proximity: number;
}

export function useActionableSetups() {
  const { data: assets, isLoading: assetsLoading } = useAssets();
  const market = usePreferencesStore((s) => s.marketType);
  const risk = usePreferencesStore((s) => s.risk);

  // Focus on candidates that the 1H engine already flagged
  const candidates = (assets || []).filter(
    (a) => a.decision === "buy-candidate" || a.decision === "short-candidate"
  );

  const queries = useQueries({
    queries: candidates.map((c) => ({
      queryKey: [
        "tf-alignment",
        c.ticker,
        market,
        risk.accountSize,
        risk.maxRiskPerTradePercent,
        risk.minimumRewardRisk,
        risk.stopMethod,
      ],
      queryFn: () => fetchTimeframeAlignment(c.ticker, risk, market),
      staleTime: 60_000,
    })),
  });

  const isLoading = assetsLoading || queries.some((q) => q.isLoading);

  if (isLoading || !assets) return { data: undefined, isLoading: true };

  const actionable: ActionableSetup[] = [];

  queries.forEach((q, i) => {
    if (!q.data) return;
    const evalsByTimeframe: Partial<Record<TokenTimeframe, SignalEvaluation>> = {};
    const zonesByTimeframe: ZonesByTimeframe = {};
    for (const entry of q.data) {
      evalsByTimeframe[entry.timeframe] = entry.evaluation;
      zonesByTimeframe[entry.timeframe] = entry.zones;
    }

    const assessments = assessIntents(evalsByTimeframe, zonesByTimeframe);
    const ticker = candidates[i].ticker;
    const currentPrice = candidates[i].price;

    for (const a of assessments) {
      if (a.verdict === "avoid") continue;
      
      const targetPrice = a.plan?.entry ?? a.anticipatoryPlan?.entry;
      const proximity = targetPrice 
        ? Math.abs(currentPrice - targetPrice) / currentPrice 
        : Infinity;

      actionable.push({ ticker, assessment: a, proximity });
    }
  });

  actionable.sort((a, b) => a.proximity - b.proximity);
  
  // Return the top 3
  return { data: actionable.slice(0, 3), isLoading: false };
}
