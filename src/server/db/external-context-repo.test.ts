import { afterAll, afterEach, describe, expect, it } from "vitest";

import { sql } from "./client";
import {
  insertMarketContextSnapshot,
  latestMarketContextSnapshot,
  listIngestState,
  listMarketCatalystEvents,
  listUpcomingCatalystEvents,
  marketContextSnapshotNear,
  pruneCatalystEvents,
  upsertCatalystEvents,
  upsertIngestState,
} from "./repo";
import type { CatalystEventInput } from "@/lib/engine/catalyst-events";

/**
 * External-context store against the real Postgres — same conventions as the
 * other DB suites: reserved symbols/sources no real ingester uses, full
 * cleanup, needs a reachable DATABASE_URL.
 */

const TEST_SYMBOL = "TESTZZZ6";
const TEST_CG_SOURCE = "test-context-cg";
const TEST_INGEST_SOURCE = "test-context-source";

async function cleanup(): Promise<void> {
  await sql`delete from catalyst_event where symbol = ${TEST_SYMBOL}`;
  await sql`delete from market_context_snapshot where source = ${TEST_CG_SOURCE}`;
  await sql`delete from ingest_state where source = ${TEST_INGEST_SOURCE}`;
}

afterEach(cleanup);
afterAll(cleanup);

const hoursFromNow = (h: number) => new Date(Date.now() + h * 60 * 60_000).toISOString();

function catalystInput(overrides: Partial<CatalystEventInput> = {}): CatalystEventInput {
  return {
    symbol: TEST_SYMBOL,
    kind: "unlock",
    title: "Test unlock",
    description: null,
    occursAt: hoursFromNow(48),
    source: "coinmarketcal",
    sourceId: "test-1",
    url: "https://example.invalid/proof",
    credibility: { votes: 20, confidencePct: 90, hotScore: null },
    percentOfSupply: null,
    dedupKey: `coinmarketcal:test-1:${TEST_SYMBOL}`,
    ...overrides,
  };
}

describe("market_context_snapshot store", () => {
  it("latest returns the newest row; near() the closest at-or-before a timestamp", async () => {
    await insertMarketContextSnapshot({
      totalMcapUsd: 1e12,
      btcDominance: 57,
      ethDominance: 11,
      mcapChange24hPct: 1.5,
      source: TEST_CG_SOURCE,
    });
    // Backdate a second row ~25h so it's the "24h ago" anchor.
    await sql`
      update market_context_snapshot set fetched_at = now() - interval '25 hours'
      where source = ${TEST_CG_SOURCE}
    `;
    await insertMarketContextSnapshot({
      totalMcapUsd: 1.1e12,
      btcDominance: 58,
      ethDominance: null,
      mcapChange24hPct: null,
      source: TEST_CG_SOURCE,
    });

    const latest = await latestMarketContextSnapshot();
    expect(latest?.btcDominance).toBe(58);
    expect(latest?.ethDominance).toBeNull();

    const prior = await marketContextSnapshotNear(hoursFromNow(-24));
    expect(prior?.btcDominance).toBe(57);
  });
});

describe("ingest_state bookkeeping", () => {
  it("transitions ok → error → ok, keeping last_ok_at across failures", async () => {
    await upsertIngestState(TEST_INGEST_SOURCE, "ok");
    let row = (await listIngestState()).find((s) => s.source === TEST_INGEST_SOURCE);
    expect(row?.status).toBe("ok");
    expect(row?.lastOkAt).not.toBeNull();
    const okAt = row!.lastOkAt;

    await upsertIngestState(TEST_INGEST_SOURCE, "error", "provider 503");
    row = (await listIngestState()).find((s) => s.source === TEST_INGEST_SOURCE);
    expect(row?.status).toBe("error");
    expect(row?.lastError).toBe("provider 503");
    expect(row?.lastErrorAt).not.toBeNull();
    // Staleness is computed from when data was last GOOD — the error must not clear it.
    expect(row?.lastOkAt).toBe(okAt);

    await upsertIngestState(TEST_INGEST_SOURCE, "ok");
    row = (await listIngestState()).find((s) => s.source === TEST_INGEST_SOURCE);
    expect(row?.status).toBe("ok");
    // The last error stays visible for postmortems.
    expect(row?.lastError).toBe("provider 503");
  });

  it("records unconfigured distinctly, without a last_error_at timestamp", async () => {
    await upsertIngestState(TEST_INGEST_SOURCE, "unconfigured", "KEY not set");
    const row = (await listIngestState()).find((s) => s.source === TEST_INGEST_SOURCE);
    expect(row?.status).toBe("unconfigured");
    expect(row?.lastErrorAt).toBeNull();
  });
});

describe("catalyst_event store", () => {
  it("upsert is reschedule-aware: a moved date updates the existing row", async () => {
    await upsertCatalystEvents([catalystInput()]);
    const moved = catalystInput({ occursAt: hoursFromNow(96), title: "Test unlock (moved)" });
    await upsertCatalystEvents([moved]);

    const rows = await listUpcomingCatalystEvents(TEST_SYMBOL, hoursFromNow(24 * 7));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Test unlock (moved)");
    expect(Date.parse(rows[0].occursAt)).toBe(Date.parse(moved.occursAt));
  });

  it("upcoming window excludes past events and events beyond the horizon", async () => {
    await upsertCatalystEvents([
      catalystInput({ dedupKey: "k-past", sourceId: "p", occursAt: hoursFromNow(-2) }),
      catalystInput({ dedupKey: "k-in", sourceId: "i", occursAt: hoursFromNow(24) }),
      catalystInput({ dedupKey: "k-far", sourceId: "f", occursAt: hoursFromNow(24 * 10) }),
    ]);
    const rows = await listUpcomingCatalystEvents(TEST_SYMBOL, hoursFromNow(24 * 7));
    expect(rows.map((r) => r.sourceId)).toEqual(["i"]);
  });

  it("prune removes occurred events older than the cutoff", async () => {
    await upsertCatalystEvents([
      catalystInput({ dedupKey: "k-old", sourceId: "old", occursAt: hoursFromNow(-24 * 40) }),
      catalystInput({ dedupKey: "k-new", sourceId: "new", occursAt: hoursFromNow(24) }),
    ]);
    await pruneCatalystEvents(hoursFromNow(-24 * 30));
    const left = await sql`select source_id from catalyst_event where symbol = ${TEST_SYMBOL}`;
    expect(left.map((r) => (r as { source_id: string }).source_id)).toEqual(["new"]);
  });

  it("market backdrop query only serves BTC/ETH/MARKET", async () => {
    await upsertCatalystEvents([catalystInput({ dedupKey: "k-own", sourceId: "own" })]);
    const market = await listMarketCatalystEvents(hoursFromNow(24 * 7));
    expect(market.every((e) => ["BTC", "ETH", "MARKET"].includes(e.symbol))).toBe(true);
    expect(market.some((e) => e.symbol === TEST_SYMBOL)).toBe(false);
  });
});
