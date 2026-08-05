import type { MarketOpportunity, SpikeHit } from "./discovery";
import type { IntentAssessment } from "./intent";
import type { NewsItem } from "@/lib/types";

/**
 * "What's worth paying attention to today" — one ranked feed over every
 * attention source the app already computes: engine setups, spike-and-reject
 * flags, the liquidity/activity scan, market-moving news, the macro calendar,
 * and token unlocks.
 *
 * This is a **presentation aggregator**, not an engine layer. It ranks and
 * normalises what other modules already decided; it never scores a market,
 * never emits a direction of its own, and never touches decision or trigger
 * semantics or ENGINE_VERSION. Each card carries its own provenance so a
 * discovery-plane row (spike/liquidity) can never read as a trade signal.
 */

export type AttentionKind = "setup" | "spike" | "liquidity" | "news" | "unlock";

export type AttentionPriority = "high" | "medium" | "low";

export interface AttentionStat {
  label: string;
  value: string;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  priority: AttentionPriority;
  /** Badge text, e.g. "SETUP" / "SPIKE VOL". */
  kindLabel: string;
  /** Token this concerns; null for market-wide macro rows. */
  symbol: string | null;
  /** Headline of the card — the thing that happened / is set up. */
  title: string;
  /** Sub-line under the title. */
  subtitle: string;
  /** 0-100 when the source supplies a score; null when it does not. */
  score: number | null;
  /** What the score means. Never "probability" — these are heuristics. */
  scoreLabel: string | null;
  /** Up to three "why this is here" bullets. */
  reasons: string[];
  /** Up to two labelled figures rendered as boxes. */
  stats: AttentionStat[];
  /** Epoch ms of the event: in the past for news/spikes, ahead for calendar/unlocks. */
  at: number;
  /** True when `at` is in the future — the card shows a countdown, not an age. */
  upcoming: boolean;
  /** Token page to open, when the row is about a token. */
  symbolLink: string | null;
  /** External source URL, when one exists. */
  url: string | null;
}

const PRIORITY_RANK: Record<AttentionPriority, number> = { high: 0, medium: 1, low: 2 };

/**
 * High priority first, then whatever is closest to *now* — an unlock in 2h and
 * a spike 5 minutes old both beat a calendar print three days out.
 */
export function rankAttention(items: AttentionItem[], now = Date.now()): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      Math.abs(a.at - now) - Math.abs(b.at - now) ||
      a.id.localeCompare(b.id),
  );
}

