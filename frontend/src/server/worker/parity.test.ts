import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeAlignment } from "@/lib/engine/alignment";
import { evaluateSymbol, type EvaluateInput } from "@/lib/engine/evaluate";
import { fetchSessionLevels } from "@/lib/engine/sessions";
import { installFakeBinance } from "./__fixtures__/fake-binance";
import { assembleEvaluateInputs } from "./eval-pass";
import type { ZonesByTimeframe } from "@/lib/engine/intent";
import type { MarketType } from "@/lib/engine/binance";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

/**
 * WS2 — one integration test that runs a symbol through both the worker's
 * assembled path (`assembleEvaluateInputs`) and the UI's own build of the
 * same `evaluateSymbol` call (`useReconciledAssessments`, mirrored here without
 * React), and asserts the full decision output — `display`, `shadowToOpen`,
 * `anticipatoryToOpen` — is identical. WS1 already proved the *inputs* match;
 * this proves the *decisions* match too, including with the UI's actual
 * default risk preferences (accountSize 10k) against the worker's unscoped
 * defaults (accountSize 100k via CRYPTO_RISK_SETTINGS) — the one input that's
 * allowed to differ, and it must not move the recorded fields.
 */

const FIXED_NOW = Date.UTC(2026, 6, 10, 12, 0, 0);

// Fields that are allowed to differ between the two paths because they are
// either wall-clock metadata (`evaluatedAt`, stamped inside `evaluateSignal`
// at call time — unused elsewhere, never persisted) or dollar-figure sizing
// derived from `accountSize` (which the worker deliberately leaves at the
// CRYPTO_RISK_SETTINGS default rather than any one tester's preference). None
// of these are part of a shadow/anticipatory record — only entry/stop/target/
// confidence are — so excluding them from the `display` comparison still
// proves everything that gets recorded or that drives a verdict is identical.
const VOLATILE_KEYS = new Set([
  "evaluatedAt",
  "maxDollarRisk",
  "maxDollarLoss",
  "positionSize",
  "estimatedGain1",
  "estimatedGain2",
]);

function stripVolatile<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripVolatile) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out as T;
  }
  return value;
}

// The token page's `usePreferencesStore` default risk block (src/stores/preferences.ts) —
// what a tester who has never touched risk settings gets, passed to `computeAlignment`
// as the UI does. The worker calls `computeAlignment(symbol, {}, market)` instead.
const UI_DEFAULT_RISK = {
  accountSize: 10_000,
  maxRiskPerTradePercent: 0.5,
  minimumRewardRisk: 1.6,
  stopMethod: "swing" as const,
};

async function buildUiEquivalentInputs(
  symbol: string,
  market: "spot" | "perp",
): Promise<
  Pick<EvaluateInput, "evalsByTimeframe" | "zonesByTimeframe" | "sessionLevels" | "perp">
> {
  const [alignment, sessionLevels] = await Promise.all([
    computeAlignment(symbol, UI_DEFAULT_RISK, market),
    fetchSessionLevels(symbol, market),
  ]);
  const evalsByTimeframe: Partial<Record<TokenTimeframe, SignalEvaluation>> = {};
  const zonesByTimeframe: ZonesByTimeframe = {};
  for (const entry of alignment) {
    evalsByTimeframe[entry.timeframe] = entry.evaluation;
    zonesByTimeframe[entry.timeframe] = entry.zones;
  }
  return { evalsByTimeframe, zonesByTimeframe, sessionLevels, perp: null };
}

describe("worker/UI decision parity (WS2)", () => {
  beforeEach(() => {
    installFakeBinance();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("produces identical display/shadowToOpen/anticipatoryToOpen for the same symbol", async () => {
    const symbol = "BTC";
    const market: MarketType = "spot";

    const worker = await assembleEvaluateInputs(symbol, market);
    const ui = await buildUiEquivalentInputs(symbol, market);
    expect(worker).not.toBeNull();
    if (!worker) return;

    const shared = { symbol, market, comboStats: [], holds: {}, nowMs: FIXED_NOW };
    const workerResult = evaluateSymbol({ ...shared, ...worker });
    const uiResult = evaluateSymbol({ ...shared, ...ui });

    expect(workerResult).not.toBeNull();
    expect(uiResult).not.toBeNull();
    expect(stripVolatile(workerResult?.display)).toEqual(stripVolatile(uiResult?.display));
    // Nothing to strip here — these are exactly what a record persists, so a
    // plain deep-equal is the honest check the plan asks for.
    expect(workerResult?.shadowToOpen).toEqual(uiResult?.shadowToOpen);
    expect(workerResult?.anticipatoryToOpen).toEqual(uiResult?.anticipatoryToOpen);
    expect(stripVolatile(workerResult?.holdUpdates)).toEqual(stripVolatile(uiResult?.holdUpdates));
  });

  it("holds across the tracked universe's assets, not just one symbol", async () => {
    for (const symbol of ["BTC", "SOL", "DOGE"]) {
      const worker = await assembleEvaluateInputs(symbol, "spot");
      const ui = await buildUiEquivalentInputs(symbol, "spot");
      if (!worker) continue;

      const shared = {
        symbol,
        market: "spot" as const,
        comboStats: [],
        holds: {},
        nowMs: FIXED_NOW,
      };
      const workerResult = evaluateSymbol({ ...shared, ...worker });
      const uiResult = evaluateSymbol({ ...shared, ...ui });

      expect(stripVolatile(workerResult?.display), `${symbol} display diverged`).toEqual(
        stripVolatile(uiResult?.display),
      );
      expect(workerResult?.shadowToOpen, `${symbol} shadowToOpen diverged`).toEqual(
        uiResult?.shadowToOpen,
      );
      expect(workerResult?.anticipatoryToOpen, `${symbol} anticipatoryToOpen diverged`).toEqual(
        uiResult?.anticipatoryToOpen,
      );
    }
  });
});
