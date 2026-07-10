import { computeAlignment } from "@/lib/engine/alignment";
import { evaluateSymbol } from "@/lib/engine/evaluate";
import { UNIVERSE } from "@/lib/engine/market";
import { shadowComboStats } from "@/lib/engine/shadow";
import { ENGINE_VERSION } from "@/lib/engine/version";
import {
  loadHolds,
  loadShadowSignals,
  openAnticipatory,
  openShadow,
  upsertHolds,
} from "../db/repo";
import type { ZonesByTimeframe } from "@/lib/engine/intent";
import type { MarketType } from "@/lib/engine/binance";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

/**
 * One evaluation pass over the whole tracked universe (Phase C). This is the
 * server-side replacement for the browser-gated open path: the engine is run
 * for every asset on a schedule — whether or not anyone is looking — so the
 * shadow/anticipatory record is unbiased. Runs the exact `evaluateSymbol`
 * pipeline the UI uses, stamped with the current engine provenance.
 */
export async function runEvalPass(
  engineRunId: string,
  market: MarketType = "spot",
): Promise<{
  evaluated: number;
  shadowOpened: number;
  anticipatoryOpened: number;
}> {
  const comboStats = shadowComboStats(await loadShadowSignals(ENGINE_VERSION), ENGINE_VERSION);
  let evaluated = 0;
  let shadowOpened = 0;
  let anticipatoryOpened = 0;

  for (const asset of UNIVERSE) {
    const symbol = asset.ticker;
    try {
      const alignment = await computeAlignment(symbol, {}, market);
      if (alignment.length === 0) continue;

      const evalsByTimeframe: Partial<Record<TokenTimeframe, SignalEvaluation>> = {};
      const zonesByTimeframe: ZonesByTimeframe = {};
      for (const entry of alignment) {
        evalsByTimeframe[entry.timeframe] = entry.evaluation;
        zonesByTimeframe[entry.timeframe] = entry.zones;
      }

      const holds = await loadHolds(symbol, market);
      const result = evaluateSymbol({
        symbol,
        market,
        evalsByTimeframe,
        zonesByTimeframe,
        perp: null,
        sessionLevels: [],
        comboStats,
        holds,
        nowMs: Date.now(),
      });
      if (!result) continue;
      evaluated += 1;

      await upsertHolds(symbol, market, result.holdUpdates);
      for (const input of result.shadowToOpen) {
        await openShadow(input, engineRunId);
        shadowOpened += 1;
      }
      for (const input of result.anticipatoryToOpen) {
        await openAnticipatory(input, engineRunId);
        anticipatoryOpened += 1;
      }
    } catch (err) {
      console.error(`[eval] ${symbol} failed:`, (err as Error).message);
    }
  }

  return { evaluated, shadowOpened, anticipatoryOpened };
}
