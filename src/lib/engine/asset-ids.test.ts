import { describe, expect, it } from "vitest";

import { ASSET_IDS, COINMARKETCAL_IDS, TICKER_BY_COINMARKETCAL_ID } from "./asset-ids";
import { WORKER_UNIVERSE } from "./market";

describe("ASSET_IDS", () => {
  it("has an explicit entry for every WORKER_UNIVERSE ticker (null allowed, absence not)", () => {
    const missing = WORKER_UNIVERSE.map((u) => u.ticker).filter((t) => !(t in ASSET_IDS));
    expect(missing).toEqual([]);
  });

  it("has no orphan entries for tickers that left the universe", () => {
    const universe = new Set(WORKER_UNIVERSE.map((u) => u.ticker));
    const orphans = Object.keys(ASSET_IDS).filter((t) => !universe.has(t));
    expect(orphans).toEqual([]);
  });

  it("provider IDs are unique — a collision would misattribute events at ingest", () => {
    const cmc = Object.values(ASSET_IDS)
      .map((v) => v.coinmarketcalId)
      .filter((v): v is string => v !== null);
    expect(new Set(cmc).size).toBe(cmc.length);
    const gecko = Object.values(ASSET_IDS)
      .map((v) => v.coingeckoId)
      .filter((v): v is string => v !== null);
    expect(new Set(gecko).size).toBe(gecko.length);
  });

  it("reverse map and ID list stay consistent with the table", () => {
    for (const [ticker, ids] of Object.entries(ASSET_IDS)) {
      if (ids.coinmarketcalId === null) continue;
      expect(TICKER_BY_COINMARKETCAL_ID[ids.coinmarketcalId]).toBe(ticker);
      expect(COINMARKETCAL_IDS).toContain(ids.coinmarketcalId);
    }
  });
});
