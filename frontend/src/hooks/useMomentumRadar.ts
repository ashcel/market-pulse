import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live MARKET-EVENT RADAR feed for `/discover`.
 *
 * Subscribes to the server-sent stream (`/api/momentum/stream`) so the page
 * behaves like a radar rather than a refresh loop, with a one-shot snapshot
 * fetch for first paint and an automatic fall back to polling if the stream
 * cannot be established (proxy in the way, connection budget exhausted).
 *
 * The payload is deliberately two-layered, mirroring the backend:
 *
 * - **durable** — the situation: its lifecycle state, the event behind it, the
 *   higher-timeframe context, what is developing (pullback → completion) and
 *   the structural path. Safe to render large; these move on the order of
 *   minutes.
 * - **telemetry** — raw realtime flow, including the twitchy pressure phrases.
 *   Rendered small, never as a headline.
 *
 * This is an observation layer: nothing here is a trade signal, and an
 * "aligned" or "counter-trend" classification is a description, not advice.
 */

export type ScanMode = "SCALP" | "INTRADAY";

/** The situation lifecycle the UI groups by. Server-side these are monotone,
 * dwell-gated and hysteretic — they do not move on relative-volume noise. */
export type RadarState =
  | "NEW"
  | "DEVELOPING"
  | "PULLBACK"
  | "PULLBACK_COMPLETION"
  | "CONTINUATION_CANDIDATE"
  | "INVALID"
  | "STALE";
export type RadarDirection = "bullish" | "bearish";
export type ContextBias = "bullish" | "bearish" | "neutral" | "mixed";
export type AlignmentLevel = "HIGH" | "MODERATE" | "COUNTER_TREND" | "MIXED" | "UNKNOWN";
export type AlignmentClass = "aligned" | "counter_trend" | "mixed" | "unclassified";
/** Evidence quality. Derived from how many *independent* families of event
 * agree — never from one extreme reading. */
export type QualityTier = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export type RadarEventType =
  | "VOLUME_ANOMALY"
  | "PRICE_DISPLACEMENT"
  | "VOLATILITY_EXPANSION"
  | "TRADE_RATE_EXPANSION"
  | "CHOCH"
  | "STRUCTURE_BREAK"
  | "PULLBACK"
  | "CONTINUATION"
  | "VOLUME_COOLING"
  | "INVALIDATION";

/** Mirrors `app.momentum.schemas.EventResponse`. */
export interface RadarEvent {
  type: RadarEventType;
  direction: RadarDirection | null;
  /** Mint time — what "detected Ns ago" counts from. Never advances. */
  ts: number;
  lastSeenTs: number;
  magnitude: number;
  peakMagnitude: number;
  /** "x" (multiple of baseline), "%", "price" or "1m". */
  unit: string;
  score: number;
  /** Short untranslated token, e.g. "HH"/"LL" on a structure break. */
  qualifier: string;
  /** Whether the condition behind it still holds right now. */
  active: boolean;
  ageSeconds: number;
}

/** Mirrors `app.momentum.schemas.TelemetryResponse` — secondary by design. */
export interface RadarTelemetry {
  pressure: string;
  change1mPct: number | null;
  change3mPct: number | null;
  change5mPct: number | null;
  change15mPct: number | null;
  change24hPct: number;
  rvol1m: number | null;
  rvol3m: number | null;
  rvol5m: number | null;
  tradeRateMult: number | null;
  rangeExpansion: number | null;
  quoteVolume1m: number;
  quoteVolume24h: number;
  trades1m: number;
}

export interface TimeframeRead {
  timeframe: string;
  bias: "bullish" | "bearish" | "neutral";
  trend: string;
  event: string | null;
  eventLabel: string | null;
  changePct: number;
  bars: number;
  computedAt: number;
}

/** Cached 4H/1H/15m/5m read. Updates on the slow lane's timers, not on ticks. */
export interface RadarContext {
  bias: ContextBias;
  agreement: number;
  score: number;
  reads: TimeframeRead[];
  updatedAt: number;
  biasSince: number;
}

