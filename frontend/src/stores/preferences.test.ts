import { describe, it, expect, beforeEach } from "vitest";

import { riskDefaultsForCapSegment, sanitizeCapSegment, usePreferencesStore } from "./preferences";

describe("riskDefaultsForCapSegment", () => {
  it("gives bigcap looser risk, tighter minimum RR bar, and higher leverage", () => {
    expect(riskDefaultsForCapSegment("bigcap")).toEqual({
      maxRiskPerTradePercent: 1.0,
      minimumRewardRisk: 1.5,
      leverage: 5,
    });
  });

  it("gives smallcap tighter risk, higher minimum RR bar, and lower leverage", () => {
    expect(riskDefaultsForCapSegment("smallcap")).toEqual({
      maxRiskPerTradePercent: 0.5,
      minimumRewardRisk: 2.0,
      leverage: 2,
    });
  });

  it("smallcap defaults are strictly more conservative than bigcap's", () => {
    const big = riskDefaultsForCapSegment("bigcap");
    const small = riskDefaultsForCapSegment("smallcap");
    expect(small.maxRiskPerTradePercent).toBeLessThan(big.maxRiskPerTradePercent);
    expect(small.leverage).toBeLessThan(big.leverage);
    expect(small.minimumRewardRisk).toBeGreaterThan(big.minimumRewardRisk);
  });
});

describe("sanitizeCapSegment", () => {
  it("accepts the two valid segments", () => {
    expect(sanitizeCapSegment("bigcap")).toBe("bigcap");
    expect(sanitizeCapSegment("smallcap")).toBe("smallcap");
  });

  it("rejects anything else to null", () => {
    expect(sanitizeCapSegment(null)).toBeNull();
    expect(sanitizeCapSegment(undefined)).toBeNull();
    expect(sanitizeCapSegment("")).toBeNull();
    expect(sanitizeCapSegment("midcap")).toBeNull();
    expect(sanitizeCapSegment(42)).toBeNull();
    expect(sanitizeCapSegment({})).toBeNull();
  });
});

describe("usePreferencesStore setCapSegment", () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      capSegment: null,
      leverage: 5,
      risk: {
        accountSize: 10_000,
        maxRiskPerTradePercent: 0.5,
        minimumRewardRisk: 1.6,
        stopMethod: "swing",
      },
    });
  });

  it("applies bigcap defaults to leverage and risk prefs", () => {
    usePreferencesStore.getState().setCapSegment("bigcap");
    const s = usePreferencesStore.getState();
    expect(s.capSegment).toBe("bigcap");
    expect(s.leverage).toBe(5);
    expect(s.risk.maxRiskPerTradePercent).toBe(1.0);
    expect(s.risk.minimumRewardRisk).toBe(1.5);
  });

  it("applies smallcap defaults to leverage and risk prefs, preserving other risk fields", () => {
    usePreferencesStore.getState().setCapSegment("smallcap");
    const s = usePreferencesStore.getState();
    expect(s.capSegment).toBe("smallcap");
    expect(s.leverage).toBe(2);
    expect(s.risk.maxRiskPerTradePercent).toBe(0.5);
    expect(s.risk.minimumRewardRisk).toBe(2.0);
    expect(s.risk.accountSize).toBe(10_000);
    expect(s.risk.stopMethod).toBe("swing");
  });

  it("lets the user hand-tune risk again after a segment pick", () => {
    usePreferencesStore.getState().setCapSegment("smallcap");
    usePreferencesStore.getState().setRisk({ maxRiskPerTradePercent: 3 });
    expect(usePreferencesStore.getState().risk.maxRiskPerTradePercent).toBe(3);
    // The segment choice itself is untouched by hand-tuning.
    expect(usePreferencesStore.getState().capSegment).toBe("smallcap");
  });
});
