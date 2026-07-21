import { describe, expect, it } from "vitest";

import {
  adviseFundingPlay,
  buildFundingScan,
  DEFAULT_FUNDING_PLAY_CONFIG,
  rankFundingPlays,
  type FundingPlayConfig,
  type FundingRow,
} from "./funding-play";

const MIN = 60_000;
/** Fixed settlement epoch so every "now" is expressed relative to it. */
const SETTLE = 1_700_000_000_000;

function fundingRow(overrides: Partial<FundingRow> & { ticker?: string } = {}): FundingRow {
  return {
    ticker: "SOL",
    pair: "SOLUSDT",
    fundingRate: 0.02, // prime extreme, positive
    nextFundingMs: SETTLE,
    markPrice: 100,
    indexPrice: 100,
    intervalHours: 8,
    ...overrides,
  };
}

function cfg(overrides: Partial<FundingPlayConfig> = {}): FundingPlayConfig {
  return { ...DEFAULT_FUNDING_PLAY_CONFIG, ...overrides };
}

describe("adviseFundingPlay — side selection", () => {
  it("shorts to receive positive funding (longs pay)", () => {
    const a = adviseFundingPlay(fundingRow({ fundingRate: 0.02 }), SETTLE - 10 * MIN);
    expect(a?.side).toBe("short");
  });

  it("longs to receive negative funding (shorts pay)", () => {
    const a = adviseFundingPlay(fundingRow({ fundingRate: -0.02 }), SETTLE - 10 * MIN);
    expect(a?.side).toBe("long");
  });
});

describe("adviseFundingPlay — phase/verdict as now walks toward and past settlement", () => {
  it("is watch / not-yet well before the window", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 60 * MIN)!;
    expect(a.phase).toBe("watch");
    expect(a.verdict).toBe("not-yet");
    expect(a.whatFlipsIt).toMatch(/window opens/i);
  });

  it("becomes enter-window / take exactly at the window boundary", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 30 * MIN)!;
    expect(a.minutesToFunding).toBeCloseTo(30, 6);
    expect(a.phase).toBe("enter-window");
    expect(a.verdict).toBe("take");
    expect(a.whatFlipsIt).toMatch(/flatten/i);
  });

  it("is still watch one minute outside the window", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 31 * MIN)!;
    expect(a.phase).toBe("watch");
    expect(a.verdict).toBe("not-yet");
  });

  it("is settling / skip in the final minute", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 30_000)!;
    expect(a.phase).toBe("settling");
    expect(a.verdict).toBe("skip");
    expect(a.whatFlipsIt).toMatch(/next window/i);
  });

  it("is post-settlement / skip once funding has paid, pointing at the next settlement", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE + 5 * MIN)!;
    expect(a.phase).toBe("post-settlement");
    expect(a.verdict).toBe("skip");
    expect(a.minutesToFunding).toBe(0); // never negative
    expect(a.whatFlipsIt).toMatch(/next settlement/i);
    // 8h interval, 5 min past settlement → ~475 min to the next one.
    expect(a.whatFlipsIt).toMatch(/475 min/);
  });
});

describe("adviseFundingPlay — fee / net-edge math", () => {
  it("computes gross, fees, net and break-even move for the default config", () => {
    const a = adviseFundingPlay(fundingRow({ fundingRate: 0.02 }), SETTLE - 10 * MIN)!;
    expect(a.grossCapturePct).toBeCloseTo(2, 6);
    expect(a.feesPct).toBeCloseTo(0.1, 6); // 0.05% × 2 sides
    expect(a.netEdgePct).toBeCloseTo(1.9, 6);
    // break-even move equals net edge and is leverage-independent by construction.
    expect(a.breakevenMovePct).toBe(a.netEdgePct);
  });

  it("skips even inside the window when fees eat the funding (net edge <= 0)", () => {
    // Fees of 1.1%/side → 2.2% round trip against 2% gross → net -0.2%.
    const a = adviseFundingPlay(
      fundingRow({ fundingRate: 0.02 }),
      SETTLE - 10 * MIN,
      cfg({ takerFeeRate: 0.011 }),
    )!;
    expect(a.phase).toBe("enter-window");
    expect(a.netEdgePct).toBeLessThanOrEqual(0);
    expect(a.verdict).toBe("skip");
    expect(a.whatFlipsIt).toMatch(/net edge/i);
  });
});

