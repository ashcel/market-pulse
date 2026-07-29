import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

export const Route = createFileRoute("/api/alerts/$id/read")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        const res = await fetch(
          `${BACKEND_BASE}/api/v1/alerts/${encodeURIComponent(params.id)}/read`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-internal-key": INTERNAL_KEY,
              "x-internal-user-id": auth.user.id,
            },
          },
        );
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
