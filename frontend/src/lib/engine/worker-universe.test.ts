import { describe, expect, it } from "vitest";

import { UNIVERSE, WORKER_UNIVERSE, WORKER_UNIVERSE_EXTENSION } from "./market";
import { normalizeTicker, resolveExchangeSymbol } from "./symbol-map";

/**
 * P2.1 — structural guarantees on the worker's expanded sampling frame. The
 * live listing check (TRADING on both Binance spot and USDS-M futures) was run
 * once at selection time (2026-07-12, see EDR 0011); these tests pin the
 * offline invariants that keep the frame coherent: the dashboard universe is a
 * strict subset, nothing collides, and every ticker resolves cleanly on both
 * markets. A delisting shows up as a per-symbol eval error in the worker log,
 * not a test failure.
 */
describe("WORKER_UNIVERSE (P2.1)", () => {
  it("is UNIVERSE plus the extension, with no duplicate tickers", () => {
    expect(WORKER_UNIVERSE.length).toBe(UNIVERSE.length + WORKER_UNIVERSE_EXTENSION.length);
    const tickers = WORKER_UNIVERSE.map((u) => u.ticker);
    expect(new Set(tickers).size).toBe(tickers.length);
    for (const u of UNIVERSE) expect(tickers).toContain(u.ticker);
  });

  it("every entry is already normalized and resolves on both markets", () => {
    for (const u of WORKER_UNIVERSE) {
      expect(u.ticker).toBe(normalizeTicker(u.ticker));
      for (const market of ["spot", "perp"] as const) {
        const resolved = resolveExchangeSymbol(u.ticker, market);
        expect(resolved.symbol.endsWith("USDT")).toBe(true);
        expect(resolved.priceScale).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the sampling frame meaningfully larger than the dashboard (the point of P2.1)", () => {
    expect(WORKER_UNIVERSE.length).toBeGreaterThanOrEqual(50);
  });
});
