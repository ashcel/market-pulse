import { describe, expect, it } from "vitest";

import { createBinanceLimiter, klineWeight } from "./rate-limit";

describe("createBinanceLimiter", () => {
  it("spends tokens immediately while under budget", async () => {
    const now = 0;
    const limiter = createBinanceLimiter(100, () => now);

    const start = now;
    await limiter.acquire(10);
    await limiter.acquire(10);
    // No refill needed — 20 of 100 tokens spent, both resolve without a wait.
    expect(now).toBe(start);
  });

  it("staggers a caller past budget until enough tokens refill", async () => {
    let now = 0;
    const realSetTimeout = globalThis.setTimeout;
    // Fake timers so `await new Promise(setTimeout)` inside the limiter
    // resolves instantly while still advancing the injected clock — proves
    // the limiter actually waits (not just races ahead) without a real delay.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      now += ms ?? 0;
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;

    try {
      const capacity = 60; // refills at 1 token/ms
      const limiter = createBinanceLimiter(capacity, () => now);

      await limiter.acquire(60); // drains the bucket
      const before = now;
      await limiter.acquire(10); // must wait ~10ms for refill
      expect(now).toBeGreaterThanOrEqual(before + 10);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("serializes concurrent acquires instead of letting them race the same tokens", async () => {
    let now = 0;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      now += ms ?? 0;
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;

    try {
      const limiter = createBinanceLimiter(10, () => now); // refills at 1/6 token per ms

      // Three concurrent callers for weight 4 each against a 10-token bucket:
      // at most two can be satisfied before the third must wait for a refill.
      const order: number[] = [];
      await Promise.all([
        limiter.acquire(4).then(() => order.push(1)),
        limiter.acquire(4).then(() => order.push(2)),
        limiter.acquire(4).then(() => order.push(3)),
      ]);
      expect(order).toEqual([1, 2, 3]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe("klineWeight", () => {
  it("matches Binance's published /klines weight schedule", () => {
    expect(klineWeight(1)).toBe(1);
    expect(klineWeight(100)).toBe(1);
    expect(klineWeight(101)).toBe(2);
    expect(klineWeight(500)).toBe(2);
    expect(klineWeight(501)).toBe(5);
    expect(klineWeight(1000)).toBe(5);
  });
});
