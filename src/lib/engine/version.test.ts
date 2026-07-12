import { describe, expect, it } from "vitest";

import { shadowComboStats, type ShadowSignal } from "./shadow";
import { assertProvenance, configHash, currentProvenance, ENGINE_VERSION } from "./version";

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

// WS2 — provenance completeness. `assertProvenance` is the last guard before
// a shadow/anticipatory/tracked record hits the DB (see repo.ts's
// `openShadow`/`openAnticipatory`/`followTracked`); it must pass every record
// the engine actually builds and reject anything with a blank field instead
// of the old silent `?? ""` fallback that would have pooled a mis-stamped row
// into `engineVersion`-segmented stats forever.
describe("assertProvenance", () => {
  it("passes currentProvenance() — the real stamp every build*Signal call spreads in", () => {
    expect(() => assertProvenance(currentProvenance())).not.toThrow();
  });

  it("throws when engineVersion is missing or blank", () => {
    expect(() => assertProvenance({ configHash: "abc", gitSha: "def" })).toThrow(/provenance/i);
    expect(() => assertProvenance({ engineVersion: "", configHash: "abc", gitSha: "def" })).toThrow(
      /provenance/i,
    );
  });

  it("throws when configHash is missing or blank", () => {
    expect(() => assertProvenance({ engineVersion: "1.0.0", gitSha: "def" })).toThrow(
      /provenance/i,
    );
  });

  it("throws when gitSha is missing or blank", () => {
    expect(() => assertProvenance({ engineVersion: "1.0.0", configHash: "abc" })).toThrow(
      /provenance/i,
    );
  });

  it("accepts gitSha's dev fallback of 'unknown' — that's a deliberate non-blank default", () => {
    expect(() =>
      assertProvenance({ engineVersion: "1.0.0", configHash: "abc", gitSha: "unknown" }),
    ).not.toThrow();
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
    regime: "trending-up",
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
