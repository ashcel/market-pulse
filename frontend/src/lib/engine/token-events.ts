import { WORKER_UNIVERSE } from "./market";
import type { RssItemRaw } from "./news";

/**
 * Token event intelligence (Phase 2.5) — classifies news items into typed,
 * per-token events a holder needs to know about: unlocks, security incidents,
 * regulatory actions, exchange listings/delistings, protocol upgrades.
 * Framework-free and pure; the worker ingests, Postgres stores, the event
 * watcher notifies. Matching runs over the full WORKER_UNIVERSE (50 tokens)
 * by name or ticker, plus — via `extraTickers` — the whole Binance tradable
 * directory ticker-only, so discovery-layer tokens get event coverage too.
 * Relevance filtering happens at notification time, never here.
 */

export type TokenEventKind =
  | "unlock"
  | "security"
  | "regulatory"
  | "delisting"
  | "listing"
  | "upgrade";

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

const UNIVERSE_TICKERS = new Set(WORKER_UNIVERSE.map((u) => u.ticker));

/**
 * Real Binance bases that are also everyday crypto-news vocabulary in
 * uppercase — matching them ticker-only would tag nearly every article.
 * (Universe tokens are unaffected: they also match by full name.)
 */
const EXTRA_TICKER_STOPLIST = new Set(["AI", "NFT", "ID", "DAO", "MEME", "ACT", "NOT", "WHY"]);

// The directory has ~600 bases and the pass runs every few minutes — compile
// each ticker's pattern once, not once per article.
const extraTickerReCache = new Map<string, RegExp>();

function extraTickerRe(ticker: string): RegExp {
  let re = extraTickerReCache.get(ticker);
  if (!re) {
    re = new RegExp(`\\b${escapeRe(ticker)}\\b`);
    extraTickerReCache.set(ticker, re);
  }
  return re;
}

/**
 * Directory tickers (out-of-universe) match on the EXACT uppercase ticker
 * only, regardless of length: we have no display names for them, and
 * case-insensitive matching over 600 bases would false-positive on common
 * words (SAND, MASK, BOND...). Crypto headlines write tickers uppercase, so
 * this catches the mentions that matter. 1-char bases (T, W...) are skipped —
 * a bare capital letter is noise, not a mention.
 */
function isMatchableExtra(ticker: string): boolean {
  return ticker.length >= 2 && !UNIVERSE_TICKERS.has(ticker) && !EXTRA_TICKER_STOPLIST.has(ticker);
}

/**
 * Tickers whose token this text is about (≤4 to cap broad roundups). Universe
 * tokens match by name or ticker; `extraTickers` (e.g. the full Binance
 * tradable directory) match ticker-only, uppercase-exact.
 */
export function detectEventAssets(text: string, extraTickers: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const m of MATCHERS) {
    if (m.tickerRe.test(text) || m.nameRe.test(text)) found.push(m.ticker);
    if (found.length >= 4) return found;
  }
  for (const raw of extraTickers) {
    const ticker = raw.toUpperCase();
    if (!isMatchableExtra(ticker)) continue;
    if (extraTickerRe(ticker).test(text)) found.push(ticker);
    if (found.length >= 4) break;
  }
  return found;
}

/**
 * Roundup/listicle headlines ("Top 5 cryptos to watch", "Weekly market wrap",
 * "SOL, ADA, XRP price analysis...") mention many tokens without being ABOUT
 * any of them — the known noise source that padded token-event alerts and
 * would now pad the AI's context section. A multi-asset item with a headline
 * in this shape is dropped whole.
 */
const ROUNDUP_HEADLINE_RE =
  /price (analysis|prediction)|top \d|weekly|daily|roundup|market wrap|to watch|best cryptos?/i;
const ROUNDUP_MIN_ASSETS = 3;

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
 * `extraTickers` widens asset detection beyond the worker universe (see
 * detectEventAssets) so discovery-layer tokens accumulate event history too.
 */
export function classifyTokenEvents(
  items: RssItemRaw[],
  source: string,
  now = Date.now(),
  extraTickers: readonly string[] = [],
): TokenEventInput[] {
  const events: TokenEventInput[] = [];
  for (const item of items) {
    const text = `${item.headline} ${item.description}`;
    const rule = KIND_RULES.find((r) => r.pattern.test(text));
    if (!rule) continue;
    const assets = detectEventAssets(text, extraTickers);
    if (assets.length === 0) continue;
    // Multi-asset listicles are about the format, not the tokens. A genuine
    // multi-asset story (e.g. an exploit hitting several tokens) survives —
    // its headline doesn't read like a roundup.
    if (assets.length >= ROUNDUP_MIN_ASSETS && ROUNDUP_HEADLINE_RE.test(item.headline)) continue;
    // Info-severity kinds (listings, upgrades) are only worth recording when
    // the token is the story: require the mention in the headline itself, not
    // buried in the description. Critical/warning kinds keep the wider net.
    const headlineAssets =
      rule.severity === "info" ? new Set(detectEventAssets(item.headline, extraTickers)) : null;

    const articleKey = item.guid ?? item.url ?? hash(item.headline);
    const publishedAt = new Date(item.publishedAtMs ?? now).toISOString();
    for (const symbol of assets) {
      if (headlineAssets && !headlineAssets.has(symbol)) continue;
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
