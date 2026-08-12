import { createFileRoute } from "@tanstack/react-router";

/**
 * Server-side proxy for the FastAPI MOMENTUM RADAR snapshot
 * (`backend/app/momentum`).
 *
 * Public, like /api/rally-watcher/scan: provider market data plus a
 * deterministic derivation, no user content — no session check, no
 * X-Internal-* headers.
 *
 *   GET /api/momentum/scan?mode=SCALP|INTRADAY → the current radar snapshot
 *   for that horizon: the surfaced situations plus the funnel behind them.
 *
 * The mode is forwarded rather than dropped — swallowing it here would pin the
 * UI to scalp however the tabs are set.
 *
 * This is the first-paint / fallback read; the live path is the SSE stream at
 * /api/momentum/stream.
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/momentum/scan")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const mode = new URL(request.url).searchParams.get("mode") ?? "SCALP";
        const res = await fetch(
          `${BACKEND_BASE}/api/v1/momentum/scan?mode=${encodeURIComponent(mode)}`,
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
