import { createFileRoute } from "@tanstack/react-router";

/**
 * Server-side proxy for the forward-test research read.
 *
 * Public, like the other research reads: derived market data and recorded
 * hypotheses, no user content — no session check, no X-Internal-* headers.
 *
 *   GET /api/research/forward-test?mode=&status=&limit= → summary, stats, rows.
 *
 * Query parameters are forwarded wholesale so the page's mode/status filters
 * reach the backend rather than being silently dropped.
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/research/forward-test")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams.toString();
        const res = await fetch(
          `${BACKEND_BASE}/api/v1/research/forward-test${query ? `?${query}` : ""}`,
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
