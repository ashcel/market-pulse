import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

export const Route = createFileRoute("/api/scorecard")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        const query = new URL(request.url).search;
        const res = await fetch(`${BACKEND_BASE}/api/v1/scorecard${query}`, {
          headers: {
            "content-type": "application/json",
            "x-internal-key": INTERNAL_KEY,
            "x-internal-user-id": auth.user.id,
          },
        });
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
