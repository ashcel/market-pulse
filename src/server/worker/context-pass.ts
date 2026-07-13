import { COINMARKETCAL_IDS } from "@/lib/engine/asset-ids";
import { normalizeCoinMarketCalEvents } from "@/lib/engine/catalyst-events";
import { normalizeCoinGeckoGlobal } from "@/lib/engine/external-context";
import {
  insertMarketContextSnapshot,
  pruneCatalystEvents,
  pruneMarketContextSnapshots,
  upsertCatalystEvents,
  upsertIngestState,
} from "../db/repo";

/**
 * External-context ingestion: poll keyed providers on the worker's slow
 * cadence and persist normalized rows, so the web process answers
 * /api/external-context from Postgres alone — provider keys and provider
 * latency never touch the request path.
 *
 * Same idempotency/isolation philosophy as the event pass: every provider is
 * wrapped in its own try/catch, an outage is recorded in ingest_state (never
 * silent) and must never fail the forward-test tick.
 *
 * Budget: CoinGecko Demo is 10k calls/month; one /global call per 15-min pass
 * is ~2.9k/month — comfortable, no retry needed beyond "next pass".
 */

const FETCH_TIMEOUT_MS = 10_000;
const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export const COINGECKO_SOURCE = "coingecko-global";
export const COINMARKETCAL_SOURCE = "coinmarketcal";

// The calendar changes on hours, not minutes, and CoinMarketCal free-tier rate
// limits are unverified — an inner 6h gate keeps us ≤16 calls/day regardless
// of the outer pass cadence.
const CALENDAR_PASS_MS = Number(process.env.CALENDAR_PASS_INTERVAL_MS ?? 6 * 60 * 60_000);
let lastCalendarAt = 0;

const CALENDAR_WINDOW_DAYS = 7;
const CALENDAR_PAGE_MAX = 75;
const CALENDAR_MAX_PAGES = 4;
const OCCURRED_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface ContextPassResult {
  global: "ok" | "unconfigured" | "error";
  calendar: "ok" | "unconfigured" | "error" | "skipped";
  calendarWritten?: number;
}

async function ingestCoinGeckoGlobal(): Promise<ContextPassResult["global"]> {
  const key = process.env.COINGECKO_API_KEY;
  if (!key) {
    // Skipped is a recorded state, not silence — health reports it distinctly
    // from a failure, and it never degrades overall status.
    await upsertIngestState(COINGECKO_SOURCE, "unconfigured", "COINGECKO_API_KEY not set");
    return "unconfigured";
  }
  const res = await fetch("https://api.coingecko.com/api/v3/global", {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "x-cg-demo-api-key": key, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`coingecko /global ${res.status}`);
  const snapshot = normalizeCoinGeckoGlobal(await res.json());
  if (!snapshot) throw new Error("coingecko /global: unexpected payload shape");
  await insertMarketContextSnapshot(snapshot);
  await upsertIngestState(COINGECKO_SOURCE, "ok");
  return "ok";
}

async function ingestCoinMarketCal(): Promise<{
  status: Exclude<ContextPassResult["calendar"], "skipped">;
  written: number;
}> {
  const key = process.env.COINMARKETCAL_API_KEY;
  if (!key) {
    await upsertIngestState(COINMARKETCAL_SOURCE, "unconfigured", "COINMARKETCAL_API_KEY not set");
    return { status: "unconfigured", written: 0 };
  }
  const now = Date.now();
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let written = 0;
  for (let page = 1; page <= CALENDAR_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      dateRangeStart: fmt(now),
      dateRangeEnd: fmt(now + CALENDAR_WINDOW_DAYS * 24 * 60 * 60_000),
      coins: COINMARKETCAL_IDS.join(","),
      max: String(CALENDAR_PAGE_MAX),
      page: String(page),
    });
    const res = await fetch(`https://developers.coinmarketcal.com/v1/events?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "x-api-key": key, accept: "application/json" },
    });
    // 429 = free-tier throttle; back off to the next 6h gate rather than retry.
    if (!res.ok) throw new Error(`coinmarketcal /events page ${page}: ${res.status}`);
    const events = normalizeCoinMarketCalEvents(await res.json(), now);
    written += await upsertCatalystEvents(events);
    if (events.length < CALENDAR_PAGE_MAX) break; // last page
  }
  await upsertIngestState(COINMARKETCAL_SOURCE, "ok");
  return { status: "ok", written };
}

export async function runContextPass(): Promise<ContextPassResult> {
  let global: ContextPassResult["global"];
  try {
    global = await ingestCoinGeckoGlobal();
  } catch (err) {
    global = "error";
    console.error(`[context] ${COINGECKO_SOURCE} failed:`, (err as Error).message);
    await upsertIngestState(COINGECKO_SOURCE, "error", (err as Error).message).catch(() => {});
  }

  let calendar: ContextPassResult["calendar"] = "skipped";
  let calendarWritten: number | undefined;
  if (Date.now() - lastCalendarAt >= CALENDAR_PASS_MS) {
    lastCalendarAt = Date.now();
    try {
      const result = await ingestCoinMarketCal();
      calendar = result.status;
      calendarWritten = result.written;
    } catch (err) {
      calendar = "error";
      console.error(`[context] ${COINMARKETCAL_SOURCE} failed:`, (err as Error).message);
      await upsertIngestState(COINMARKETCAL_SOURCE, "error", (err as Error).message).catch(
        () => {},
      );
    }
  }

  // Retention is a courtesy sweep; a failure here is harmless and retried next pass.
  await pruneMarketContextSnapshots(
    new Date(Date.now() - SNAPSHOT_RETENTION_MS).toISOString(),
  ).catch(() => {});
  await pruneCatalystEvents(new Date(Date.now() - OCCURRED_RETENTION_MS).toISOString()).catch(
    () => {},
  );

  return { global, calendar, calendarWritten };
}
