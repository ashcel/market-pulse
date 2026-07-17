import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./client";
import {
  followTracked,
  getWatchlist,
  insertTokenEvents,
  listTokenEvents,
  listTokenEventsForSymbols,
  putWatchlist,
  tokenEventRecipients,
} from "./repo";
import type { TokenEventInput } from "@/lib/engine/token-events";

/**
 * Phase 2.5 — token-event store + relevance query, against the real Postgres.
 * Same conventions as repo-invariants: a symbol no real asset uses, full
 * cleanup, self-skips without DATABASE_URL (vitest config handles that via
 * connection failure in the other DB suites too).
 */

const TEST_SYMBOL = "TESTZZZ5";
const PROV = { engineVersion: "test-engine", configHash: "test-hash", gitSha: "test-sha" };

let watcherId: string;
let followerId: string;

function eventInput(overrides: Partial<TokenEventInput> = {}): TokenEventInput {
  return {
    symbol: TEST_SYMBOL,
    kind: "unlock",
    severity: "warning",
    title: "Test unlock",
    body: null,
    source: "test-src",
    url: null,
    publishedAt: new Date().toISOString(),
    dedupKey: `test-src:article-1:${TEST_SYMBOL}:unlock`,
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  await sql`delete from token_event where symbol = ${TEST_SYMBOL}`;
  await sql`delete from tracked_signal where symbol = ${TEST_SYMBOL}`;
}

beforeAll(async () => {
  const users = await sql<{ id: string }[]>`
    insert into users (email, display_name) values
      ('token-events-watcher@example.invalid', 'Watcher'),
      ('token-events-follower@example.invalid', 'Follower')
    on conflict (email) do update set display_name = excluded.display_name
    returning id
  `;
  [watcherId, followerId] = users.map((u) => u.id);
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await sql`delete from user_watchlist where user_id in (${watcherId}, ${followerId})`;
  await sql`delete from users where id in (${watcherId}, ${followerId})`;
});

describe("token-event store (P2.5)", () => {
  it("inserts are deduped on dedup_key — re-ingestion is a no-op", async () => {
    expect(await insertTokenEvents([eventInput()])).toBe(1);
    expect(await insertTokenEvents([eventInput({ title: "same article refetched" })])).toBe(0);
    const rows = await listTokenEvents(TEST_SYMBOL);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Test unlock");
  });

  it("symbol listing is case-insensitive on input and ordered by published_at desc", async () => {
    await insertTokenEvents([
      eventInput({ dedupKey: "k1", publishedAt: "2026-07-10T00:00:00Z", title: "older" }),
      eventInput({ dedupKey: "k2", publishedAt: "2026-07-12T00:00:00Z", title: "newer" }),
    ]);
    const rows = await listTokenEvents(TEST_SYMBOL.toLowerCase());
    expect(rows.map((r) => r.title)).toEqual(["newer", "older"]);
    const scoped = await listTokenEventsForSymbols([TEST_SYMBOL], "2026-07-11T00:00:00Z");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].title).toBe("newer");
  });

  it("recipients = active-follow owners ∪ server watchlist, deduped", async () => {
    expect(await tokenEventRecipients(TEST_SYMBOL)).toEqual([]);

    await putWatchlist(watcherId, [TEST_SYMBOL, "BTC"]);
    await followTracked(followerId, null, {
      symbol: TEST_SYMBOL,
      intent: "intraday",
      direction: "long",
      setupType: "breakout",
      timeframe: "1H",
      market: "spot",
      entryLow: 99,
      entryHigh: 101,
      entryPrice: 100,
      stop: 95,
      target1: 105,
      target2: 110,
      confidenceAtFollow: 60,
      ...PROV,
    });

    const recipients = await tokenEventRecipients(TEST_SYMBOL);
    expect(recipients.sort()).toEqual([watcherId, followerId].sort());

    // A settled follow stops being a reason to notify; the watchlist remains one.
    await sql`update tracked_signal set status = 'stopped-out' where symbol = ${TEST_SYMBOL}`;
    expect(await tokenEventRecipients(TEST_SYMBOL)).toEqual([watcherId]);

    // Watchlist replace-sync removes the symbol → no recipients at all.
    await putWatchlist(watcherId, ["BTC"]);
    expect(await tokenEventRecipients(TEST_SYMBOL)).toEqual([]);
    expect(await getWatchlist(watcherId)).toEqual(["BTC"]);
  });
});
