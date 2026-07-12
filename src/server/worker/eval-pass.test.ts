import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isTokenTimeframe } from "@/lib/engine/mock-candles";
import { fetchSessionLevels } from "@/lib/engine/sessions";
import { installFakeBinance } from "./__fixtures__/fake-binance";
import { assembleEvaluateInputs } from "./eval-pass";

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
});
