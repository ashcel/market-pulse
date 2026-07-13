import { TICKER_BY_COINMARKETCAL_ID } from "./asset-ids";

/**
 * CoinMarketCal → catalyst_event normalization. Pure and fixture-testable:
 * the worker's context pass fetches, this file decides what qualifies.
 *
 * Filtering philosophy (high-signal over volume):
 * - Coins are mapped by PROVIDER ID via asset-ids.ts; unmapped coins drop.
 * - A credibility gate keeps only events with a proof link, enough votes, or
 *   high provider confidence — the crowd-sourced tail is noise by default.
 * - percentOfSupply stays null on the free tier: the prompt layer must then
 *   present an unlock as a scheduling fact, never a supply-pressure signal.
 */

export type CatalystKind = "unlock" | "listing" | "upgrade" | "fork" | "burn" | "other";

export interface CatalystCredibility {
  votes: number | null;
  confidencePct: number | null;
  hotScore: number | null;
}

export interface CatalystEventInput {
  symbol: string;
  kind: CatalystKind;
  title: string;
  description: string | null;
  occursAt: string;
  source: string;
  sourceId: string | null;
  url: string | null;
  credibility: CatalystCredibility | null;
  percentOfSupply: number | null;
  dedupKey: string;
}

// Category name → kind, first match wins. Checked lowercase-inclusive so
// "Token Unlock", "Unlocks" and "unlock" all land the same place.
const KIND_BY_CATEGORY: Array<[RegExp, CatalystKind]> = [
  [/unlock|vesting/, "unlock"],
  [/listing|exchange/, "listing"],
  [/fork|swap/, "fork"],
  [/burn/, "burn"],
  [/release|update|upgrade|mainnet|testnet|hard fork/, "upgrade"],
];

const MIN_VOTES = 15;
const MIN_CONFIDENCE_PCT = 80;

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  // CoinMarketCal titles/descriptions arrive as { en: "..." }.
  const en = (value as { en?: unknown } | null)?.en;
  return typeof en === "string" && en.trim() ? en.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function classifyKind(categories: unknown): CatalystKind {
  const names = Array.isArray(categories)
    ? categories
        .map((c) => asString((c as { name?: unknown })?.name) ?? "")
        .join(" ")
        .toLowerCase()
    : "";
  for (const [re, kind] of KIND_BY_CATEGORY) if (re.test(names)) return kind;
  return "other";
}

/** proof link OR enough votes OR high provider confidence — else it's noise. */
export function passesCredibilityGate(input: {
  url: string | null;
  votes: number | null;
  confidencePct: number | null;
}): boolean {
  if (input.url) return true;
  if (input.votes !== null && input.votes >= MIN_VOTES) return true;
  if (input.confidencePct !== null && input.confidencePct >= MIN_CONFIDENCE_PCT) return true;
  return false;
}

/**
 * Normalize one CoinMarketCal `/v1/events` response page. Events fan out one
 * row per mapped coin; a whole-payload shape surprise returns [] (the caller
 * records an ingest error when the fetch failed — an empty page is valid).
 */
export function normalizeCoinMarketCalEvents(
  payload: unknown,
  nowMs: number,
): CatalystEventInput[] {
  const body = (payload as { body?: unknown } | null)?.body;
  if (!Array.isArray(body)) return [];
  const out: CatalystEventInput[] = [];
  for (const raw of body) {
    const ev = raw as Record<string, unknown>;
    const title = asString(ev.title);
    const occursAtMs = Date.parse(asString(ev.date_event) ?? "");
    if (!title || !Number.isFinite(occursAtMs)) continue;
    // Past events (beyond a day of timezone slack) are not "what matters next".
    if (occursAtMs < nowMs - 24 * 60 * 60_000) continue;

    const sourceId = asString(ev.id) ?? (asNumber(ev.id) !== null ? String(ev.id) : null);
    const url = asString(ev.proof) ?? asString(ev.source);
    const votes = asNumber(ev.vote_count);
    const confidencePct = asNumber(ev.percentage);
    const hotScore = asNumber(ev.hot_index) ?? asNumber(ev.trending_index);
    if (!passesCredibilityGate({ url, votes, confidencePct })) continue;

    const kind = classifyKind(ev.categories);
    const coins = Array.isArray(ev.coins) ? ev.coins : [];
    for (const coin of coins) {
      const providerId = asString((coin as { id?: unknown })?.id);
      const symbol = providerId ? TICKER_BY_COINMARKETCAL_ID[providerId] : undefined;
      if (!symbol) continue; // unmapped coin — dropped by design
      out.push({
        symbol,
        kind,
        title,
        description: asString(ev.description),
        occursAt: new Date(occursAtMs).toISOString(),
        source: "coinmarketcal",
        sourceId,
        url,
        credibility: { votes, confidencePct, hotScore },
        percentOfSupply: null, // not exposed on the free tier — see header
        dedupKey: `coinmarketcal:${sourceId ?? `${title}:${occursAtMs}`}:${symbol}`,
      });
    }
  }
  return out;
}
