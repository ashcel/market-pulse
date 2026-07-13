import { normalizeCoinGeckoGlobal } from "@/lib/engine/external-context";
import {
  insertMarketContextSnapshot,
  pruneMarketContextSnapshots,
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
export interface ContextPassResult {
  global: "ok" | "unconfigured" | "error";
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

export async function runContextPass(): Promise<ContextPassResult> {
  let global: ContextPassResult["global"];
  try {
    global = await ingestCoinGeckoGlobal();
  } catch (err) {
    global = "error";
    console.error(`[context] ${COINGECKO_SOURCE} failed:`, (err as Error).message);
    await upsertIngestState(COINGECKO_SOURCE, "error", (err as Error).message).catch(() => {});
  }

  // Retention is a courtesy sweep; a failure here is harmless and retried next pass.
  await pruneMarketContextSnapshots(
    new Date(Date.now() - SNAPSHOT_RETENTION_MS).toISOString(),
  ).catch(() => {});
  return { global };
}
