import { createFileRoute } from "@tanstack/react-router";

/**
 * Server-side proxy for the FastAPI RALLY WATCHER live scan
 * (`backend/app/rally_watcher`).
 *
 * Public, like /api/patterns/reaccumulation: provider market data + a
 * deterministic research read, no user content — no session check, no
 * X-Internal-* headers.
 *
 *   POST /api/rally-watcher/scan → live 15-minute rally scan over the
 *        dynamic perp universe (~60s server cache on the FastAPI side).
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

export const Route = createFileRoute("/api/rally-watcher/scan")({
  server: {
    handlers: {
      POST: async () => {
        const res = await fetch(`${BACKEND_BASE}/api/v1/rally-watcher/scan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
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
