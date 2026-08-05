import { describe, expect, it } from "vitest";

import { AiRateLimiter, callerKey, limitsFromEnv } from "./rate-limit";

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const config = { perCaller: 3, windowMs: 60_000, dailyTotal: 5 };

describe("AiRateLimiter", () => {
  it("allows up to the per-caller ceiling, then denies", () => {
    const limiter = new AiRateLimiter(config);
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("ip:1", NOW).allowed).toBe(true);
    }
    const denied = limiter.check("ip:1", NOW);
    expect(denied).toMatchObject({ allowed: false, reason: "caller", remaining: 0 });
  });

  it("counts down the remaining allowance", () => {
    const limiter = new AiRateLimiter(config);
    expect(limiter.check("ip:1", NOW).remaining).toBe(2);
    expect(limiter.check("ip:1", NOW).remaining).toBe(1);
    expect(limiter.check("ip:1", NOW).remaining).toBe(0);
  });

  it("does not let one caller's spending throttle another", () => {
    const limiter = new AiRateLimiter(config);
    for (let i = 0; i < 3; i++) limiter.check("ip:1", NOW);
    expect(limiter.check("ip:2", NOW).allowed).toBe(true);
  });

  it("refills when the window rolls over", () => {
    const limiter = new AiRateLimiter(config);
    for (let i = 0; i < 3; i++) limiter.check("ip:1", NOW);
    expect(limiter.check("ip:1", NOW + 59_000).allowed).toBe(false);
    expect(limiter.check("ip:1", NOW + 60_001).allowed).toBe(true);
  });

  it("a denied request does not consume quota", () => {
    const limiter = new AiRateLimiter({ perCaller: 1, windowMs: 60_000, dailyTotal: 10 });
    limiter.check("ip:1", NOW);
    limiter.check("ip:1", NOW);
    limiter.check("ip:1", NOW);
    expect(limiter.usedToday(NOW)).toBe(1);
  });

  it("enforces the global daily ceiling across every caller", () => {
    const limiter = new AiRateLimiter(config);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(`ip:${i}`, NOW).allowed).toBe(true);
    }
    // Sixth caller has personal allowance left, but the day's budget is spent.
    const denied = limiter.check("ip:99", NOW);
    expect(denied).toMatchObject({ allowed: false, reason: "daily" });
    expect(denied.remaining).toBeGreaterThan(0);
  });

  it("resets the daily budget on the next UTC day", () => {
    const limiter = new AiRateLimiter(config);
    for (let i = 0; i < 5; i++) limiter.check(`ip:${i}`, NOW);
    expect(limiter.check("ip:99", NOW).allowed).toBe(false);
    const tomorrow = NOW + 24 * 60 * 60_000;
    expect(limiter.check("ip:99", tomorrow).allowed).toBe(true);
    expect(limiter.usedToday(tomorrow)).toBe(1);
  });

  it("reports when the caller's window resets", () => {
    const limiter = new AiRateLimiter(config);
    expect(limiter.check("ip:1", NOW).resetAt).toBe(NOW + 60_000);
  });
});

describe("callerKey", () => {
  const req = (headers: Record<string, string> = {}) =>
    new Request("https://x/api/ai/chat/completions", { headers });

  it("bills a signed-in user to their account, not a shared IP", () => {
    expect(callerKey("u1", req({ "x-forwarded-for": "1.2.3.4" }))).toBe("user:u1");
  });

  it("uses the first forwarded hop for anonymous callers", () => {
    expect(callerKey(null, req({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("ip:1.2.3.4");
    expect(callerKey(null, req({ "x-real-ip": "5.6.7.8" }))).toBe("ip:5.6.7.8");
  });

  it("degrades to a shared bucket when no IP header is present", () => {
    expect(callerKey(null, req())).toBe("ip:unknown");
  });
});

describe("limitsFromEnv", () => {
  it("falls back to the defaults on unset or nonsense values", () => {
    expect(limitsFromEnv({})).toEqual({ perCaller: 5, windowMs: 3_600_000, dailyTotal: 500 });
    expect(limitsFromEnv({ AI_PROXY_PER_CALLER: "-3" }).perCaller).toBe(5);
    expect(limitsFromEnv({ AI_PROXY_DAILY_TOTAL: "abc" }).dailyTotal).toBe(500);
  });

  it("takes operator overrides", () => {
    expect(
      limitsFromEnv({ AI_PROXY_PER_CALLER: "20", AI_PROXY_DAILY_TOTAL: "2000" }),
    ).toMatchObject({ perCaller: 20, dailyTotal: 2000 });
  });
});
