/**
 * Chart event overlay (quick-action) — normalizes the two already-ingested
 * event families into ONE time-anchored, sentiment-toned list that the token
 * price chart plots as clickable markers and the strip below renders as chips:
 *
 *   - PAST news  → typed token_event rows (unlocks, security, listings…),
 *                  fetched via useTokenEvents.
 *   - UPCOMING   → catalyst_event calendar rows (unlocks, listings ahead),
 *                  fetched via useExternalContext (.upcoming / .marketEvents).
 *
 * Pure and fixture-testable: the hooks fetch, this file decides tone, order,
 * labels and where each event anchors on the time axis. Sentiment is a per-kind
 * traffic light (red / grey / green); an unlock is coloured red (supply
 * pressure) — a deliberate product call for this visual, distinct from the
 * prompt-layer rule that treats an unlock's SIZE as a scheduling fact.
 */

export type EventTone = "bearish" | "neutral" | "bullish";
export type EventWhen = "past" | "upcoming";

export interface ChartEvent {
  /** Stable key: the row id when available, else composed from its fields. */
  id: string;
  /** Unix SECONDS — publishedAt for past news, occursAt for upcoming calendar. */
  timeSec: number;
  when: EventWhen;
  tone: EventTone;
  kind: string;
  title: string;
  source: string;
  url: string | null;
}

/** Minimal shape of a past token event (see useTokenEvents' TokenEvent). */
export interface PastEventLike {
  id?: string | null;
  kind: string;
  title: string;
  source: string;
  url: string | null;
  publishedAt: string;
}

/** Minimal shape of an upcoming catalyst (see UpcomingCatalystItem). */
export interface UpcomingEventLike {
  kind: string;
  title: string;
  source: string;
  url: string | null;
  occursAt: string;
}

// Per-kind traffic light. Covers both token_event kinds (security, delisting,
// regulatory, unlock, listing, upgrade) and catalyst-only kinds (fork, burn).
const TONE_BY_KIND: Record<string, EventTone> = {
  security: "bearish",
  delisting: "bearish",
  regulatory: "bearish",
  unlock: "bearish", // product call: an unlock reads as supply pressure here
  listing: "bullish",
  upgrade: "bullish",
  burn: "bullish", // deflationary supply reduction
  fork: "neutral",
  other: "neutral",
};

export function toneForKind(kind: string): EventTone {
  return TONE_BY_KIND[kind.toLowerCase()] ?? "neutral";
}

/** Marker/dot colours, matching the chart's raw-hex palette. */
export const TONE_HEX: Record<EventTone, string> = {
  bearish: "#ef4444",
  neutral: "#9ca3af",
  bullish: "#22c55e",
};

const KIND_LABEL: Record<string, string> = {
  unlock: "Unlock",
  security: "Security",
  regulatory: "Regulatory",
  delisting: "Delisting",
  listing: "Listing",
  upgrade: "Upgrade",
  fork: "Fork",
  burn: "Burn",
  other: "Event",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind.toLowerCase()] ?? "Event";
}

/**
 * Merge both families into one time-sorted list. Rows with an unparseable
 * timestamp drop. An `upcoming` row already in the past (clock skew, or one
 * that just fired) is demoted to `past` so it anchors to a real candle rather
 * than pinning to "now". De-dup is by id — a calendar echo of an item already
 * present as past news loses to the past copy (inserted first).
 */
export function buildChartEvents(
  past: readonly PastEventLike[],
  upcoming: readonly UpcomingEventLike[],
  nowMs = Date.now(),
): ChartEvent[] {
  const out: ChartEvent[] = [];
  for (const e of past) {
    const ms = Date.parse(e.publishedAt);
    if (!Number.isFinite(ms)) continue;
    out.push({
      id: e.id ?? `past:${e.source}:${e.kind}:${ms}`,
      timeSec: Math.floor(ms / 1000),
      when: "past",
      tone: toneForKind(e.kind),
      kind: e.kind,
      title: e.title,
      source: e.source,
      url: e.url,
    });
  }
  for (const e of upcoming) {
    const ms = Date.parse(e.occursAt);
    if (!Number.isFinite(ms)) continue;
    out.push({
      id: `upcoming:${e.source}:${e.kind}:${ms}`,
      timeSec: Math.floor(ms / 1000),
      when: ms < nowMs ? "past" : "upcoming",
      tone: toneForKind(e.kind),
      kind: e.kind,
      title: e.title,
      source: e.source,
      url: e.url,
    });
  }
  const seen = new Set<string>();
  const deduped = out.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return deduped.sort((a, b) => a.timeSec - b.timeSec);
}

/** "in 3d" / "in 5h" ahead, "2d ago" / "3h ago" behind — coarse and glanceable. */
export function whenLabel(timeSec: number, nowMs = Date.now()): string {
  const deltaMin = Math.round((timeSec * 1000 - nowMs) / 60_000);
  const future = deltaMin >= 0;
  const mins = Math.abs(deltaMin);
  let mag: string;
  if (mins < 60) mag = `${Math.max(1, mins)}m`;
  else if (mins < 60 * 48) mag = `${Math.round(mins / 60)}h`;
  else mag = `${Math.round(mins / 1440)}d`;
  return future ? `in ${mag}` : `${mag} ago`;
}

/**
 * Nearest candle time at-or-before `timeSec`, from an ASCENDING array of candle
 * times (unix seconds). Lightweight-charts only renders a marker whose time is
 * an actual data point, so every event is snapped to the bar that contains it.
 * Returns null when the event predates all loaded bars (no home bar → it can't
 * be plotted, and the strip carries it instead). Binary search — this runs on
 * every candle/evaluation change.
 */
export function snapToCandle(candleTimesSec: readonly number[], timeSec: number): number | null {
  if (candleTimesSec.length === 0) return null;
  if (timeSec < candleTimesSec[0]) return null;
  let lo = 0;
  let hi = candleTimesSec.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candleTimesSec[mid] <= timeSec) lo = mid;
    else hi = mid - 1;
  }
  return candleTimesSec[lo];
}
