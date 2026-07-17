import { createServerFn } from "@tanstack/react-start";

import type { Direction, Impact, NewsItem } from "../types";
import { news as sampleNews } from "../mock/news";
import { UNIVERSE } from "./market";

const FEED_URL = "https://cointelegraph.com/rss";
const NEWS_TTL_MS = 5 * 60_000;
const MAX_ITEMS = 24;

const BULLISH_WORDS =
  /\b(surge|soar|rall(?:y|ies)|record|all-time high|ath|gain|jump|approv|adopt|inflow|accumulat|breakout|bull|buy|upgrade|partner|launch|integrat)\w*/i;
const BEARISH_WORDS =
  /\b(crash|plunge|drop|dump|hack|exploit|ban|sell-off|selloff|outflow|lawsuit|sue|fall|fear|liquidat|bear|warn|fraud|scam|shutdown|delay|reject)\w*/i;
const HIGH_IMPACT_WORDS =
  /\b(sec|etf|fed|fomc|rate|regulat|treasury|blackrock|halving|hack|exploit|lawsuit|bankrupt|billion)\w*/i;

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tagContent(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? stripCdata(match[1].trim()).trim() : null;
}

function detectAssets(text: string): string[] {
  const found: string[] = [];
  for (const entry of UNIVERSE) {
    const pattern = new RegExp(
      `\\b(${entry.ticker}|${entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`,
      "i",
    );
    if (pattern.test(text)) found.push(entry.ticker);
    if (found.length >= 4) break;
  }
  return found.length > 0 ? found : ["Crypto"];
}

function detectDirection(text: string): Direction {
  const bullish = BULLISH_WORDS.test(text);
  const bearish = BEARISH_WORDS.test(text);
  if (bullish && !bearish) return "bullish";
  if (bearish && !bullish) return "bearish";
  return "neutral";
}

function detectImpact(text: string, assets: string[]): Impact {
  const major = assets.includes("BTC") || assets.includes("ETH");
  const strong = HIGH_IMPACT_WORDS.test(text);
  if (strong && major) return "high";
  if (strong || major) return "medium";
  return "low";
}

/** One raw `<item>` from any RSS feed — the shared shape news + token events parse from. */
export interface RssItemRaw {
  headline: string;
  description: string;
  url: string | null;
  guid: string | null;
  /** Epoch ms from pubDate; null when absent/unparseable. */
  publishedAtMs: number | null;
}

/** Feed-agnostic RSS item extraction (title/description/link/guid/pubDate). */
export function parseRssItems(xml: string): RssItemRaw[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const parsed: RssItemRaw[] = [];
  for (const item of items) {
    const title = tagContent(item, "title");
    if (!title) continue;
    const pubDate = tagContent(item, "pubDate");
    const publishedAtMs = pubDate ? Date.parse(pubDate) : NaN;
    parsed.push({
      headline: stripHtml(title),
      description: stripHtml(tagContent(item, "description") ?? ""),
      url: tagContent(item, "link"),
      guid: tagContent(item, "guid"),
      publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : null,
    });
  }
  return parsed;
}

export function parseRssNews(xml: string, now = Date.now()): NewsItem[] {
  return parseRssItems(xml)
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const minutesAgo =
        item.publishedAtMs !== null
          ? Math.max(0, Math.round((now - item.publishedAtMs) / 60_000))
          : 0;
      const text = `${item.headline} ${item.description}`;
      const assets = detectAssets(text);
      return {
        id: item.guid ?? item.url ?? item.headline,
        headline: item.headline,
        impact: detectImpact(text, assets),
        direction: detectDirection(text),
        assets,
        minutesAgo,
        source: "Cointelegraph",
        summary:
          item.description.length > 220
            ? `${item.description.slice(0, 217)}…`
            : item.description || undefined,
      };
    });
}

let newsCache: { at: number; items: NewsItem[] } | null = null;

async function computeNews(): Promise<NewsItem[]> {
  const now = Date.now();
  if (newsCache && now - newsCache.at < NEWS_TTL_MS) return newsCache.items;

  try {
    const response = await fetch(FEED_URL, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "market-pulse/1.0" },
    });
    if (!response.ok) throw new Error(`feed ${response.status}`);
    const items = parseRssNews(await response.text(), now);
    if (items.length === 0) throw new Error("empty feed");
    newsCache = { at: now, items };
    return items;
  } catch {
    // Keep serving the last good fetch if the feed hiccups; sample as last resort.
    return newsCache?.items ?? sampleNews;
  }
}

export const fetchNewsServer = createServerFn({ method: "GET" }).handler(async () => computeNews());

export async function fetchNews(): Promise<NewsItem[]> {
  try {
    return await fetchNewsServer();
  } catch {
    return sampleNews;
  }
}
