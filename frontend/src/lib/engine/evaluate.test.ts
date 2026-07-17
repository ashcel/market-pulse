import { describe, expect, it } from "vitest";

import { evaluateSymbol } from "./evaluate";

describe("evaluateSymbol", () => {
  it("returns null when there is nothing to assess", () => {
    const out = evaluateSymbol({
      symbol: "BTC",
      market: "spot",
      evalsByTimeframe: {},
      zonesByTimeframe: {},
      perp: null,
      sessionLevels: [],
      comboStats: [],
      holds: {},
      nowMs: Date.now(),
    });
    expect(out).toBeNull();
  });
});
