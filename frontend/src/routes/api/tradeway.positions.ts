import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

/** Authenticated read-only bridge to the existing Tradeway proxy. */
export const Route = createFileRoute("/api/tradeway/positions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const response = await fetch(`${BACKEND_BASE}/api/v1/tradeway/positions`, {
          headers: {
            "x-internal-key": INTERNAL_KEY,
            "x-internal-user-id": auth.user.id,
          },
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
