import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

function headers(userId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-internal-key": INTERNAL_KEY,
    "x-internal-user-id": userId,
  };
}

export const Route = createFileRoute("/api/alerts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        const query = new URL(request.url).searchParams.toString();
        const res = await fetch(`${BACKEND_BASE}/api/v1/alerts?${query}`, {
          headers: headers(auth.user.id),
        });
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
      POST: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        const res = await fetch(`${BACKEND_BASE}/api/v1/alerts/mark-all-read`, {
          method: "POST",
          headers: headers(auth.user.id),
        });
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
