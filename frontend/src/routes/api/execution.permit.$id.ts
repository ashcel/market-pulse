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

export const Route = createFileRoute("/api/execution/permit/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const res = await fetch(`${BACKEND_BASE}/api/v1/execution/permits/${params.id}`, {
          headers: backendHeaders(auth.user.id),
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
