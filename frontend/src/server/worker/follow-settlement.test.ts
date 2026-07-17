import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runSettlePass } from "./settle-pass";
import { sql } from "../db/client";
import { followTracked, listTrackedByOwner } from "../db/repo";
import { BINANCE_INTERVALS } from "@/lib/engine/binance";
import { STEP_SECONDS } from "@/lib/engine/mock-candles";
import type { FollowInput } from "../db/repo";

/**
 * P1.1 — the follow loop's missing last mile, end to end against the real
 * Postgres: a user's follow (the exact `followTracked` insert the
 * `POST /api/forward-test` handler performs) must be picked up and settled by
 * the worker's settle pass. Before this suite the tracked path in
 * `runSettlePass` had never executed against a real row — `tracked_signal`
 * was permanently empty because the client never POSTed (the WS5 caveat).
 *
 * The Binance stub feeds crafted candles ONLY for the test symbol and returns
 * `[]` for everything else, so a full `runSettlePass` over the live record
 * skips every real open record untouched (`candles.length === 0` → continue).
 */

const TEST_SYMBOL = "TESTZZZ7"; // distinct from repo-invariants (TESTZZZ) and idempotency (TESTZZZ9)
const TIMEFRAME = "1H" as const;
const STEP = STEP_SECONDS[TIMEFRAME];
const PROV = { engineVersion: "test-engine", configHash: "test-hash", gitSha: "test-sha" };

let userId: string;
const realFetch = globalThis.fetch;

function followInput(overrides: Partial<FollowInput> = {}): FollowInput {
  return {
    symbol: TEST_SYMBOL,
    intent: "intraday",
    direction: "long",
    setupType: "pullback-continuation",
    timeframe: TIMEFRAME,
    market: "spot",
    entryLow: 99,
    entryHigh: 101,
    entryPrice: 100,
    stop: 95,
    target1: 105,
    target2: 110,
    confidenceAtFollow: 60,
    ...PROV,
    ...overrides,
  };
}

/** Bar-aligned open times ending safely in the closed past. */
function barTimes(count: number): number[] {
  const lastOpen = (Math.floor(Date.now() / 1000 / STEP) - 2) * STEP;
  return Array.from({ length: count }, (_, i) => lastOpen - (count - 1 - i) * STEP);
}

function klineRow(time: number, o: number, h: number, l: number, c: number): unknown[] {
  return [time * 1000, String(o), String(h), String(l), String(c), "1000", time * 1000 + 999];
}

/** Candles only for the test symbol; every real symbol gets an empty payload. */
function installTargetedBinance(rows: unknown[][]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    if (
      url.pathname.endsWith("/klines") &&
      url.searchParams.get("symbol") === `${TEST_SYMBOL}USDT` &&
      url.searchParams.get("interval") === BINANCE_INTERVALS[TIMEFRAME]
    ) {
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
}

async function cleanup(): Promise<void> {
  await sql`delete from tracked_signal where symbol = ${TEST_SYMBOL}`;
}

beforeAll(async () => {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name) values ('follow-settlement-test@example.invalid', 'Follow Settlement Test')
    on conflict (email) do update set display_name = excluded.display_name
    returning id
  `;
  userId = row.id;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sql`delete from users where id = ${userId}`;
});

describe("follow → worker settlement (P1.1)", () => {
  it("settles a followed signal whose target2 was wicked, exactly as the tracked walk defines", async () => {
    const id = await followTracked(userId, null, followInput());
    // `followed_at` defaults to now(); the settle walk only counts bars that
    // opened after the follow — backdate so the crafted bars all qualify.
    const [t1, t2, t3] = barTimes(3);
    await sql`
      update tracked_signal
      set followed_at = to_timestamp(${t1 - STEP})
      where id = ${id}
    `;

    installTargetedBinance([
      klineRow(t1, 100, 102, 99, 101), // touches nothing
      klineRow(t2, 101, 111, 99, 108), // wicks through target2 (110), stop untouched
      klineRow(t3, 108, 109, 107, 108),
    ]);

    const { settled } = await runSettlePass();
    expect(settled).toBeGreaterThanOrEqual(1);

    const [signal] = await listTrackedByOwner(userId);
    expect(signal.status).toBe("target2-hit");
    expect(signal.closePrice).toBe(110);
    // R = (110 - 100) / (100 - 95)
    expect(signal.resultR).toBe(2);
    expect(signal.closedAt).toBeTruthy();
  });

  it("leaves an untouched follow open, and a second pass can't re-settle a settled one", async () => {
    const id = await followTracked(userId, null, followInput());
    const [t1, t2, t3] = barTimes(3);
    await sql`
      update tracked_signal
      set followed_at = to_timestamp(${t1 - STEP})
      where id = ${id}
    `;

    // No level is ever touched → stays active.
    installTargetedBinance([
      klineRow(t1, 100, 101, 99, 100),
      klineRow(t2, 100, 101, 99, 100),
      klineRow(t3, 100, 101, 99, 100),
    ]);
    await runSettlePass();
    let [signal] = await listTrackedByOwner(userId);
    expect(signal.status).toBe("active");

    // Now it stops out — and a repeat pass with even-worse candles must be a
    // no-op because settled rows are invisible to `listOpenTracked`.
    installTargetedBinance([klineRow(t3 + STEP, 100, 101, 94, 95)]);
    await runSettlePass();
    [signal] = await listTrackedByOwner(userId);
    expect(signal.status).toBe("stopped-out");
    expect(signal.resultR).toBe(-1);
    const closedAt = signal.closedAt;

    installTargetedBinance([klineRow(t3 + 2 * STEP, 95, 120, 90, 115)]);
    const { settled } = await runSettlePass();
    expect(settled).toBe(0);
    [signal] = await listTrackedByOwner(userId);
    expect(signal.status).toBe("stopped-out");
    expect(signal.closedAt).toBe(closedAt);
  });
});
