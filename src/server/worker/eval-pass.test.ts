import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isTokenTimeframe } from "@/lib/engine/mock-candles";
import { fetchSessionLevels } from "@/lib/engine/sessions";
import { installFakeBinance } from "./__fixtures__/fake-binance";
import { assembleEvaluateInputs, runEvalPass } from "./eval-pass";
import { startEngineRun } from "../db/repo";
import { sql } from "../db/client";

describe("worker/UI input parity (WS1)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    installFakeBinance();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("assembles non-empty evals/zones/sessionLevels from the shared engine functions", async () => {
    const assembled = await assembleEvaluateInputs("BTC", "spot");
    expect(assembled).not.toBeNull();
    if (!assembled) return;

    expect(Object.keys(assembled.evalsByTimeframe).length).toBeGreaterThan(0);
    for (const timeframe of Object.keys(assembled.evalsByTimeframe)) {
      expect(isTokenTimeframe(timeframe)).toBe(true);
    }
    expect(assembled.sessionLevels.length).toBeGreaterThan(0);
    expect(assembled.perp).toBeNull();
  });

  it("matches what the token page's own session-levels path would compute", async () => {
    // The UI's `useSessionLevels` resolves server-side to this same
    // `fetchSessionLevels` call (via `fetchSessionLevelsServer`'s handler) —
    // calling it directly here is the token-page-equivalent reference, not a
    // reimplementation of the logic under test.
    const uiEquivalent = await fetchSessionLevels("BTC", "spot");
    const assembled = await assembleEvaluateInputs("BTC", "spot");

    expect(assembled?.sessionLevels).toEqual(uiEquivalent);
  });

  it("runEvalPass logs evaluation records to eval_log for each symbol and intent", async () => {
    // Generate a fresh engine run for this test
    const testProv = { engineVersion: "test-engine", configHash: "test-hash", gitSha: "test-sha" };
    const engineRunId = await startEngineRun(testProv, { symbols: ["BTC"] });

    try {
      const result = await runEvalPass(engineRunId, "spot");

      // Ensure we evaluated symbols
      expect(result.evaluated).toBeGreaterThan(0);

      // Query the logs written for BTC under this run
      const rows = await sql`
        select * from eval_log 
        where engine_run_id = ${engineRunId} and symbol = 'BTC'
      `;

      // We expect 4 intents (scalp, intraday, swing, position)
      expect(rows.length).toBe(4);

      // Verify the schema/fields match what we expect
      const intents = rows.map((r) => r.intent).sort();
      expect(intents).toEqual(["intraday", "position", "scalp", "swing"]);

      for (const row of rows) {
        expect(row.engine_run_id).toBe(engineRunId);
        expect(row.symbol).toBe("BTC");
        expect(row.market).toBe("spot");
        expect(row.verdict).toBeDefined();
        expect(row.setup_type).toBeDefined();
        expect(row.regime).toBeDefined();
        expect(row.timeframe).toBeDefined();
        expect(row.engine_version).toBe("1.0.0"); // from currentProvenance
      }
    } finally {
      // Clean up evaluation logs and the engine run created for this test
      await sql`delete from eval_log where engine_run_id = ${engineRunId}`;
      await sql`delete from shadow_signal where engine_run_id = ${engineRunId}`;
      await sql`delete from anticipatory_signal where engine_run_id = ${engineRunId}`;
      await sql`delete from engine_run where id = ${engineRunId}`;
    }
  });
});