describe("adviseFundingPlay — sizing", () => {
  it("sizes notional so the assumed stop loses exactly maxLossUsd", () => {
    const a = adviseFundingPlay(fundingRow({ fundingRate: 0.02 }), SETTLE - 10 * MIN)!;
    // 3 / (1%/100) = 300 notional; capture = 2% × 300 = 6.
    expect(a.suggestedNotionalUsd).toBeCloseTo(300, 6);
    expect(a.expectedCaptureUsd).toBeCloseTo(6, 6);
  });

  it("guards divide-by-zero when the stop distance is zero", () => {
    const a = adviseFundingPlay(
      fundingRow(),
      SETTLE - 10 * MIN,
      cfg({ defaultStopDistancePct: 0 }),
    )!;
    expect(a.suggestedNotionalUsd).toBe(0);
    expect(a.expectedCaptureUsd).toBe(0);
    expect(Number.isFinite(a.suggestedNotionalUsd)).toBe(true);
  });
});

describe("adviseFundingPlay — null gates and robustness", () => {
  it("returns null below the extreme-rate flag", () => {
    expect(adviseFundingPlay(fundingRow({ fundingRate: 0.001 }), SETTLE - 10 * MIN)).toBeNull();
  });

  it("returns null on non-finite inputs", () => {
    expect(adviseFundingPlay(fundingRow({ fundingRate: NaN }), SETTLE - 10 * MIN)).toBeNull();
    expect(adviseFundingPlay(fundingRow({ nextFundingMs: NaN }), SETTLE - 10 * MIN)).toBeNull();
    expect(adviseFundingPlay(fundingRow({ markPrice: Infinity }), SETTLE - 10 * MIN)).toBeNull();
    expect(adviseFundingPlay(fundingRow(), NaN)).toBeNull();
  });

  it("treats nextFundingMs of 0 as post-settlement, not an error", () => {
    const a = adviseFundingPlay(fundingRow({ nextFundingMs: 0 }), SETTLE)!;
    expect(a).not.toBeNull();
    expect(a.phase).toBe("post-settlement");
    expect(a.minutesToFunding).toBe(0);
    expect(a.whatFlipsIt.length).toBeGreaterThan(0);
  });
});

describe("adviseFundingPlay — hazards", () => {
  it("always flags rate-decay and settlement-minute volatility when there is an edge", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 10 * MIN)!;
    expect(a.hazards.some((h) => /prediction/i.test(h))).toBe(true);
    expect(a.hazards.some((h) => /settlement-minute volatility/i.test(h))).toBe(true);
  });

  it("flags thin-book slippage only at prime extremes", () => {
    const prime = adviseFundingPlay(fundingRow({ fundingRate: 0.02 }), SETTLE - 10 * MIN)!;
    const mild = adviseFundingPlay(fundingRow({ fundingRate: 0.006 }), SETTLE - 10 * MIN)!;
    expect(prime.hazards.some((h) => /thin|slippage/i.test(h))).toBe(true);
    expect(mild.hazards.some((h) => /thin|slippage/i.test(h))).toBe(false);
  });

  it("flags non-8h intervals and stays silent on the 8h norm", () => {
    const four = adviseFundingPlay(fundingRow({ intervalHours: 4 }), SETTLE - 10 * MIN)!;
    const eight = adviseFundingPlay(fundingRow({ intervalHours: 8 }), SETTLE - 10 * MIN)!;
    expect(four.hazards.some((h) => /Non-standard 4h/i.test(h))).toBe(true);
    expect(eight.hazards.some((h) => /Non-standard/i.test(h))).toBe(false);
  });
});

describe("adviseFundingPlay — reversal note and prose", () => {
  it("frames the reversal as a separate momentum bet with max-loss discipline", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 10 * MIN)!;
    expect(a.reversalNote).toMatch(/separate momentum bet/i);
    expect(a.reversalNote).toMatch(/zero funding edge/i);
    expect(a.reversalNote).toMatch(/tendency, not a promise/i);
    expect(a.reversalNote).toMatch(/max-loss/i);
  });

  it("writes a note combining rate, side, capture and break-even move", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 10 * MIN)!;
    expect(a.note).toMatch(/SHORT/);
    expect(a.note).toMatch(/funding/i);
    expect(a.note).toMatch(/break-even/i);
    expect(a.note.length).toBeGreaterThan(0);
  });
});

