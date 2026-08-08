import { createFileRoute } from "@tanstack/react-router";

/**
 * Server-side proxy for the FastAPI REACCUMULATION / SECOND EXPANSION
 * pattern API (`backend/app/patterns`).
 *
 * Public, like /api/market-context: provider market data + a deterministic
 * research read, no user content, so — unlike /api/trades — this forwards
 * with no session check and no X-Internal-* headers; the FastAPI router it
 * hits carries no auth dependency either.
 *
 *   GET  /api/patterns/reaccumulation?symbol=&limit=  → recent persisted detections
 *   POST /api/patterns/reaccumulation  { symbol }      → live evaluate for one symbol
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/patterns/reaccumulation")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const params = new URLSearchParams();
        const symbol = url.searchParams.get("symbol");
        const limit = url.searchParams.get("limit");
        if (symbol) params.set("symbol", symbol);
        if (limit) params.set("limit", limit);

        const res = await fetch(
          `${BACKEND_BASE}/api/v1/patterns/reaccumulation?${params.toString()}`,
        );
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },

      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }

        const res = await fetch(`${BACKEND_BASE}/api/v1/patterns/reaccumulation/evaluate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
