import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

function backendHeaders(userId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-internal-key": INTERNAL_KEY,
    "x-internal-user-id": userId,
  };
}

/**
 * Proxy for the deterministic Skip Check (R2). Mirrors execution.permit.ts:
 * validates the session cookie server-side, then forwards to the FastAPI
 * backend with the internal-key + user-id pair. The Skip Check never places
 * an order and persists nothing — it is a dry-run of the risk desk.
 */
export const Route = createFileRoute("/api/execution/skip-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }

        const res = await fetch(`${BACKEND_BASE}/api/v1/execution/skip-check/`, {
          method: "POST",
          headers: backendHeaders(auth.user.id),
          body: JSON.stringify(body),
        });

        let data;
        try {
          data = await res.json();
        } catch {
          data = { error: "Failed to parse backend response" };
        }

        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