describe("adviseFundingPlay — whatFlipsIt is never empty across the lifecycle", () => {
  const nows = [SETTLE - 90 * MIN, SETTLE - 30 * MIN, SETTLE - 30_000, SETTLE, SETTLE + 120 * MIN];
  for (const now of nows) {
    it(`has a non-empty whatFlipsIt at now=${now - SETTLE}ms from settlement`, () => {
      const a = adviseFundingPlay(fundingRow(), now)!;
      expect(a.whatFlipsIt.trim().length).toBeGreaterThan(0);
    });
  }

  it("keeps whatFlipsIt populated for a negative-edge skip", () => {
    const a = adviseFundingPlay(fundingRow(), SETTLE - 10 * MIN, cfg({ takerFeeRate: 0.011 }))!;
    expect(a.whatFlipsIt.trim().length).toBeGreaterThan(0);
  });
});

describe("rankFundingPlays — best first, actionability precedence", () => {
  it("puts an actionable take above a higher-edge not-yet", () => {
    const now = SETTLE - 10 * MIN;
    const rows: FundingRow[] = [
      // Big edge but the window is far off → not-yet.
      fundingRow({
        ticker: "BIG",
        pair: "BIGUSDT",
        fundingRate: 0.05,
        nextFundingMs: SETTLE + 60 * MIN,
      }),
      // Smaller edge but inside the window right now → take.
      fundingRow({ ticker: "NOW", pair: "NOWUSDT", fundingRate: 0.006, nextFundingMs: SETTLE }),
    ];
    const ranked = rankFundingPlays(rows, now);
    expect(ranked[0].pair).toBe("NOWUSDT");
    expect(ranked[0].verdict).toBe("take");
    expect(ranked[1].verdict).toBe("not-yet");
  });

  it("orders by net edge within the same actionability tier", () => {
    const now = SETTLE - 10 * MIN;
    const rows: FundingRow[] = [
      fundingRow({ ticker: "LOW", pair: "LOWUSDT", fundingRate: 0.006, nextFundingMs: SETTLE }),
      fundingRow({ ticker: "HIGH", pair: "HIGHUSDT", fundingRate: 0.02, nextFundingMs: SETTLE }),
    ];
    const ranked = rankFundingPlays(rows, now);
    expect(ranked.map((r) => r.pair)).toEqual(["HIGHUSDT", "LOWUSDT"]);
  });

  it("breaks exact ties deterministically by pair name", () => {
    const now = SETTLE - 10 * MIN;
    const rows: FundingRow[] = [
      fundingRow({ ticker: "ZZZ", pair: "ZZZUSDT", fundingRate: 0.02, nextFundingMs: SETTLE }),
      fundingRow({ ticker: "AAA", pair: "AAAUSDT", fundingRate: 0.02, nextFundingMs: SETTLE }),
    ];
    const ranked = rankFundingPlays(rows, now);
    expect(ranked.map((r) => r.pair)).toEqual(["AAAUSDT", "ZZZUSDT"]);
    // Deterministic regardless of input order.
    expect(rankFundingPlays([...rows].reverse(), now).map((r) => r.pair)).toEqual([
      "AAAUSDT",
      "ZZZUSDT",
    ]);
  });

  it("drops rows below the extreme-rate gate", () => {
    const now = SETTLE - 10 * MIN;
    const rows: FundingRow[] = [
      fundingRow({ ticker: "OK", pair: "OKUSDT", fundingRate: 0.02, nextFundingMs: SETTLE }),
      fundingRow({ ticker: "CALM", pair: "CALMUSDT", fundingRate: 0.0001, nextFundingMs: SETTLE }),
    ];
    const ranked = rankFundingPlays(rows, now);
    expect(ranked.map((r) => r.pair)).toEqual(["OKUSDT"]);
  });
});

describe("buildFundingScan", () => {
  it("wraps the ranked plays with source, timestamp and pairs seen", () => {
    const now = SETTLE - 10 * MIN;
    const rows: FundingRow[] = [
      fundingRow({ ticker: "A", pair: "AUSDT", fundingRate: 0.02, nextFundingMs: SETTLE }),
      fundingRow({ ticker: "B", pair: "BUSDT", fundingRate: 0.0001, nextFundingMs: SETTLE }),
    ];
    const scan = buildFundingScan(rows, now, "live");
    expect(scan.source).toBe("live");
    expect(scan.pairsSeen).toBe(2); // seen before filtering
    expect(scan.plays).toHaveLength(1); // only the flagged pair survives
    expect(scan.updatedAt).toBe(new Date(now).toISOString());
  });
});
