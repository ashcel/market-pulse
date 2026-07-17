import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

/**
 * Server-side proxy for the FastAPI trades API.
 * Validates the session cookie (frontend auth), then forwards the request to
 * the FastAPI backend using the X-Internal-Key + X-Internal-User-Id mechanism.
 *
 * Routes:
 *   GET    /api/trades          → list user trades
 *   POST   /api/trades          → create a new trade
 *   GET    /api/trades/:id      → get trade by id  (handled in api/trades.$id.ts)
 *   PATCH  /api/trades/:id      → update trade     (handled in api/trades.$id.ts)
 *   DELETE /api/trades/:id      → delete trade     (handled in api/trades.$id.ts)
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

export const Route = createFileRoute("/api/trades")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const url = new URL(request.url);
        const status = url.searchParams.get("status");
        const page = url.searchParams.get("page") ?? "1";
        const perPage = url.searchParams.get("per_page") ?? "50";

        const params = new URLSearchParams({ page, per_page: perPage });
        if (status) params.set("status", status);

        const res = await fetch(`${BACKEND_BASE}/api/v1/trades/?${params.toString()}`, {
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

        const res = await fetch(`${BACKEND_BASE}/api/v1/trades/`, {
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
    },
  },
});
