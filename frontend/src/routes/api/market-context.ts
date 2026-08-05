import { createFileRoute } from "@tanstack/react-router";

import {
  latestMarketContextSnapshot,
  marketContextSnapshotNear,
  marketContextSnapshotsSince,
  type MarketContextRow,
} from "@/server/db/repo";

/**
 * Global breadth read model (total market cap + BTC/ETH dominance) for the
 * dashboard's global-metric tiles.
 *
 *   GET → { latest, prior24h, series }
 *
 * Read-only: the Python worker's context pass is the sole writer of
 * `market_context_snapshot`. Serving never calls CoinGecko/CMC on the request
 * path. Public, like /api/economic-events — provider market data, no user
 * content. Every field can be null (nothing ingested yet, keys unconfigured);
 * the client renders an explicit "unavailable" state rather than a zero.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Points kept for the sparkline — the pass writes far more than we plot. */
const SERIES_POINTS = 60;

export interface MarketContextSeriesPoint {
  t: number;
  mcapUsd: number;
  btcDominance: number;
}

export interface MarketContextResponse {
  latest: MarketContextRow | null;
  /** The newest row at or before 24h ago — the delta baseline. */
  prior24h: MarketContextRow | null;
  /** Oldest-first, evenly thinned across the window. */
  series: MarketContextSeriesPoint[];
  asOf: string;
}

/** Evenly samples `rows` down to at most `n` points, always keeping the last. */
export function thin<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  const step = (rows.length - 1) / (n - 1);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.round(i * step)]);
  return out;
}

export const Route = createFileRoute("/api/market-context")({
  server: {
    handlers: {
      GET: async () => {
        const now = Date.now();
        const sinceIso = new Date(now - WINDOW_MS).toISOString();
        try {
          const [latest, prior24h, rows] = await Promise.all([
            latestMarketContextSnapshot(),
            marketContextSnapshotNear(sinceIso),
            marketContextSnapshotsSince(sinceIso),
          ]);
          const series = thin(rows, SERIES_POINTS).map((r): MarketContextSeriesPoint => ({
            t: new Date(r.fetchedAt).getTime(),
            mcapUsd: r.totalMcapUsd,
            btcDominance: r.btcDominance,
          }));
          const body: MarketContextResponse = {
            latest,
            prior24h,
            series,
            asOf: new Date(now).toISOString(),
          };
          return Response.json(body);
        } catch (err) {
          return Response.json(
            { latest: null, prior24h: null, series: [], error: (err as Error).message },
            { status: 500 },
          );
        }
      },
    },
  },
});