export interface RadarAlignment {
  level: AlignmentLevel;
  classification: AlignmentClass;
  agreement: number;
  contextBias: string;
  eventDirection: RadarDirection | null;
}

/** A price the market has already reacted to. */
export interface StructuralLevel {
  price: number;
  kind: string;
  timeframe: string;
  touches: number;
}

/** Measurements of the current retracement — never verdicts. */
export interface PullbackRead {
  state: string;
  retraceFrac: number;
  retracePct: number;
  durationSeconds: number;
  volumeRatio: number | null;
  opposingMovePct: number;
  structureIntact: boolean;
  isHealthy: boolean;
  atLevel: StructuralLevel | null;
}

export interface CompletionEvidence {
  code: string;
  met: boolean;
  detail: string;
}

/** Evidence that the pullback may be ending — a checklist, not a score. */
export interface CompletionRead {
  state: string;
  metCount: number;
  hasTrigger: boolean;
  evidence: CompletionEvidence[];
}

export interface RadarTarget {
  level: StructuralLevel;
  distancePct: number;
}

/** The structural path that would be in play. Never an order. */
export interface StructuralPath {
  entry: number;
  invalidation: number;
  target: number;
  targetKind: string;
  riskPct: number;
  rewardPct: number;
  rr: number;
  verdict: string;
}

/** Slow structural context (reaccumulation) at the time of the read.
 * Display + forward-test evidence only — it gates nothing. */
export interface StructuralBacking {
  state: string;
  score: number;
  side: string;
  detectedAt: number;
}

/** Mirrors `app.momentum.schemas.RadarEntryResponse`. */
export interface RadarEntry {
  symbol: string;
  state: RadarState;
  mode: ScanMode;
  direction: RadarDirection | null;
  score: number;
  headline: RadarEvent | null;
  events: RadarEvent[];
  timeline: RadarEvent[];
  /** Evidence quality, the named relationship behind it, and the independent
   * families that contributed. */
  tier: QualityTier;
  combo: string;
  families: string[];
  structural: StructuralBacking | null;
  telemetry: RadarTelemetry;
  context: RadarContext | null;
  alignment: RadarAlignment;
  pullback: PullbackRead | null;
  completion: CompletionRead | null;
  targets: RadarTarget[];
  path: StructuralPath | null;
  worthWatching: boolean;
  /** Why this passed (or failed) the funnel — codes, not sentences. */
  reasons: string[];
  firstSeen: number;
  stateSince: number;
  updatedAt: number;
}

/** How many candidates survived each stage of the last sweep. Shipped so an
 * empty radar can be explained rather than merely observed. */
export interface FunnelCounts {
  universe: number;
  tracked: number;
  events: number;
  /** Events that form a real relationship — not lone observations. */
  qualified: number;
  directional: number;
  structural: number;
  developing: number;
  surfaced: number;
}

export interface MomentumRadar {
  updatedAt: number;
  mode: ScanMode;
  version: string;
  eventsVersion: string;
  contextVersion: string;
  journalVersion: string;
  universeSize: number;
  tracked: number;
  /** True while the backend's market feed is delivering. */
  connected: boolean;
  /** Which transport the backend settled on: "ws", "rest" or "starting". */
  feed: string;
  /** True until enough history exists for the working windows. */
  warmingUp: boolean;
  funnel: FunnelCounts;
  /** The surfaced situations, ranked. Often short — sometimes empty. */
  situations: RadarEntry[];
  closed: RadarEntry[];
  counts: Record<string, number>;
}

interface RawEvent {
  type: string;
  direction: string | null;
  ts: number;
  last_seen_ts: number;
  magnitude: number;
  peak_magnitude: number;
  unit: string;
  score: number;
  qualifier: string;
  active: boolean;
  age_seconds: number;
}

interface RawLevel {
  price: number;
  kind: string;
  timeframe: string;
  touches: number;
}

