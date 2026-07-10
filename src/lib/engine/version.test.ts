import { describe, expect, it } from "vitest";

import { shadowComboStats, type ShadowSignal } from "./shadow";
import { configHash, currentProvenance, ENGINE_VERSION } from "./version";

describe("provenance", () => {
  it("configHash is deterministic across calls", () => {
    expect(configHash()).toBe(configHash());
    expect(configHash()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("currentProvenance carries the engine version + a config hash", () => {
    const p = currentProvenance();
    expect(p.engineVersion).toBe(ENGINE_VERSION);
    expect(p.configHash).toBe(configHash());
    expect(typeof p.gitSha).toBe("string");
  });
});

describe("shadowComboStats engine segmentation", () => {
  const base: Omit<ShadowSignal, "engineVersion"> = {
    id: "1",
    symbol: "BTC",
    market: "spot",
    intent: "swing",
    direction: "long",
    setupType: "lower-high-rejection",
    regime: "uptrend",
    timeframe: "4H",
    entry: 100,
    stop: 95,
    target1: 110,
    target2: 120,
    confidence: 70,
    openedAt: new Date().toISOString(),
    status: "target1-hit",
    resultR: 1,
  };

  const signals: ShadowSignal[] = [
    { ...base, id: "a", engineVersion: "0.9.0-dev" },
    { ...base, id: "b", engineVersion: "0.8.0-old", resultR: -1, status: "stopped-out" },
  ];

  it("pools every version when none is given", () => {
    expect(shadowComboStats(signals)[0].closed).toBe(2);
  });

  it("segments to the requested engine version", () => {
    const scoped = shadowComboStats(signals, "0.9.0-dev");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].closed).toBe(1);
    expect(scoped[0].averageR).toBe(1);
  });

  it("excludes records with no provenance from a versioned query", () => {
    const legacy: ShadowSignal[] = [{ ...base, id: "legacy" }];
    expect(shadowComboStats(legacy, "0.9.0-dev")).toHaveLength(0);
  });
});
