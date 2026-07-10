/**
 * Captures the decision-bearing surface of `evaluateSignal` over the
 * deterministic mock-candle universe, as the inertness baseline for Phase 0
 * instrumentation (research/analysis.md §9): additive annotation fields must
 * leave every one of these fields byte-identical.
 *
 *   bun run research/scripts/generate-inertness-snapshots.ts
 *
 * Regenerate ONLY when a deliberate, documented verdict-affecting change
 * lands — regenerating to quiet a failing inertness test defeats the test.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computePivots } from "../../src/lib/engine/analysis";
import { generateMockCandles } from "../../src/lib/engine/mock-candles";
import { evaluateSignal } from "../../src/lib/engine/quant";

export const INERTNESS_CASES = [
  { symbol: "BTC", timeframe: "1H", bars: 240 },
  { symbol: "BTC", timeframe: "4H", bars: 400 },
  { symbol: "ETH", timeframe: "1H", bars: 240 },
  { symbol: "SOL", timeframe: "4H", bars: 400 },
  { symbol: "DOGE", timeframe: "1H", bars: 320 },
  { symbol: "PEPE", timeframe: "4H", bars: 320 },
] as const;

/** The decision-bearing fields the inertness regression pins (no evaluatedAt — it is a wall-clock timestamp). */
export function decisionSurface(evaluation: ReturnType<typeof evaluateSignal>) {
  const {
    symbol,
    setupType,
    decision,
    direction,
    lean,
    regime,
    confidence,
    components,
    noTradeReasons,
    reason,
    risk,
    analytics,
    backtest,
    strategyVersion,
  } = evaluation;
  return {
    symbol,
    setupType,
    decision,
    direction,
    lean,
    regime,
    confidence,
    components,
    noTradeReasons,
    reason,
    risk,
    analytics,
    backtest,
    strategyVersion,
  };
}

const snapshots = INERTNESS_CASES.map((c) => {
  const candles = generateMockCandles(c.symbol, c.timeframe, c.bars);
  const evaluation = evaluateSignal(c.symbol, candles, computePivots(candles));
  return { case: c, surface: decisionSurface(evaluation) };
});

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/engine/__fixtures__");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "inertness-snapshots.json"), JSON.stringify(snapshots, null, 1));
console.log(`Wrote ${snapshots.length} snapshots`);
