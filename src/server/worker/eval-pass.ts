import { computeAlignment } from "@/lib/engine/alignment";
import { evaluateSymbol } from "@/lib/engine/evaluate";
import { UNIVERSE } from "@/lib/engine/market";
import { fetchSessionLevels } from "@/lib/engine/sessions";
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

export interface AssembledInputs {
  evalsByTimeframe: Partial<Record<TokenTimeframe, SignalEvaluation>>;
  zonesByTimeframe: ZonesByTimeframe;
  sessionLevels: Awaited<ReturnType<typeof fetchSessionLevels>>;
  /** Spot-only for v1 — see `runEvalPass` doc. */
  perp: null;
}

/**
 * Build the non-worker-specific half of an `evaluateSymbol` call for one
 * symbol: per-timeframe evals/zones (`computeAlignment`) and session levels
 * (`fetchSessionLevels`) — the exact two functions the UI's
 * `useTimeframeAlignment`/`useSessionLevels` hooks resolve to server-side, so
 * this is provably the same input the token page would build, not a
 * lookalike reimplementation. `comboStats`/`holds`/`nowMs` stay the caller's
 * job since worker (DB) and UI (stores) source them differently.
 */
export async function assembleEvaluateInputs(
  symbol: string,
  market: MarketType,
): Promise<AssembledInputs | null> {
  const [alignment, sessionLevels] = await Promise.all([
    computeAlignment(symbol, {}, market),
    fetchSessionLevels(symbol, market),
  ]);
  if (alignment.length === 0) return null;

  const evalsByTimeframe: Partial<Record<TokenTimeframe, SignalEvaluation>> = {};
  const zonesByTimeframe: ZonesByTimeframe = {};
  for (const entry of alignment) {
    evalsByTimeframe[entry.timeframe] = entry.evaluation;
    zonesByTimeframe[entry.timeframe] = entry.zones;
  }
  return { evalsByTimeframe, zonesByTimeframe, sessionLevels, perp: null };
}

/**
 * One evaluation pass over the whole tracked universe (Phase C). This is the
 * server-side replacement for the browser-gated open path: the engine is run
 * for every asset on a schedule — whether or not anyone is looking — so the
 * shadow/anticipatory record is unbiased. Runs the exact `evaluateSymbol`
 * pipeline the UI uses, stamped with the current engine provenance.
 *
 * Spot-only for v1 (`perp: null` matches the UI's spot read exactly — spot has
 * no funding/OI context to omit). A perp pass is a deliberate later addition
 * with its own `fetchPerpContext` call, not a silent gap in this one.
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
      const assembled = await assembleEvaluateInputs(symbol, market);
      if (!assembled) continue;

      const holds = await loadHolds(symbol, market);
      const result = evaluateSymbol({
        symbol,
        market,
        ...assembled,
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
