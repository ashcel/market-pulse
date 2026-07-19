import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

/**
 * Server-side proxy for the Trade Review Binance API key (connection)
 * endpoint. Validates the session cookie (frontend auth), then forwards the
 * request to the FastAPI backend using the X-Internal-Key + X-Internal-User-Id
 * mechanism.
 *
 * NOTE: unlike the AI-analyst key (BYOK, browser-only), the Trade Review
 * Binance key is intentionally stored server-side — the backend uses it
 * server-side to pull trade history from Binance on a schedule/on-demand
 * sync. This is a separate, read-only key class from the live-execution
 * Binance key (`/api/execution/exec-key`, not yet exposed in the UI) — see
 * `backend/app/binance_review/service.py` for why they're kept distinct.
 *
 * Routes:
 *   GET    /api/binance-review/api-key  → connection status (no secret returned)
 *   POST   /api/binance-review/api-key  → save/replace the key+secret
 *   DELETE /api/binance-review/api-key  → disconnect
 */

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

function backendHeaders(userId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-internal-key": INTERNAL_KEY,
    "x-internal-user-id": userId,
  };
}

export const Route = createFileRoute("/api/binance-review/api-key")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const res = await fetch(`${BACKEND_BASE}/api/v1/binance-review/api-key`, {
          headers: backendHeaders(auth.user.id),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },

      POST: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }

        const res = await fetch(`${BACKEND_BASE}/api/v1/binance-review/api-key`, {
          method: "POST",
          headers: backendHeaders(auth.user.id),
          body: JSON.stringify(body),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },

      DELETE: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const res = await fetch(`${BACKEND_BASE}/api/v1/binance-review/api-key`, {
          method: "DELETE",
          headers: backendHeaders(auth.user.id),
        });

        if (res.status === 204) {
          return new Response(null, { status: 204 });
        }
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
