import {
  BREADTH_STALE_MS,
  CALENDAR_STALE_MS,
  RSS_STALE_MS,
  fearGreedLabel,
  type BreadthContext,
  type ExternalContext,
  type SectionStatus,
} from "@/lib/engine/external-context";
import { computeSnapshot } from "@/lib/engine/market";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import {
  latestMarketContextSnapshot,
  listIngestState,
  marketContextSnapshotNear,
  type IngestStateRow,
} from "../db/repo";

/**
 * Assemble the external-context payload for one symbol — the read model behind
 * /api/external-context. Everything here is DB reads plus the web process's
 * own in-memory market snapshot cache: NO provider fetch ever happens on the
 * request path (providers are polled by the worker's context pass).
 *
 * Every section is independently nullable and independently degradable: a dead
 * DB, a stale snapshot, or an unconfigured provider each surface in
 * `degradation` (and the health view) while the rest of the payload — and the
 * caller's technical analysis — carry on untouched.
 */

const DELTA_LOOKBACK_MS = 24 * 60 * 60_000;

async function buildBreadth(degradation: SectionStatus[]): Promise<BreadthContext | null> {
  // The two inputs fail independently: the persisted provider row (dominance,
  // total mcap) and the live-derived BTC read (regime, 24h change, F&G).
  let row = null;
  let rowError: string | null = null;
  try {
    row = await latestMarketContextSnapshot();
  } catch (err) {
    rowError = (err as Error).message;
  }

  let snapshot = null;
  try {
    snapshot = await computeSnapshot("spot");
  } catch {
    // Snapshot unavailable — breadth degrades to the provider row alone.
  }
  // A demo snapshot is synthetic data; never present it as market context.
  const live = snapshot && snapshot.source === "live" ? snapshot : null;
  const btc = live?.assets.find((a) => a.ticker === "BTC") ?? null;

  if (!row && !live) {
    degradation.push({
      section: "breadth",
      status: rowError ? "error" : "missing",
      reason: rowError ?? "no breadth snapshot ingested yet and live BTC read unavailable",
    });
    return null;
  }

  const now = Date.now();
  const rowAge = row ? now - Date.parse(row.fetchedAt) : null;
  const rowStale = rowAge !== null && rowAge > BREADTH_STALE_MS;

  let dominanceDelta: number | null = null;
  if (row) {
    try {
      const prior = await marketContextSnapshotNear(
        new Date(Date.parse(row.fetchedAt) - DELTA_LOOKBACK_MS).toISOString(),
      );
      if (prior) dominanceDelta = round2(row.btcDominance - prior.btcDominance);
    } catch {
      // Delta is an enrichment; its absence is not a degradation.
    }
  }

  const status: SectionStatus["status"] = rowError ? "error" : rowStale || !row ? "stale" : "ok";
  degradation.push({
    section: "breadth",
    status: row || rowError ? status : "unconfigured",
    reason: rowError
      ? `breadth snapshot read failed: ${rowError}`
      : !row
        ? "no provider snapshot (COINGECKO_API_KEY unconfigured or worker not yet run); live BTC read only"
        : rowStale
          ? `provider snapshot is ${Math.round((rowAge ?? 0) / 60_000)}m old`
          : undefined,
    asOf: row?.fetchedAt ?? live?.updatedAt,
  });

  return {
    btcRegime: live?.regime.regime ?? null,
    btcChange24hPct: btc?.change24h ?? null,
    btcDominancePct: row ? round2(row.btcDominance) : null,
    btcDominanceDelta24hPp: dominanceDelta,
    totalMcapUsd: row?.totalMcapUsd ?? null,
    mcapChange24hPct: row?.mcapChange24hPct ?? null,
    fearGreed: live?.sentiment.fearGreed ?? null,
    fearGreedLabel: live ? fearGreedLabel(live.sentiment.fearGreed) : null,
    provenance: {
      source: row ? `${row.source}+binance` : "binance",
      asOf: row?.fetchedAt ?? live?.updatedAt ?? new Date().toISOString(),
      stale: rowStale,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── Health view (?view=health) ───────────────────────────────────────────────

export interface ContextHealth {
  /**
   * ok      — every configured source healthy and fresh
   * stale   — a configured source hasn't succeeded within its threshold
   * degraded— a configured source is failing outright (or health itself errored)
   * Unconfigured sources are reported but NEVER count against status.
   */
  status: "ok" | "stale" | "degraded";
  snapshotAgeSeconds: number | null;
  sources: IngestStateRow[];
}

function staleThresholdFor(source: string): number {
  if (source === "coingecko-global") return BREADTH_STALE_MS;
  if (source === "coinmarketcal") return CALENDAR_STALE_MS;
  if (source.startsWith("rss:")) return RSS_STALE_MS;
  return BREADTH_STALE_MS;
}

export async function contextHealth(): Promise<ContextHealth> {
  try {
    const [sources, latest] = await Promise.all([listIngestState(), latestMarketContextSnapshot()]);
    const now = Date.now();
    let status: ContextHealth["status"] = "ok";
    for (const s of sources) {
      if (s.status === "unconfigured") continue;
      if (s.status === "error") {
        status = "degraded";
        break;
      }
      const okAge = s.lastOkAt ? now - Date.parse(s.lastOkAt) : Number.POSITIVE_INFINITY;
      if (okAge > staleThresholdFor(s.source)) status = "stale";
    }
    return {
      status,
      snapshotAgeSeconds: latest
        ? Math.max(0, Math.round((now - Date.parse(latest.fetchedAt)) / 1000))
        : null,
      sources,
    };
  } catch {
    return { status: "degraded", snapshotAgeSeconds: null, sources: [] };
  }
}

export async function assembleExternalContext(symbol: string): Promise<ExternalContext> {
  const sym = normalizeTicker(symbol);
  const degradation: SectionStatus[] = [];

  const breadth = await buildBreadth(degradation).catch((err) => {
    degradation.push({ section: "breadth", status: "error", reason: (err as Error).message });
    return null;
  });

  return {
    symbol: sym,
    assembledAt: new Date().toISOString(),
    breadth,
    relative: null,
    recentCatalysts: null,
    recentHighImpact: null,
    upcoming: null,
    marketEvents: null,
    social: null,
    degradation,
  };
}
