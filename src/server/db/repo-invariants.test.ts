import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./client";
import { openAnticipatory, openShadow, startEngineRun } from "./repo";
import type { AnticipatoryOpenInput, ShadowOpenInput } from "@/lib/engine/evaluate";

/**
 * WS2 — dedup correctness + provenance completeness, against the real dev
 * Postgres (docker-compose.yml, DATABASE_URL). The partial unique indexes
 * (`shadow_active_uniq`, `anticipatory_active_uniq`) are schema-level
 * guarantees `on conflict do nothing` alone can't prove — only a real insert
 * against the real constraint can. Every row this suite writes is tagged with
 * a symbol no real asset uses (`TESTZZZ`) and deleted in `afterAll`/`afterEach`
 * so it never pollutes the live shadow/anticipatory record.
 */

const TEST_SYMBOL = "TESTZZZ";

async function cleanup(): Promise<void> {
  await sql`delete from shadow_signal where symbol = ${TEST_SYMBOL}`;
  await sql`delete from anticipatory_signal where symbol = ${TEST_SYMBOL}`;
  await sql`delete from engine_run where universe_json::text like ${"%" + TEST_SYMBOL + "%"}`;
}

function shadowInput(overrides: Partial<ShadowOpenInput> = {}): ShadowOpenInput {
  return {
    symbol: TEST_SYMBOL,
    market: "spot",
    intent: "intraday",
    direction: "long",
    setupType: "breakout",
    regime: "trending-up",
    timeframe: "1H",
    entry: 100,
    stop: 95,
    target1: 105,
    target2: 110,
    confidence: 60,
    openedAt: new Date().toISOString(),
    engineVersion: "test-engine",
    configHash: "test-hash",
    gitSha: "test-sha",
    ...overrides,
  };
}

function anticipatoryInput(overrides: Partial<AnticipatoryOpenInput> = {}): AnticipatoryOpenInput {
  return {
    symbol: TEST_SYMBOL,
    market: "spot",
    intent: "intraday",
    direction: "long",
    setupType: "pullback-continuation",
    regime: "trending-up",
    timeframe: "1H",
    verdict: "favored",
    entry: 100,
    stop: 90,
    objective: 130,
    objectiveStrength: "strong",
    zoneFreshness: "fresh",
    rewardRisk: 3,
    openedAt: new Date().toISOString(),
    engineVersion: "test-engine",
    configHash: "test-hash",
    gitSha: "test-sha",
    ...overrides,
  };
}

let engineRunId: string;

beforeAll(async () => {
  await cleanup();
  engineRunId = await startEngineRun(
    { engineVersion: "test-engine", configHash: "test-hash", gitSha: "test-sha" },
    { symbols: [TEST_SYMBOL] },
  );
});

afterEach(async () => {
  await sql`delete from shadow_signal where symbol = ${TEST_SYMBOL}`;
  await sql`delete from anticipatory_signal where symbol = ${TEST_SYMBOL}`;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("dedup correctness — shadow_active_uniq", () => {
  it("a second open of the same still-open (symbol,market,intent) is a no-op", async () => {
    await openShadow(shadowInput({ entry: 100 }), engineRunId);
    await openShadow(shadowInput({ entry: 999 }), engineRunId); // same symbol/market/intent, still active

    const rows = await sql`
      select entry from shadow_signal
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].entry)).toBe(100); // the first open wins; the second was a no-op
  });

  it("a new open is allowed once the prior one has settled (no longer active)", async () => {
    await openShadow(shadowInput({ entry: 100 }), engineRunId);
    await sql`
      update shadow_signal set status = 'stopped-out'
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
    `;

    await openShadow(shadowInput({ entry: 200 }), engineRunId);

    const rows = await sql`
      select entry, status from shadow_signal
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
      order by entry
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.entry))).toEqual([100, 200]);
  });

  it("a different intent for the same symbol/market opens independently", async () => {
    await openShadow(shadowInput({ intent: "intraday" }), engineRunId);
    await openShadow(shadowInput({ intent: "swing" }), engineRunId);

    const rows = await sql`select intent from shadow_signal where symbol = ${TEST_SYMBOL}`;
    expect(rows).toHaveLength(2);
  });
});

describe("dedup correctness — anticipatory_active_uniq", () => {
  it("a second open while pending is a no-op", async () => {
    await openAnticipatory(anticipatoryInput({ entry: 100 }), engineRunId);
    await openAnticipatory(anticipatoryInput({ entry: 999 }), engineRunId);

    const rows = await sql`
      select entry from anticipatory_signal
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].entry)).toBe(100);
  });

  it("stays a no-op while filled (EDR 0010: a resting limit stays where it was placed)", async () => {
    await openAnticipatory(anticipatoryInput({ entry: 100 }), engineRunId);
    await sql`
      update anticipatory_signal set status = 'filled'
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
    `;

    await openAnticipatory(anticipatoryInput({ entry: 999 }), engineRunId);

    const rows = await sql`
      select entry, status from anticipatory_signal
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].entry)).toBe(100);
  });

  it("a new open is allowed once the prior one is never-filled/settled", async () => {
    await openAnticipatory(anticipatoryInput({ entry: 100 }), engineRunId);
    await sql`
      update anticipatory_signal set status = 'never-filled'
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
    `;

    await openAnticipatory(anticipatoryInput({ entry: 200 }), engineRunId);

    const rows = await sql`
      select entry from anticipatory_signal
      where symbol = ${TEST_SYMBOL} and market = 'spot' and intent = 'intraday'
      order by entry
    `;
    expect(rows).toHaveLength(2);
  });
});

describe("provenance completeness — repo guards reject before hitting the DB", () => {
  it("openShadow throws and writes nothing when engineVersion is blank", async () => {
    const badInput = shadowInput({ engineVersion: "" });
    await expect(openShadow(badInput, engineRunId)).rejects.toThrow(/provenance/i);

    const rows = await sql`select 1 from shadow_signal where symbol = ${TEST_SYMBOL}`;
    expect(rows).toHaveLength(0);
  });

  it("openAnticipatory throws and writes nothing when configHash is blank", async () => {
    const badInput = anticipatoryInput({ configHash: "" });
    await expect(openAnticipatory(badInput, engineRunId)).rejects.toThrow(/provenance/i);

    const rows = await sql`select 1 from anticipatory_signal where symbol = ${TEST_SYMBOL}`;
    expect(rows).toHaveLength(0);
  });
});
