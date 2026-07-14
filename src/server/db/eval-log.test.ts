import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "./client";
import { insertEvalLog, getEvalLogsForSymbol, logEvalAssessments } from "./eval-log";
import { startEngineRun } from "./repo";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";

const TEST_SYMBOL = "TESTEVALZZZ";

async function cleanup() {
  await sql`delete from eval_log where symbol = ${TEST_SYMBOL}`;
  await sql`delete from engine_run where universe_json::text like ${"%" + TEST_SYMBOL + "%"}`;
}

beforeAll(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("eval_log repository (P5)", () => {
  it("inserts and retrieves eval_log records with correct field mappings", async () => {
    const engineRunId = await startEngineRun(
      { engineVersion: "test-engine", configHash: "test-hash", gitSha: "test-sha" },
      { symbols: [TEST_SYMBOL] },
    );

    const input = {
      engineRunId,
      symbol: TEST_SYMBOL,
      market: "spot" as const,
      intent: "intraday",
      verdict: "favored",
      direction: "long",
      setupType: "breakout",
      regime: "trending-up",
      timeframe: "1H",
      confidence: 0.85,
      btWinRate: 0.92,
      btExpectancy: 2.1,
      btAvgR: 1.5,
      btTotalTrades: 120,
      btLowSample: false,
      noTradeReasons: ["liquidity-pool-too-far"],
      componentScores: { trend: { score: 80, status: "pass" } },
    };

    await insertEvalLog(input);

    const logs = await getEvalLogsForSymbol(TEST_SYMBOL, "spot");
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.symbol).toBe(TEST_SYMBOL);
    expect(log.market).toBe("spot");
    expect(log.intent).toBe("intraday");
    expect(log.verdict).toBe("favored");
    expect(log.direction).toBe("long");
    expect(log.setupType).toBe("breakout");
    expect(log.regime).toBe("trending-up");
    expect(log.timeframe).toBe("1H");
    expect(log.confidence).toBe(0.85);
    expect(log.btWinRate).toBe(0.92);
    expect(log.btExpectancy).toBe(2.1);
    expect(log.btAvgR).toBe(1.5);
    expect(log.btTotalTrades).toBe(120);
    expect(log.btLowSample).toBe(false);

    // JSONB assertions (round-trip verification)
    expect(log.noTradeReasons).toEqual(["liquidity-pool-too-far"]);
    expect(log.componentScores).toEqual({ trend: { score: 80, status: "pass" } });
  });

  it("handles null/optional fields gracefully on insertion", async () => {
    const input = {
      engineRunId: null,
      symbol: TEST_SYMBOL,
      market: "perp" as const,
      intent: "scalp",
      verdict: "wait",
      direction: null,
      setupType: "none",
      regime: "choppy",
      timeframe: "15M",
      confidence: null,
      btWinRate: null,
      btExpectancy: null,
      btAvgR: null,
      btTotalTrades: null,
      btLowSample: null,
      noTradeReasons: [],
      componentScores: null,
    };

    await insertEvalLog(input);

    const logs = await getEvalLogsForSymbol(TEST_SYMBOL, "perp");
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.direction).toBeNull();
    expect(log.confidence).toBeNull();
    expect(log.btWinRate).toBeNull();
    expect(log.noTradeReasons).toEqual([]);
    expect(log.componentScores).toBeNull();
  });

  it("logEvalAssessments is isolated and does not throw on DB errors", async () => {
    // Pass an invalid engine_run_id (which violates the foreign key constraint)
    // to verify that the function catches the database error and does not throw.
    const invalidEngineRunId = "00000000-0000-0000-0000-000000000000";

    const mockAssessment = {
      intent: "intraday",
      definition: {
        intent: "intraday",
        label: "Intraday",
        horizon: "hours",
        contextTimeframe: "4H",
        executionTimeframe: "1H",
        description: "Test intraday"
      },
      verdict: "favored",
      direction: "long",
      isCounterTrend: false,
      sizeMultiplier: 1.0,
      headline: "Test breakout",
      summary: "Test breakout summary",
      checklist: [],
      triggers: [],
      confidence: 0.95,
      contextBias: "long",
      executionBias: "long",
      context: {} as any,
      execution: {
        symbol: TEST_SYMBOL,
        setupType: "breakout",
        decision: "trade",
        direction: "long",
        lean: "long",
        regime: "trending-up",
        structure: {} as any,
        liquidity: [],
        liquiditySweeps: [],
        swingStrength: [],
        dealingRange: null,
        pricePosition: null,
        objectives: [],
        anticipatoryPlan: null,
        confidence: 0.95,
        components: [
          { name: "trend-alignment", status: "pass", score: 100, explanation: "trend is positive" }
        ],
        noTradeReasons: ["too-volatile"],
        reason: "breakout confirmed",
        risk: {} as any,
        analytics: {} as any,
        backtest: {
          strategyName: "breakout",
          strategyVersion: "1.0",
          totalTrades: 50,
          winRate: 0.8,
          averageWin: 2.0,
          averageLoss: 1.0,
          profitFactor: 2.0,
          expectancy: 1.5,
          maxDrawdown: 10,
          averageR: 1.2,
          bestTradeR: 5.0,
          worstTradeR: -1.0,
          consecutiveWins: 5,
          consecutiveLosses: 2,
          lowSample: false
        },
        strategyVersion: "1.0",
        evaluatedAt: new Date().toISOString()
      } as any,
      plan: null,
      anticipatoryPlan: null,
      location: null,
      hold: { heldAt: new Date().toISOString(), isHeld: false }
    } as DisplayIntentAssessment;

    // This call should output a log but not throw any error
    // (the invalid engineRunId will cause a FK error, caught by the try/catch)
    await logEvalAssessments(invalidEngineRunId, TEST_SYMBOL, "spot", [mockAssessment]);

    // Verify nothing got saved under this symbol since it errored gracefully
    const logs = await getEvalLogsForSymbol(TEST_SYMBOL);
    expect(logs).toHaveLength(0);
  });
});
