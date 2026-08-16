import { createFileRoute } from "@tanstack/react-router";

/**
 * One listing's full record — holder map, social pulse, price since launch.
 *
 *   GET /api/listings/:symbol            → the detail record
 *   GET /api/listings/:symbol?view=brief → the deterministic AI evidence pack
 *
 * `view=brief` exists so the browser's BYOK analyst narrates exactly the
 * numbers the backend computed, rather than re-deriving anything client-side.
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/listings/$symbol")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const symbol = encodeURIComponent(params.symbol.toUpperCase());
        const view = new URL(request.url).searchParams.get("view");
        const path = view === "brief" ? `${symbol}/brief` : symbol;

        const res = await fetch(`${BACKEND_BASE}/api/v1/listings/${path}`);
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
