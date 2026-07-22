/**
 * Deterministic news prioritization — product rule: "If a news title
 * contains any tracked ticker symbol, bring that news to top. If the news is
 * about economy/Fed decision, bring it to top as well." Framework-free and
 * pure so it can wrap both live news items (news.ts) and token events
 * (token-events.ts / useTokenEvents), and so the AI layer can reuse it later
 * without a dependency on either.
 *
 * Tiers, highest priority first: macro/economy > tracked-ticker mention >
 * everything else. Within a tier, input order is preserved (stable sort) —
 * callers already hand items in recency order, so this reads as "most
 * important first, then most recent first."
 */

/**
 * Minimal structural shape this module is written against. `publishedAt` is
 * informational only — `prioritizeNews` relies on stable input order for
 * within-tier recency rather than this field, so callers don't need to
 * supply it.
 */
export interface NewsPriorityInput {
  title: string;
  publishedAt?: number;
}

export type NewsPriorityTier = "macro" | "ticker" | "other";

export interface NewsPriorityResult {
  tier: NewsPriorityTier;
  /** Tracked tickers found in the title, in the order `opts.tickers` was given. */
  matchedTickers: string[];
  isMacro: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Purely-alphabetic tickers that double as common English words — matching
 * them case-insensitively would false-positive on ordinary prose ("one small
 * step", "a great photo op", "big deal"...). These only match the literal
 * ALL-CAPS token form or the "$TICKER" cashtag, never loose case-insensitive
 * prose. Union of the stoplist in engine/token-events.ts
 * (EXTRA_TICKER_STOPLIST — Binance bases that double as crypto-news
 * vocabulary) plus the ambiguous tickers called out in the product spec.
 */
const AMBIGUOUS_WORD_TICKERS = new Set([
  "AI",
  "NFT",
  "ID",
  "DAO",
  "MEME",
  "ACT",
  "NOT",
  "WHY",
  "ONE",
  "OP",
  "BIG",
]);

interface TickerRegexes {
  cashtag: RegExp;
  exact: RegExp;
  loose: RegExp;
}

const tickerRegexCache = new Map<string, TickerRegexes>();

function tickerRegexes(ticker: string): TickerRegexes {
  let cached = tickerRegexCache.get(ticker);
  if (!cached) {
    const escaped = escapeRegExp(ticker);
    cached = {
      // The "$" prefix disambiguates intent, so cashtags match case-insensitively.
      cashtag: new RegExp(`\\$${escaped}\\b`, "i"),
      exact: new RegExp(`\\b${escaped}\\b`),
      loose: new RegExp(`\\b${escaped}\\b`, "i"),
    };
    tickerRegexCache.set(ticker, cached);
  }
  return cached;
}

/**
 * True when `title` mentions `rawTicker` as a real ticker reference:
 * word-boundaried, case-insensitive for ordinary tickers (SOXL, BTC,
 * SKHYNIX), but ambiguous dictionary-word tickers (see
 * AMBIGUOUS_WORD_TICKERS) only match an exact ALL-CAPS token or a "$TICKER"
 * cashtag. Tickers shorter than 2 chars never match — too ambiguous.
 */
export function tickerMatchesTitle(title: string, rawTicker: string): boolean {
  const ticker = rawTicker.toUpperCase();
  if (ticker.length < 2) return false;
  const { cashtag, exact, loose } = tickerRegexes(ticker);
  if (cashtag.test(title)) return true;
  if (AMBIGUOUS_WORD_TICKERS.has(ticker)) return exact.test(title);
  return loose.test(title);
}

function matchTickers(title: string, tickers: readonly string[]): string[] {
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const raw of tickers) {
    const ticker = raw.toUpperCase();
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    if (tickerMatchesTitle(title, ticker)) matched.push(ticker);
  }
  return matched;
}

/**
 * Market-wide macro/economy headlines — central banks, rate decisions,
 * inflation, jobs, tariffs, yields. Mirrors `_MACRO_RE` in
 * `engine/smc/token_events.py` (the Python worker's macro ingestion tag) so
 * both planes agree on what counts as macro news. Word-boundaried so
 * "scalper" doesn't match "CPI" etc. Kept in sync manually — the Python
 * pattern is the source of truth.
 */
const MACRO_RE =
  /\b(fed|fomc|federal reserve|jerome powell|powell|rate (?:decision|hike|cut|hold)s?|interest rate?s?|rate cuts?|rate hikes?|cpi|ppi|pce|inflation|deflation|disinflation|jobs report|nonfarm|non[- ]farm|payrolls?|unemployment|jobless claims|gdp|recession|soft landing|tariffs?|trade war|ecb|european central bank|boj|bank of (?:england|japan)|boe|treasury yields?|bond yields?|10[- ]year yield|quantitative (?:easing|tightening)|qe|qt)\b/i;

/** Scores one headline: which tier it belongs to, and why. */
export function scoreNewsPriority(
  title: string,
  opts: { tickers: readonly string[] },
): NewsPriorityResult {
  const isMacro = MACRO_RE.test(title);
  const matchedTickers = matchTickers(title, opts.tickers);
  const tier: NewsPriorityTier = isMacro ? "macro" : matchedTickers.length > 0 ? "ticker" : "other";
  return { tier, matchedTickers, isMacro };
}

const TIER_ORDER: Record<NewsPriorityTier, number> = { macro: 0, ticker: 1, other: 2 };

/**
 * Stable-sorts `items` so macro/economy news comes first, tracked-ticker
 * mentions come second, and everything else follows — recency (input order)
 * is preserved within each tier. Pure and deterministic: same input always
 * produces the same output order.
 */
export function prioritizeNews<T extends { title: string }>(
  items: readonly T[],
  opts: { tickers: readonly string[] },
): T[] {
  return items
    .map((item, index) => ({ item, index, tier: scoreNewsPriority(item.title, opts).tier }))
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.index - b.index)
    .map((entry) => entry.item);
}