interface RawEntry {
  symbol: string;
  state: string;
  mode: string;
  direction: string | null;
  score: number;
  headline: RawEvent | null;
  events: RawEvent[];
  timeline: RawEvent[];
  tier: string;
  combo: string;
  families: string[];
  structural: { state: string; score: number; side: string; detected_at: number } | null;
  telemetry: Record<string, number | string | null>;
  context: RawContext | null;
  alignment: {
    level: string;
    classification: string;
    agreement: number;
    context_bias: string;
    event_direction: string | null;
  };
  pullback: {
    state: string;
    retrace_frac: number;
    retrace_pct: number;
    duration_seconds: number;
    volume_ratio: number | null;
    opposing_move_pct: number;
    structure_intact: boolean;
    is_healthy: boolean;
    at_level: RawLevel | null;
  } | null;
  completion: {
    state: string;
    met_count: number;
    has_trigger: boolean;
    evidence: { code: string; met: boolean; detail: string }[];
  } | null;
  targets: { level: RawLevel; distance_pct: number }[];
  path: {
    entry: number;
    invalidation: number;
    target: number;
    target_kind: string;
    risk_pct: number;
    reward_pct: number;
    rr: number;
    verdict: string;
  } | null;
  worth_watching: boolean;
  reasons: string[];
  first_seen: number;
  state_since: number;
  updated_at: number;
}

interface RawContext {
  bias: string;
  agreement: number;
  score: number;
  reads: {
    timeframe: string;
    bias: string;
    trend: string;
    event: string | null;
    event_label: string | null;
    change_pct: number;
    bars: number;
    computed_at: number;
  }[];
  updated_at: number;
  bias_since: number;
}

interface RawRadar {
  updated_at: number;
  mode: string;
  version: string;
  events_version: string;
  context_version: string;
  journal_version: string;
  universe_size: number;
  tracked: number;
  connected: boolean;
  feed: string;
  warming_up: boolean;
  funnel: FunnelCounts;
  situations: RawEntry[];
  closed: RawEntry[];
  counts: Record<string, number>;
}

