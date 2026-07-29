import { createFileRoute } from "@tanstack/react-router";
import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

export const Route = createFileRoute("/api/decisions/$id/action")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        const res = await fetch(`${BACKEND_BASE}/api/v1/decisions/${params.id}/action`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-internal-key": INTERNAL_KEY,
            "x-internal-user-id": auth.user.id,
          },
          body: await request.text(),
        });
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
