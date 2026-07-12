import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleEvaluateInputs } from "./eval-pass";
import { installFakeBinance } from "./__fixtures__/fake-binance";

/**
 * P1.3 — the worker's perp pass. `assembleEvaluateInputs` must, in perp mode,
 * carry the real funding/OI context (the same `fetchPerpContextDirect` the
 * token page's perp mode resolves to) instead of the hardcoded `perp: null`
 * the spot-only v1 shipped with — and must degrade to `perp: null` when the
 * futures endpoints fail, exactly as the UI does.
 */

const realFetch = globalThis.fetch;

/** Layer futures endpoints over the shared fake-Binance kline fixture. */
function installFakeFutures(opts: { funding: boolean; oi: boolean }): void {
  installFakeBinance();
  const klineFake = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    if (url.pathname.endsWith("/premiumIndex")) {
      if (!opts.funding) return new Response("{}", { status: 500 });
      return new Response(
        JSON.stringify({
          lastFundingRate: "0.00080", // beyond FUNDING_ELEVATED → longs-crowded
          nextFundingTime: 1_800_000_000_000,
          markPrice: "100.5",
        }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/openInterestHist")) {
      if (!opts.oi) return new Response("[]", { status: 500 });
      return new Response(
        JSON.stringify([
          { sumOpenInterestValue: "1000000" },
          { sumOpenInterestValue: "1100000" }, // +10% → rising OI
        ]),
        { status: 200 },
      );
    }
    return klineFake(input as never, init as never);
  }) as typeof fetch;
}

beforeEach(() => installFakeFutures({ funding: true, oi: true }));
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("worker perp pass (P1.3)", () => {
  it("assembles perp inputs with the real funding/OI read", async () => {
    const inputs = await assembleEvaluateInputs("BTC", "perp");
    expect(inputs).not.toBeNull();
    expect(Object.keys(inputs!.evalsByTimeframe).length).toBeGreaterThan(0);

    const perp = inputs!.perp;
    expect(perp).not.toBeNull();
    expect(perp!.fundingRate).toBeCloseTo(0.0008);
    expect(perp!.fundingBias).toBe("longs-crowded");
    expect(perp!.oiTrend).toBe("rising");
    expect(perp!.conviction).toBe("building");
  });

  it("stays spot-clean: a spot assembly never fetches futures context", async () => {
    const inputs = await assembleEvaluateInputs("BTC", "spot");
    expect(inputs).not.toBeNull();
    expect(inputs!.perp).toBeNull();
  });

  it("degrades to perp: null when the futures endpoints fail, like the UI", async () => {
    installFakeFutures({ funding: false, oi: false });
    const inputs = await assembleEvaluateInputs("BTC", "perp");
    expect(inputs).not.toBeNull();
    expect(inputs!.perp).toBeNull();
  });
});
