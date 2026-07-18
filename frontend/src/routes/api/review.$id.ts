import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

/**
 * Server-side proxy for per-trade AI reviews.
 *
 * The review itself is generated CLIENT-SIDE (severity scoring, prompt
 * building, and the LLM call all run in the browser via the BYOK AI client —
 * see src/lib/review/generate.ts) so the user's AI provider key never touches
 * this server. This route only stores/retrieves the finished review JSON.
 *
 * Routes:
 *   GET  /api/review/:id → fetch a previously generated review (404 if none)
 *   POST /api/review/:id → persist a client-generated review
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

export const Route = createFileRoute("/api/review/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const res = await fetch(`${BACKEND_BASE}/api/v1/review/${params.id}`, {
          headers: backendHeaders(auth.user.id),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },

      POST: async ({ request, params }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }

        const res = await fetch(`${BACKEND_BASE}/api/v1/review/${params.id}`, {
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
