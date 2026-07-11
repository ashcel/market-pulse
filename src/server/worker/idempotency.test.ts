import { afterAll, afterEach, describe, expect, it } from "vitest";

import { sql } from "../db/client";
import {
  finishEngineRun,
  listOpenAnticipatory,
  listOpenShadow,
  openAnticipatory,
  openShadow,
  startEngineRun,
} from "../db/repo";
import type { AnticipatoryOpenInput, ShadowOpenInput } from "@/lib/engine/evaluate";

/**
 * WS4 — idempotency proof: "kill the worker mid-pass, restart, confirm no
 * double-count and full catch-up." `runOnce` has no checkpoint/resume state
 * of its own — a restart just calls it again from scratch, over the whole
 * universe. So the entire safety property rests on two things holding
 * against a real Postgres instance, not just in memory:
 *
 *   1. Open (eval-pass) side: re-evaluating a symbol that already has an
 *      open record is a no-op — the partial unique index, not application
 *      logic, is what makes "just run the whole pass again" safe.
 *   2. Settle-pass side: `listOpenShadow`/`listOpenAnticipatory` only ever
 *      return `status='active'`/`'pending'|'filled'` rows, so a record a
 *      completed pass already settled is structurally invisible to a
 *      restarted settle pass — it can't be re-settled, let alone double-
 *      counted.
 *
 * This is a companion to `repo-invariants.test.ts`'s dedup-index tests, but
 * framed at the worker-restart scenario itself — including the bookkeeping
 * side (`engine_run`) `runOnce` layers on top of the raw inserts: a pass
 * that dies before `finishEngineRun` leaves an orphaned run row, and the
 * next pass must be unaffected by it.
 */

const TEST_SYMBOL = "TESTZZZ9"; // distinct from repo-invariants.test.ts's TESTZZZ
const PROV = { engineVersion: "test-engine", configHash: "test-hash", gitSha: "test-sha" };

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
    ...PROV,
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
    ...PROV,
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  await sql`delete from shadow_signal where symbol = ${TEST_SYMBOL}`;
  await sql`delete from anticipatory_signal where symbol = ${TEST_SYMBOL}`;
  await sql`delete from engine_run where universe_json::text like ${"%" + TEST_SYMBOL + "%"}`;
}

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("worker restart idempotency (WS4)", () => {
  it("a pass killed before finishEngineRun, then a full restart pass, opens each record exactly once", async () => {
    const universe = { symbols: [TEST_SYMBOL] };

    // Pass 1 (the "real" universe loop, condensed to one symbol): opens a
    // shadow + an anticipatory record, then "crashes" — no finishEngineRun,
    // exactly what a `kill -9` mid-pass leaves behind.
    const runA = await startEngineRun(PROV, universe);
    await openShadow(shadowInput({ entry: 100 }), runA);
    await openAnticipatory(anticipatoryInput({ entry: 100 }), runA);

    // Restart: a brand-new run. `runOnce` has no memory of run A beyond
    // what's already committed — it just evaluates the symbol again and
    // tries to open the same records.
    const runB = await startEngineRun(PROV, universe);
    await openShadow(shadowInput({ entry: 999 }), runB); // same symbol/market/intent as run A
    await openAnticipatory(anticipatoryInput({ entry: 999 }), runB);
    await finishEngineRun(runB, "ok", "restart pass");

    const shadowRows = await sql`
      select entry, engine_run_id from shadow_signal where symbol = ${TEST_SYMBOL}
    `;
    const anticipatoryRows = await sql`
      select entry, engine_run_id from anticipatory_signal where symbol = ${TEST_SYMBOL}
    `;

    // No double-count: still exactly one row each, and it's run A's — the
    // restart's attempt was a genuine no-op, not a silent overwrite.
    expect(shadowRows).toHaveLength(1);
    expect(Number(shadowRows[0].entry)).toBe(100);
    expect(shadowRows[0].engine_run_id).toBe(runA);

    expect(anticipatoryRows).toHaveLength(1);
    expect(Number(anticipatoryRows[0].entry)).toBe(100);
    expect(anticipatoryRows[0].engine_run_id).toBe(runA);

    // Run A stays orphaned (finished_at null forever — nothing ever goes
    // back to close it), and that doesn't block run B from starting or
    // finishing normally.
    const runs = await sql`
      select id, finished_at, status from engine_run where id in (${runA}, ${runB})
    `;
    const rowA = runs.find((r) => r.id === runA);
    const rowB = runs.find((r) => r.id === runB);
    expect(rowA?.finished_at).toBeNull();
    expect(rowB?.finished_at).not.toBeNull();
    expect(rowB?.status).toBe("ok");
  });

  it("catches up fully: a symbol run A never reached opens cleanly on the restart pass", async () => {
    // Run A "crashes" before it ever gets to this symbol (e.g. an earlier
    // symbol in the universe threw). Run B is the restart, and must still
    // open it — full catch-up, not just "no double-count".
    const runA = await startEngineRun(PROV, { symbols: [] });

    const runB = await startEngineRun(PROV, { symbols: [TEST_SYMBOL] });
    await openShadow(shadowInput({ entry: 100 }), runB);
    await finishEngineRun(runB, "ok", "restart pass");

    const rows = await sql`select entry from shadow_signal where symbol = ${TEST_SYMBOL}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].entry)).toBe(100);

    await sql`delete from engine_run where id = ${runA}`;
  });

  it("a settled record is structurally invisible to a restarted settle pass — can't be re-settled", async () => {
    const runA = await startEngineRun(PROV, { symbols: [TEST_SYMBOL] });
    await openShadow(shadowInput({ entry: 100 }), runA);

    const beforeSettle = await listOpenShadow();
    expect(beforeSettle.some((s) => s.symbol === TEST_SYMBOL)).toBe(true);

    // The settle pass closes it — simulating the worker's own settlement,
    // then dying before the next tick.
    await sql`
      update shadow_signal set status = 'target-hit', closed_at = now(), result_r = 1.5
      where symbol = ${TEST_SYMBOL}
    `;

    // Restart: a new settle pass queries `listOpenShadow` fresh, as
    // `runSettlePass` always does — no cursor, no "resume from" state.
    const afterSettle = await listOpenShadow();
    expect(afterSettle.some((s) => s.symbol === TEST_SYMBOL)).toBe(false);
  });

  it("a settled anticipatory record is likewise excluded from a restarted settle pass", async () => {
    const runA = await startEngineRun(PROV, { symbols: [TEST_SYMBOL] });
    await openAnticipatory(anticipatoryInput({ entry: 100 }), runA);

    await sql`
      update anticipatory_signal set status = 'never-filled', closed_at = now()
      where symbol = ${TEST_SYMBOL}
    `;

    const afterSettle = await listOpenAnticipatory();
    expect(afterSettle.some((s) => s.symbol === TEST_SYMBOL)).toBe(false);
  });
});
