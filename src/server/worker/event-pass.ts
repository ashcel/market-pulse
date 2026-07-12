import { parseRssItems } from "@/lib/engine/news";
import { loadAllTradableTickersDirect } from "@/lib/engine/symbols";
import { classifyTokenEvents } from "@/lib/engine/token-events";
import { insertTokenEvents } from "../db/repo";

/**
 * Token-event ingestion (Phase 2.5): pull each news source, classify items
 * into typed per-token events, and store them for the WHOLE worker universe.
 * The dedup unique index makes every re-ingestion a no-op, so the pass needs
 * no cursor and survives restarts for free — same idempotency philosophy as
 * the eval/settle passes.
 *
 * Sources are deliberately a pluggable list: a dedicated unlock-calendar API
 * (TokenUnlocks/CryptoRank/DeFiLlama-paid — all keyed/paid as of 2026-07-12)
 * can be added here later without touching the classifier or the store.
 */
interface EventSource {
  name: string;
  url: string;
}

const SOURCES: EventSource[] = [
  { name: "cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss" },
];

const FETCH_TIMEOUT_MS = 10_000;

export async function runEventPass(): Promise<{ fetched: number; inserted: number }> {
  let fetched = 0;
  let inserted = 0;
  // Full Binance directory (cached ~1h upstream) widens asset detection to
  // out-of-universe tokens; an unreachable directory just narrows matching
  // back to the universe for this pass.
  const directory = await loadAllTradableTickersDirect();
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "market-pulse/1.0" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const events = classifyTokenEvents(
        parseRssItems(await res.text()),
        source.name,
        Date.now(),
        directory,
      );
      fetched += events.length;
      inserted += await insertTokenEvents(events);
    } catch (err) {
      // One dead feed must not starve the other; the next pass retries anyway.
      console.error(`[events] ${source.name} failed:`, (err as Error).message);
    }
  }
  return { fetched, inserted };
}
