import {
  BREADTH_STALE_MS,
  CALENDAR_STALE_MS,
  HIGH_IMPACT_WINDOW_MS,
  RSS_STALE_MS,
  fearGreedLabel,
  partitionRecentEvents,
  type BreadthContext,
  type ContextEventItem,
  type ExternalContext,
  type SectionStatus,
} from "@/lib/engine/external-context";
import { computeSnapshot } from "@/lib/engine/market";
import { normalizeTicker } from "@/lib/engine/symbol-map";
import {
  latestMarketContextSnapshot,
  listIngestState,
  listTokenEventsForSymbols,
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

/**
 * Viewed asset vs BTC — is this move the asset's own or just the market's?
 * Reads the market snapshot's per-asset relative fields (relative.ts) and
 * derives the asset/BTC price ratio from the two USDT prices — no BTC-quoted
 * pair needed, and the ~bps of quote-spread error is irrelevant here.
 */
async function buildRelative(
  sym: string,
  degradation: SectionStatus[],
): Promise<ExternalContext["relative"]> {
  if (sym === "BTC") return null; // dominance already covers BTC-vs-market
  let snapshot;
  try {
    snapshot = await computeSnapshot("spot");
  } catch (err) {
    degradation.push({
      section: "relative",
      status: "error",
      reason: `market snapshot unavailable: ${(err as Error).message}`,
    });
    return null;
  }
  if (snapshot.source !== "live") {
    degradation.push({
      section: "relative",
      status: "missing",
      reason: "market snapshot is in demo mode — synthetic data is never served as context",
    });
    return null;
  }
  const asset = snapshot.assets.find((a) => a.ticker === sym);
  const btc = snapshot.assets.find((a) => a.ticker === "BTC");
  if (!asset || asset.rsBtc24h === undefined || asset.rsBtc7d === undefined) {
    degradation.push({
      section: "relative",
      status: "missing",
      reason: `${sym} is outside the tracked universe — no relative read`,
    });
    return null;
  }
  const ratio = btc && btc.price > 0 && asset.price > 0 ? asset.price / btc.price : null;
  // Ratio 7d change follows exactly from the two USDT 7d changes.
  const ratioChange7d =
    asset.change7d !== undefined && btc?.change7d !== undefined && btc.change7d > -100
      ? round2(((1 + asset.change7d / 100) / (1 + btc.change7d / 100) - 1) * 100)
      : null;
  degradation.push({ section: "relative", status: "ok", asOf: snapshot.updatedAt });
  return {
    rsBtc24hPp: asset.rsBtc24h,
    rsBtc7dPp: asset.rsBtc7d,
    corrBtc7d: asset.corrBtc7d ?? null,
    ratio: ratio === null ? null : Number(ratio.toPrecision(6)),
    ratioChange7dPct: ratioChange7d,
    provenance: { source: "binance", asOf: snapshot.updatedAt, stale: false },
  };
}

/** The two retrospective buckets from the symbol's last-7d token events. */
async function buildRecentEvents(
  sym: string,
  degradation: SectionStatus[],
): Promise<{
  recentCatalysts: ContextEventItem[] | null;
  recentHighImpact: ContextEventItem[] | null;
}> {
  try {
    const since = new Date(Date.now() - HIGH_IMPACT_WINDOW_MS).toISOString();
    const rows = await listTokenEventsForSymbols([sym], since, 50);
    const items: ContextEventItem[] = rows.map((r) => ({
      kind: r.kind,
      severity: r.severity,
      title: r.title,
      source: r.source,
      url: r.url,
      publishedAt: r.publishedAt,
    }));
    const { recentCatalysts, recentHighImpact } = partitionRecentEvents(items, Date.now());
    degradation.push({
      section: "recentCatalysts",
      status: "ok",
      asOf: new Date().toISOString(),
    });
    return { recentCatalysts, recentHighImpact };
  } catch (err) {
    degradation.push({
      section: "recentCatalysts",
      status: "error",
      reason: `token-event read failed: ${(err as Error).message}`,
    });
    return { recentCatalysts: null, recentHighImpact: null };
  }
}

export async function assembleExternalContext(symbol: string): Promise<ExternalContext> {
  const sym = normalizeTicker(symbol);
  const degradation: SectionStatus[] = [];

  const [breadth, relative, recent] = await Promise.all([
    buildBreadth(degradation).catch((err) => {
      degradation.push({ section: "breadth", status: "error", reason: (err as Error).message });
      return null;
    }),
    buildRelative(sym, degradation).catch((err) => {
      degradation.push({ section: "relative", status: "error", reason: (err as Error).message });
      return null;
    }),
    buildRecentEvents(sym, degradation),
  ]);

  return {
    symbol: sym,
    assembledAt: new Date().toISOString(),
    breadth,
    relative,
    recentCatalysts: recent.recentCatalysts,
    recentHighImpact: recent.recentHighImpact,
    upcoming: null,
    marketEvents: null,
    social: null,
    degradation,
  };
}
