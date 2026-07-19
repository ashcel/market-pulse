import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

/**
 * Server-side proxy that triggers a Binance trade-history sync for the
 * signed-in user. See api/binance-review.api-key.ts for the auth/proxy
 * pattern this mirrors.
 *
 * Routes:
 *   POST /api/binance-review/sync → sync trades from Binance into the backend's store
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

export const Route = createFileRoute("/api/binance-review/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const res = await fetch(`${BACKEND_BASE}/api/v1/binance-review/sync`, {
          method: "POST",
          headers: backendHeaders(auth.user.id),
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
