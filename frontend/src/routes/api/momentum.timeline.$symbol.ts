import { createFileRoute } from "@tanstack/react-router";

/**
 * Server-side proxy for one symbol's MARKET-EVENT sequence
 * (`backend/app/momentum`).
 *
 * Public, like /api/momentum/scan: provider market data plus a deterministic
 * derivation, no user content — no session check, no X-Internal-* headers.
 *
 *   GET /api/momentum/timeline/:symbol → the full event log for that symbol,
 *   under its cached higher-timeframe context.
 *
 * Fetched on demand when a Discover card is expanded; the radar stream itself
 * carries only the last few events per card.
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/momentum/timeline/$symbol")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const symbol = encodeURIComponent(params.symbol);
        const mode = new URL(request.url).searchParams.get("mode") ?? "SCALP";
        const res = await fetch(
          `${BACKEND_BASE}/api/v1/momentum/timeline/${symbol}?mode=${encodeURIComponent(mode)}`,
        );
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