function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function price(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(3)}`;
}

// ── Setups (engine plane) ─────────────────────────────────────────────────

export interface SetupInput {
  ticker: string;
  assessment: IntentAssessment;
  price: number;
}

/**
 * Engine reads. `favored` is the only high-priority verdict — everything else
 * is context, and the card text keeps the not-yet / what-flips-it framing the
 * per-objective verdicts are built on.
 */
export function setupItems(setups: SetupInput[], now = Date.now()): AttentionItem[] {
  return setups.map((s) => {
    const a = s.assessment;
    const stats: AttentionStat[] = [];
    if (a.plan) {
      stats.push({
        label: "Entry Zone",
        value: `${price(a.plan.entryLow)} – ${price(a.plan.entryHigh)}`,
      });
      stats.push({ label: "R:R", value: a.plan.rewardRisk1.toFixed(1) });
    } else {
      stats.push({ label: "Price", value: price(s.price) });
      if (a.anticipatoryPlan) {
        stats.push({ label: "Limit @ POI", value: price(a.anticipatoryPlan.entry) });
      }
    }
    return {
      id: `setup:${s.ticker}:${a.intent}`,
      kind: "setup" as const,
      kindLabel: "Setup",
      priority: a.verdict === "favored" ? "high" : a.verdict === "caution" ? "medium" : "low",
      symbol: s.ticker,
      title: a.headline,
      subtitle: `${a.definition.label} · ${a.verdict}`,
      score: a.confidence,
      scoreLabel: "Confidence",
      reasons: a.triggers.slice(0, 3),
      stats: stats.slice(0, 2),
      at: now,
      upcoming: false,
      symbolLink: s.ticker,
      url: null,
    };
  });
}

// ── Spike-and-reject (discovery plane) ────────────────────────────────────

/** Bars-ago → epoch ms, given the scan's short-TF bar length. */
const SPIKE_BAR_MS = 15 * 60_000;

export function spikeItems(spikes: SpikeHit[], now = Date.now()): AttentionItem[] {
  return spikes.map((s) => ({
    id: `spike:${s.ticker}:${s.spike.time}`,
    kind: "spike" as const,
    kindLabel: "Spike Vol",
    priority: s.spike.barsAgo <= 1 ? ("high" as const) : ("medium" as const),
    symbol: s.ticker,
    title: `${s.spike.direction === "up" ? "Up" : "Down"}-spike rejected`,
    subtitle: "Volatility expansion · discovery flag, not a signal",
    score: null,
    scoreLabel: null,
    reasons: [
      s.spike.reason,
      `Range ${s.spike.rangeMult.toFixed(1)}× normal · volume ${s.spike.volumeMult.toFixed(1)}×`,
      `Rejected ${Math.round(s.spike.rejectionFraction * 100)}% of the bar range`,
    ],
    stats: [
      { label: "Price", value: price(s.price) },
      { label: "Bar Range", value: pct(s.spike.rangePct) },
    ],
    at: now - s.spike.barsAgo * SPIKE_BAR_MS,
    upcoming: false,
    symbolLink: s.ticker,
    url: null,
  }));
}

// ── Liquidity / activity scan (discovery plane) ───────────────────────────

export function liquidityItems(rows: MarketOpportunity[], now = Date.now()): AttentionItem[] {
  return rows.map((o) => ({
    id: `liquidity:${o.ticker}`,
    kind: "liquidity" as const,
    kindLabel: "Liquidity",
    priority: o.score >= 75 ? ("high" as const) : ("medium" as const),
    symbol: o.ticker,
    title: "Active tape",
    subtitle: "Liquidity + range scan · not a trade signal",
    score: Math.round(o.score),
    scoreLabel: "Scan score",
    reasons: [
      o.reason,
      `24h range ${pct(o.rangePercent24h)} · ${o.change24h >= 0 ? "+" : ""}${o.change24h.toFixed(2)}%`,
      `${o.trades24h.toLocaleString()} trades in 24h`,
    ],
    stats: [
      { label: "Price", value: price(o.price) },
      { label: "24h Volume", value: compactUsd(o.quoteVolume24h) },
    ],
    at: now,
    upcoming: false,
    symbolLink: o.ticker,
    url: null,
  }));
}

// ── News (news plane) ─────────────────────────────────────────────────────

export function newsItems(rows: NewsItem[], now = Date.now()): AttentionItem[] {
  return rows.map((n) => ({
    id: `news:${n.id}`,
    kind: "news" as const,
    kindLabel: "News",
    priority:
      n.impact === "high"
        ? ("high" as const)
        : n.impact === "medium"
          ? ("medium" as const)
          : ("low" as const),
    symbol: n.assets[0] ?? null,
    title: n.headline,
    subtitle: `${n.source} · ${n.direction}`,
    score: null,
    scoreLabel: null,
    reasons: [
      n.summary ?? `${n.impact} expected impact`,
      n.assets.length ? `Affects ${n.assets.slice(0, 4).join(", ")}` : "Market-wide",
    ].filter(Boolean),
    stats: [
      { label: "Impact", value: n.impact },
      { label: "Direction", value: n.direction },
    ],
    at: now - n.minutesAgo * 60_000,
    upcoming: false,
    symbolLink: n.assets[0] ?? null,
    url: null,
  }));
}

// ── Macro calendar (news plane, forward-looking) ──────────────────────────

export interface CalendarInput {
  id: string;
  title: string;
  country: string;
  impact: "high" | "medium" | "low" | "holiday";
  forecast: string | null;
  previous: string | null;
  occursAt: string;
}

export function calendarItems(rows: CalendarInput[]): AttentionItem[] {
  return rows.map((e) => ({
    id: `calendar:${e.id}`,
    kind: "news" as const,
    kindLabel: "Upcoming News",
    priority:
      e.impact === "high"
        ? ("high" as const)
        : e.impact === "medium"
          ? ("medium" as const)
          : ("low" as const),
    symbol: null,
    title: e.title,
    subtitle: `${e.country} · macro event`,
    score: null,
    scoreLabel: null,
    reasons: [
      `${e.impact} impact print — expect a volatility window around the release`,
      e.forecast ? `Forecast ${e.forecast}${e.previous ? ` vs previous ${e.previous}` : ""}` : "",
      "Size down or stand aside through the print",
    ].filter(Boolean),
    stats: [
      { label: "Impact", value: e.impact },
      { label: "Category", value: "Macro" },
    ],
    at: new Date(e.occursAt).getTime(),
    upcoming: true,
    symbolLink: null,
    url: null,
  }));
}

// ── Token unlocks / typed token events ────────────────────────────────────

export interface TokenEventInputRow {
  id: string;
  symbol: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string | null;
  source: string;
  url: string | null;
  publishedAt: string;
}

/**
 * Typed token events. An unlock dated ahead of `now` is a scheduling fact and
 * renders as a countdown; anything already published renders as an age.
 */
export function tokenEventItems(rows: TokenEventInputRow[], now = Date.now()): AttentionItem[] {
  return rows.map((e) => {
    const at = new Date(e.publishedAt).getTime();
    const isUnlock = e.kind === "unlock";
    return {
      id: `token-event:${e.id}`,
      kind: (isUnlock ? "unlock" : "news") as AttentionKind,
      kindLabel: isUnlock ? "Unlock" : e.kind,
      priority:
        e.severity === "critical"
          ? ("high" as const)
          : e.severity === "warning"
            ? ("medium" as const)
            : ("low" as const),
      symbol: e.symbol,
      title: e.title,
      subtitle: `${isUnlock ? "Token unlock" : e.kind} · ${e.source}`,
      score: null,
      scoreLabel: null,
      reasons: [
        e.body ?? "",
        isUnlock ? "Supply hitting the market can add sell pressure" : "",
        isUnlock ? "Watch on-chain flow around the release" : "",
      ].filter(Boolean),
      stats: [
        { label: "Severity", value: e.severity },
        { label: "Source", value: e.source },
      ],
      at,
      upcoming: at > now,
      symbolLink: e.symbol,
      url: e.url,
    };
  });
}

/** Every card whose kind matches the active filter (`"all"` keeps them all). */
export function filterAttention(
  items: AttentionItem[],
  kind: AttentionKind | "all",
): AttentionItem[] {
  return kind === "all" ? items : items.filter((i) => i.kind === kind);
}