function fromRawEvent(row: RawEvent): RadarEvent {
  return {
    type: row.type as RadarEventType,
    direction: row.direction as RadarDirection | null,
    ts: row.ts,
    lastSeenTs: row.last_seen_ts,
    magnitude: row.magnitude,
    peakMagnitude: row.peak_magnitude,
    unit: row.unit,
    score: row.score,
    qualifier: row.qualifier ?? "",
    active: row.active,
    ageSeconds: row.age_seconds,
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function fromRawContext(row: RawContext | null): RadarContext | null {
  if (row === null) return null;
  return {
    bias: row.bias as ContextBias,
    agreement: row.agreement,
    score: row.score,
    reads: (row.reads ?? []).map((read) => ({
      timeframe: read.timeframe,
      bias: read.bias as TimeframeRead["bias"],
      trend: read.trend,
      event: read.event,
      eventLabel: read.event_label,
      changePct: read.change_pct,
      bars: read.bars,
      computedAt: read.computed_at,
    })),
    updatedAt: row.updated_at,
    biasSince: row.bias_since,
  };
}

function fromRawLevel(level: RawLevel): StructuralLevel {
  return {
    price: level.price,
    kind: level.kind,
    timeframe: level.timeframe,
    touches: level.touches,
  };
}

function fromRawEntry(row: RawEntry): RadarEntry {
  const t = row.telemetry ?? {};
  return {
    symbol: row.symbol,
    state: row.state as RadarState,
    mode: (row.mode ?? "SCALP") as ScanMode,
    direction: row.direction as RadarDirection | null,
    score: row.score,
    headline: row.headline ? fromRawEvent(row.headline) : null,
    tier: (row.tier ?? "NONE") as QualityTier,
    combo: row.combo ?? "",
    families: row.families ?? [],
    structural: row.structural
      ? {
          state: row.structural.state,
          score: row.structural.score,
          side: row.structural.side,
          detectedAt: row.structural.detected_at,
        }
      : null,
    events: (row.events ?? []).map(fromRawEvent),
    timeline: (row.timeline ?? []).map(fromRawEvent),
    telemetry: {
      pressure: typeof t.pressure === "string" ? t.pressure : "",
      change1mPct: num(t.change_1m_pct),
      change3mPct: num(t.change_3m_pct),
      change5mPct: num(t.change_5m_pct),
      change15mPct: num(t.change_15m_pct),
      change24hPct: num(t.change_24h_pct) ?? 0,
      rvol1m: num(t.rvol_1m),
      rvol3m: num(t.rvol_3m),
      rvol5m: num(t.rvol_5m),
      tradeRateMult: num(t.trade_rate_mult),
      rangeExpansion: num(t.range_expansion),
      quoteVolume1m: num(t.quote_volume_1m) ?? 0,
      quoteVolume24h: num(t.quote_volume_24h) ?? 0,
      trades1m: num(t.trades_1m) ?? 0,
    },
    context: fromRawContext(row.context),
    alignment: {
      level: (row.alignment?.level ?? "UNKNOWN") as AlignmentLevel,
      classification: (row.alignment?.classification ?? "unclassified") as AlignmentClass,
      agreement: row.alignment?.agreement ?? 0,
      contextBias: row.alignment?.context_bias ?? "unknown",
      eventDirection: (row.alignment?.event_direction ?? null) as RadarDirection | null,
    },
    pullback: row.pullback
      ? {
          state: row.pullback.state,
          retraceFrac: row.pullback.retrace_frac,
          retracePct: row.pullback.retrace_pct,
          durationSeconds: row.pullback.duration_seconds,
          volumeRatio: row.pullback.volume_ratio,
          opposingMovePct: row.pullback.opposing_move_pct,
          structureIntact: row.pullback.structure_intact,
          isHealthy: row.pullback.is_healthy,
          atLevel: row.pullback.at_level ? fromRawLevel(row.pullback.at_level) : null,
        }
      : null,
    completion: row.completion
      ? {
          state: row.completion.state,
          metCount: row.completion.met_count,
          hasTrigger: row.completion.has_trigger,
          evidence: (row.completion.evidence ?? []).map((item) => ({
            code: item.code,
            met: item.met,
            detail: item.detail,
          })),
        }
      : null,
    targets: (row.targets ?? []).map((target) => ({
      level: fromRawLevel(target.level),
      distancePct: target.distance_pct,
    })),
    path: row.path
      ? {
          entry: row.path.entry,
          invalidation: row.path.invalidation,
          target: row.path.target,
          targetKind: row.path.target_kind,
          riskPct: row.path.risk_pct,
          rewardPct: row.path.reward_pct,
          rr: row.path.rr,
          verdict: row.path.verdict,
        }
      : null,
    worthWatching: row.worth_watching ?? false,
    reasons: row.reasons ?? [],
    firstSeen: row.first_seen,
    stateSince: row.state_since,
    updatedAt: row.updated_at,
  };
}

const EMPTY_FUNNEL: FunnelCounts = {
  universe: 0,
  tracked: 0,
  events: 0,
  qualified: 0,
  directional: 0,
  structural: 0,
  developing: 0,
  surfaced: 0,
};

function fromRaw(body: RawRadar): MomentumRadar {
  return {
    updatedAt: body.updated_at,
    mode: (body.mode ?? "SCALP") as ScanMode,
    version: body.version,
    eventsVersion: body.events_version ?? "",
    contextVersion: body.context_version ?? "",
    journalVersion: body.journal_version ?? "",
    universeSize: body.universe_size,
    tracked: body.tracked,
    connected: body.connected,
    feed: body.feed ?? "starting",
    warmingUp: body.warming_up,
    funnel: body.funnel ?? EMPTY_FUNNEL,
    situations: (body.situations ?? []).map(fromRawEntry),
    closed: (body.closed ?? []).map(fromRawEntry),
    counts: body.counts ?? {},
  };
}

/** Poll cadence used only when the SSE stream is unavailable. */
const FALLBACK_POLL_MS = 4_000;
/** Give the stream this long to deliver a first frame before polling. */
const STREAM_GRACE_MS = 8_000;

export interface MomentumRadarResult {
  data: MomentumRadar | null;
  /** True until the first frame (stream or snapshot) arrives. */
  loading: boolean;
  /** True while the live stream is delivering; false means polling fallback. */
  live: boolean;
}

export function useMomentumRadar(mode: ScanMode = "SCALP"): MomentumRadarResult {
  const [data, setData] = useState<MomentumRadar | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  // Read inside timers/handlers that must not re-subscribe when it changes.
  const gotFrame = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const apply = (body: RawRadar) => {
      if (cancelled) return;
      gotFrame.current = true;
      setData(fromRaw(body));
      setLoading(false);
    };

    const snapshot = async () => {
      try {
        const res = await fetch(`/api/momentum/scan?mode=${mode}`);
        if (!res.ok) return;
        const body = (await res.json()) as { data: RawRadar };
        if (body?.data) apply(body.data);
      } catch {
        // A failed snapshot is not fatal — the stream may still connect.
      }
    };

    const startPolling = () => {
      if (poll !== null || cancelled) return;
      setLive(false);
      poll = setInterval(snapshot, FALLBACK_POLL_MS);
    };

    const stopPolling = () => {
      if (poll === null) return;
      clearInterval(poll);
      poll = null;
    };

    void snapshot();

    const source = new EventSource(`/api/momentum/stream?mode=${mode}`);
    source.addEventListener("radar", (event) => {
      stopPolling();
      setLive(true);
      try {
        apply(JSON.parse((event as MessageEvent<string>).data) as RawRadar);
      } catch {
        // Ignore a malformed frame; the next one is two seconds away.
      }
    });
    source.addEventListener("error", () => {
      // EventSource retries on its own; polling covers the gap meanwhile and
      // is cancelled again as soon as a frame lands.
      startPolling();
    });

    // If the stream never produces a frame (a proxy silently swallowing
    // text/event-stream, say), fall back rather than showing a dead radar.
    const grace = setTimeout(() => {
      if (!gotFrame.current || !live) startPolling();
    }, STREAM_GRACE_MS);

    return () => {
      cancelled = true;
      clearTimeout(grace);
      stopPolling();
      source.close();
    };
    // Re-subscribe only when the mode changes: the stream is the page's
    // lifetime connection, not a per-render effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return { data, loading, live };
}

export interface RadarTimeline {
  symbol: string;
  state: RadarState | null;
  direction: RadarDirection | null;
  score: number;
  context: RadarContext | null;
  alignment: RadarAlignment | null;
  events: RadarEvent[];
}

/**
 * One symbol's full event sequence plus its higher-timeframe context.
 *
 * Fetched on demand (when a card is expanded) rather than shipped with every
 * radar frame: the stream carries only the last few events per card, and the
 * whole sequence is only interesting for the one symbol being looked at.
 */
export function useMomentumTimeline(
  symbol: string | null,
  mode: ScanMode = "SCALP",
): {
  data: RadarTimeline | null;
  loading: boolean;
} {
  const [data, setData] = useState<RadarTimeline | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (ticker: string, signal: AbortSignal) => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/momentum/timeline/${encodeURIComponent(ticker)}?mode=${mode}`,
          { signal },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          data: {
            symbol: string;
            state: string | null;
            direction: string | null;
            score: number;
            context: RawContext | null;
            alignment: RawEntry["alignment"] | null;
            events: RawEvent[];
          };
        };
        if (signal.aborted || !body?.data) return;
        setData({
          symbol: body.data.symbol,
          state: body.data.state as RadarState | null,
          direction: body.data.direction as RadarDirection | null,
          score: body.data.score,
          context: fromRawContext(body.data.context),
          alignment: body.data.alignment
            ? {
                level: body.data.alignment.level as AlignmentLevel,
                classification: body.data.alignment.classification as AlignmentClass,
                agreement: body.data.alignment.agreement,
                contextBias: body.data.alignment.context_bias,
                eventDirection: body.data.alignment.event_direction as RadarDirection | null,
              }
            : null,
          events: (body.data.events ?? []).map(fromRawEvent),
        });
      } catch {
        // Aborted or offline — the card keeps its inline tail either way.
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [mode],
  );

  useEffect(() => {
    if (symbol === null) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    void load(symbol, controller.signal);
    // Refresh while open: the sequence grows as new events land.
    const id = setInterval(() => void load(symbol, controller.signal), 5_000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [symbol, load]);

  return { data, loading };
}
