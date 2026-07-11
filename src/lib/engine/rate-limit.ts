/**
 * Token-bucket limiter over Binance's per-IP request-weight budget (WS4).
 * Binance caps spot/futures REST at 6000 request-weight/min per IP; a
 * single runaway pass (worker walking 22 symbols × 6 timeframes + a settle
 * pass over every open record, on a 5-minute loop) is nowhere near that on
 * its own, but a stuck retry loop or an overlapping web+worker burst on the
 * same VPS IP shouldn't be able to get it 418/429-banned either. Budgeting
 * to a fraction of the real ceiling — and serializing acquires through one
 * queue — turns "fire N requests at once" into "fire them, staggered, no
 * faster than the budget refills."
 */
export interface BinanceLimiter {
  acquire(weight: number): Promise<void>;
}

export function createBinanceLimiter(
  capacityPerMinute: number,
  now: () => number = Date.now,
): BinanceLimiter {
  const refillPerMs = capacityPerMinute / 60_000;
  let tokens = capacityPerMinute;
  let last = now();
  let queue: Promise<void> = Promise.resolve();

  function refill(): void {
    const t = now();
    tokens = Math.min(capacityPerMinute, tokens + (t - last) * refillPerMs);
    last = t;
  }

  async function acquireOne(weight: number): Promise<void> {
    for (;;) {
      refill();
      if (tokens >= weight) {
        tokens -= weight;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((weight - tokens) / refillPerMs));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  return {
    acquire(weight: number): Promise<void> {
      // Chained through `queue` so concurrent callers wait their turn in
      // order instead of all racing `acquireOne` and thundering-herding the
      // moment tokens become available.
      const next = queue.then(() => acquireOne(weight));
      queue = next.catch(() => {});
      return next;
    },
  };
}

/**
 * One process-wide budget shared by every Binance call (worker eval pass,
 * worker settle pass, and the web app's on-demand fetches all import the
 * same singleton). A third of Binance's real ceiling leaves headroom for
 * the two processes to share one VPS IP without coordinating directly.
 *
 * Under Vitest this budget would otherwise be shared — and drained — across
 * every test file in a worker process, real-`setTimeout`-waiting on tests
 * that only ever hit `installFakeBinance()`, never the real API. A no-op
 * limiter there keeps the budget meaningful in prod without making the test
 * suite's runtime depend on how many fixture "requests" preceded it.
 */
export const binanceLimiter: BinanceLimiter = process.env.VITEST
  ? { acquire: async () => {} }
  : createBinanceLimiter(2000);

/** Binance's published weight schedule for GET /klines, keyed by `limit`. */
export function klineWeight(limit: number): number {
  if (limit <= 100) return 1;
  if (limit <= 500) return 2;
  return 5;
}

/** GET /ticker/price weight (single symbol). */
export const TICKER_PRICE_WEIGHT = 2;
