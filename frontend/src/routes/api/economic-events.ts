import { createFileRoute } from "@tanstack/react-router";

import { listUpcomingEconomicEvents, type EconImpact } from "@/server/db/repo";

/**
 * Economic calendar (ForexFactory macro events) — market-wide backdrop for
 * both crypto and Binance-listed tokenized TradFi. Public: macro-plane data
 * with no user content, like /api/token-events and /api/external-context.
 *
 *   GET                       → upcoming events, next 7 days, soonest first
 *   GET ?days=14              → widen the window (1–30, default 7)
 *   GET ?minImpact=high       → drop the low-signal tail (high | medium | low)
 *
 * Read-only; the worker's econ pass is the sole writer. Serving never fetches a
 * provider on the request path — it reads economic_event from Postgres alone.
 */
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const VALID_IMPACT = new Set<EconImpact>(["high", "medium", "low"]);

export const Route = createFileRoute("/api/economic-events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);

        const daysRaw = Number(url.searchParams.get("days"));
        const days =
          Number.isFinite(daysRaw) && daysRaw >= 1
            ? Math.min(Math.floor(daysRaw), MAX_DAYS)
            : DEFAULT_DAYS;

        const impactRaw = url.searchParams.get("minImpact");
        const minImpact =
          impactRaw && VALID_IMPACT.has(impactRaw as EconImpact)
            ? (impactRaw as EconImpact)
            : undefined;

        const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        try {
          const events = await listUpcomingEconomicEvents(until, { minImpact });
          return Response.json({ events, windowDays: days, asOf: new Date().toISOString() });
        } catch (err) {
          return Response.json({ events: [], error: (err as Error).message }, { status: 500 });
        }
      },
    },
  },
});
