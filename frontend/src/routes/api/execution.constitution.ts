import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

/**
 * Server-side proxy for the FastAPI Trading Constitution API (M9-T1 /
 * EDR 0020 decision 2). Validates the session cookie (frontend auth), then
 * forwards the request to FastAPI via the X-Internal-Key +
 * X-Internal-User-Id mechanism — same pattern as api/trades.ts.
 *
 * Routes:
 *   GET  /api/execution/constitution   → current (highest-version) constitution
 *   POST /api/execution/constitution   → create a new version (validated + audited)
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

export const Route = createFileRoute("/api/execution/constitution")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const res = await fetch(`${BACKEND_BASE}/api/v1/execution/constitution/`, {
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

        const res = await fetch(`${BACKEND_BASE}/api/v1/execution/constitution/`, {
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
