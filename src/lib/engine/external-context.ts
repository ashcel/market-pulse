// External market context — pure types + normalizers shared by the worker
// ingester, the server-side assembler, the API payload, and the client hook.
// Framework-free and network-free so every transform is fixture-testable.
//
// This is the news/context plane, NOT the signal engine: nothing here feeds
// `EvaluateInput` or any deterministic verdict path (ENGINE_VERSION untouched).
// The assembled context is secondary evidence for the AI analyst prompt only.

/** Normalized CoinGecko `/global` poll — one persisted breadth snapshot. */
export interface MarketContextSnapshotInput {
  totalMcapUsd: number;
  btcDominance: number;
  ethDominance: number | null;
  mcapChange24hPct: number | null;
  source: string;
}

/**
 * Parse a CoinGecko `/global` response body into a snapshot input.
 * Returns null when the payload doesn't carry the fields we need — a schema
 * drift upstream must surface as an ingest error, never as a NaN row.
 */
export function normalizeCoinGeckoGlobal(payload: unknown): MarketContextSnapshotInput | null {
  const data = (payload as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const mcap = (data.total_market_cap as Record<string, unknown> | undefined)?.usd;
  const pct = data.market_cap_percentage as Record<string, unknown> | undefined;
  const btc = pct?.btc;
  if (typeof mcap !== "number" || !Number.isFinite(mcap) || mcap <= 0) return null;
  if (typeof btc !== "number" || !Number.isFinite(btc) || btc <= 0) return null;
  const eth = pct?.eth;
  const change = data.market_cap_change_percentage_24h_usd;
  return {
    totalMcapUsd: mcap,
    btcDominance: btc,
    ethDominance: typeof eth === "number" && Number.isFinite(eth) ? eth : null,
    mcapChange24hPct: typeof change === "number" && Number.isFinite(change) ? change : null,
    source: "coingecko",
  };
}

// ── Assembled context (the /api/external-context payload) ───────────────────

/** Provenance + freshness stamp carried by every populated section. */
export interface ContextProvenance {
  source: string;
  /** When the underlying data was fetched/computed (ISO). */
  asOf: string;
  /** Older than the section's freshness threshold — usable, but must be labeled. */
  stale: boolean;
}

/**
 * Why a section is absent or suspect. `missing` is an expected gap (e.g. an
 * out-of-universe symbol has no relative read); `unconfigured` means no API
 * key; `error` means a configured pipeline failed and should alarm.
 */
export interface SectionStatus {
  section: "breadth" | "relative" | "recentCatalysts" | "recentHighImpact" | "upcoming" | "social";
  status: "ok" | "stale" | "missing" | "unconfigured" | "error";
  reason?: string;
  asOf?: string;
}

/** Market-wide backdrop: is the tape risk-on, and is money in or out of BTC? */
export interface BreadthContext {
  /** e.g. "Risk On" — the snapshot's BTC-daily regime read; null when only the provider row is available. */
  btcRegime: string | null;
  btcChange24hPct: number | null;
  btcDominancePct: number | null;
  btcDominanceDelta24hPp: number | null; // percentage-point change vs ~24h ago
  totalMcapUsd: number | null;
  mcapChange24hPct: number | null;
  fearGreed: number | null;
  fearGreedLabel: string | null;
  provenance: ContextProvenance;
}

/** Viewed asset vs BTC: is this move the asset's own, or just the market's? */
export interface RelativeContext {
  rsBtc24hPp: number;
  rsBtc7dPp: number;
  corrBtc7d: number | null;
  /** Asset/BTC price ratio from {ASSET}USDT / BTCUSDT closes. */
  ratio: number | null;
  ratioChange7dPct: number | null;
  provenance: ContextProvenance;
}

/** One recent confirmed event (token_event row projected for the context payload). */
export interface ContextEventItem {
  kind: string;
  severity: string;
  title: string;
  source: string;
  url: string | null;
  publishedAt: string;
}

/** One upcoming calendar catalyst (catalyst_event row projection). */
export interface UpcomingCatalystItem {
  symbol: string;
  kind: string;
  title: string;
  occursAt: string;
  source: string;
  url: string | null;
  /** null = size unknown (free-tier norm) — a scheduling fact, not a supply-pressure signal. */
  percentOfSupply: number | null;
  votes: number | null;
  confidencePct: number | null;
}

export interface ExternalContext {
  symbol: string;
  assembledAt: string;
  breadth: BreadthContext | null;
  relative: RelativeContext | null;
  /** ≤48h back — plausible contributors to the current move. */
  recentCatalysts: ContextEventItem[] | null;
  /** ≤7d back, severity-gated — standing high-impact context. */
  recentHighImpact: ContextEventItem[] | null;
  /** ≤7d ahead for this symbol. */
  upcoming: UpcomingCatalystItem[] | null;
  /** ≤7d ahead, market-wide (BTC/ETH/MARKET). */
  marketEvents: UpcomingCatalystItem[] | null;
  /** Reserved slot — LunarCrush integration deferred until limits verified. */
  social: null;
  /** Always present: per-section status, so degradation is observable, not silent. */
  degradation: SectionStatus[];
}

// ── Freshness thresholds (shared by service + health view) ──────────────────

export const BREADTH_STALE_MS = 60 * 60_000; // global snapshot older than 1h
export const CALENDAR_STALE_MS = 12 * 60 * 60_000; // calendar last-ok older than 12h
export const RSS_STALE_MS = 60 * 60_000;

export function fearGreedLabel(value: number): string {
  if (value >= 75) return "Extreme Greed";
  if (value >= 55) return "Greed";
  if (value > 45) return "Neutral";
  if (value > 25) return "Fear";
  return "Extreme Fear";
}
