import { createFileRoute } from "@tanstack/react-router";

/**
 * Streaming proxy for the FastAPI MOMENTUM RADAR SSE feed.
 *
 * The radar's whole point is that it updates continuously, so the browser
 * subscribes rather than polls. SSE (not a websocket) because this stack cannot
 * upgrade HTTP connections — see CLAUDE.md.
 *
 * The upstream body is piped straight through untouched: no buffering, no
 * re-encoding, and the client's abort signal is forwarded so a closed tab tears
 * the upstream connection down instead of leaving it pushing into nothing.
 *
 *   GET /api/momentum/stream?mode=SCALP|INTRADAY → text/event-stream of
 *   `radar` events for that horizon.
 *
 * The mode is forwarded rather than dropped: it selects which profile's
 * snapshot the backend streams, so swallowing it here would silently pin the
 * whole UI to scalp.
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/momentum/stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const mode = new URL(request.url).searchParams.get("mode") ?? "SCALP";
        const upstream = await fetch(
          `${BACKEND_BASE}/api/v1/momentum/stream?mode=${encodeURIComponent(mode)}`,
          {
            headers: { accept: "text/event-stream" },
            signal: request.signal,
          },
        );

        if (!upstream.ok || upstream.body === null) {
          return new Response(`: radar unavailable (${upstream.status})\n\n`, {
            status: 502,
            headers: { "content-type": "text/event-stream" },
          });
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
