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

export const Route = createFileRoute("/api/execution/execute")({
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

        const { permit_id } = body as { permit_id?: string };
        if (!permit_id || typeof permit_id !== "string") {
          return Response.json(
            { error: "permit_id is required" },
            { status: 400 }
          );
        }

        const res = await fetch(
          `${BACKEND_BASE}/api/v1/execution/permits/${permit_id}/execute`,
          {
            method: "POST",
            headers: backendHeaders(auth.user.id),
            body: JSON.stringify({
              idempotency_key: `exec-${permit_id}`,
            }),
          }
        );

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
