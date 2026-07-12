import { WORKER_UNIVERSE } from "./market";
import type { RssItemRaw } from "./news";

/**
 * Token event intelligence (Phase 2.5) — classifies news items into typed,
 * per-token events a holder needs to know about: unlocks, security incidents,
 * regulatory actions, exchange listings/delistings, protocol upgrades.
 * Framework-free and pure; the worker ingests, Postgres stores, the event
 * watcher notifies. Matching runs over the full WORKER_UNIVERSE (50 tokens),
 * not just the dashboard's 18 — relevance filtering happens at notification
 * time, never here.
 */

export type TokenEventKind =
  "unlock" | "security" | "regulatory" | "delisting" | "listing" | "upgrade";

export type TokenEventSeverity = "info" | "warning" | "critical";

export interface TokenEventInput {
  symbol: string;
  kind: TokenEventKind;
  severity: TokenEventSeverity;
  title: string;
  body: string | null;
  source: string;
  url: string | null;
  /** ISO timestamp the article was published. */
  publishedAt: string;
  /** One row per (article, symbol, kind) — re-ingestion is a no-op. */
  dedupKey: string;
}

/**
 * Kind patterns, checked in order — the FIRST match wins, so the most
 * safety-critical kinds come first (an article about an exploit that also
 * mentions a listing is a security event). Severity is per kind:
 * security incidents are critical; unlocks, delistings, and regulatory
 * actions are warnings (position-relevant, time-sensitive); listings and
 * upgrades are informational.
 */
const KIND_RULES: { kind: TokenEventKind; severity: TokenEventSeverity; pattern: RegExp }[] = [
  {
    kind: "security",
    severity: "critical",
    pattern:
      /\b(hack(?:ed|er)?s?|exploit(?:ed|s)?|breach(?:ed)?|drain(?:ed|s)?|stolen|steal(?:s|ing)?|vulnerabilit\w*|rug[- ]?pull|phishing|attack(?:ed|er)?s?|compromised)\b/i,
  },
  {
    kind: "unlock",
    severity: "warning",
    pattern: /\b(unlock(?:s|ed|ing)?|vesting|cliff)\b/i,
  },
  {
    kind: "delisting",
    severity: "warning",
    pattern: /\b(delist(?:s|ed|ing)?)\b/i,
  },
  {
    kind: "regulatory",
    severity: "warning",
    pattern:
      /\b(lawsuit|sues?d?|charges?|indicted?|subpoena\w*|crackdown|fined?|settlement|regulat\w*|banned|bans)\b/i,
  },
  {
    kind: "listing",
    severity: "info",
    pattern:
      /\b(list(?:s|ed|ing))\b[\s\S]{0,80}\b(binance|coinbase|kraken|upbit|okx|bybit|bitget)\b/i,
  },
  {
    kind: "upgrade",
    severity: "info",
    pattern: /\b(mainnet|hard[- ]?fork|upgrade[sd]?|airdrops?|halving|testnet launch)\b/i,
  },
];

interface AssetMatcher {
  ticker: string;
  /** Case-SENSITIVE for short tickers (≤3 chars) to avoid "photo op" → OP etc. */
  tickerRe: RegExp;
  nameRe: RegExp;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MATCHERS: AssetMatcher[] = WORKER_UNIVERSE.map((entry) => ({
  ticker: entry.ticker,
  // Short tickers are common English words/abbreviations in lowercase prose
  // ("op", "ar", "ena"...) — require the exact uppercase form. Longer tickers
  // are distinctive enough to match case-insensitively.
  tickerRe: new RegExp(`\\b${escapeRe(entry.ticker)}\\b`, entry.ticker.length <= 3 ? "" : "i"),
  nameRe: new RegExp(`\\b${escapeRe(entry.name)}\\b`, "i"),
}));

/** Tickers whose token this text is about (name or ticker mention, ≤4 to cap broad roundups). */
export function detectEventAssets(text: string): string[] {
  const found: string[] = [];
  for (const m of MATCHERS) {
    if (m.tickerRe.test(text) || m.nameRe.test(text)) found.push(m.ticker);
    if (found.length >= 4) break;
  }
  return found;
}

/** FNV-1a, for stable dedup keys when a feed item has no guid/url. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Classify one feed's raw items into token events. An item produces at most
 * one kind (first matching rule) across up to 4 matched assets; items with no
 * asset match or no kind match produce nothing — event alerts must be
 * token-specific, so there is deliberately no "Crypto"-wide fallback.
 */
export function classifyTokenEvents(
  items: RssItemRaw[],
  source: string,
  now = Date.now(),
): TokenEventInput[] {
  const events: TokenEventInput[] = [];
  for (const item of items) {
    const text = `${item.headline} ${item.description}`;
    const rule = KIND_RULES.find((r) => r.pattern.test(text));
    if (!rule) continue;
    const assets = detectEventAssets(text);
    if (assets.length === 0) continue;

    const articleKey = item.guid ?? item.url ?? hash(item.headline);
    const publishedAt = new Date(item.publishedAtMs ?? now).toISOString();
    for (const symbol of assets) {
      events.push({
        symbol,
        kind: rule.kind,
        severity: rule.severity,
        title: item.headline,
        body: item.description || null,
        source,
        url: item.url,
        publishedAt,
        dedupKey: `${source}:${articleKey}:${symbol}:${rule.kind}`,
      });
    }
  }
  return events;
}
