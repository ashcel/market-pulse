import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

export const Route = createFileRoute("/api/positions/stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const abort = new AbortController();
        request.signal.addEventListener("abort", () => abort.abort(), { once: true });
        const response = await fetch(`${BACKEND_BASE}/api/v1/execution/positions/stream`, {
          headers: {
            accept: "text/event-stream",
            "x-internal-key": INTERNAL_KEY,
            "x-internal-user-id": auth.user.id,
          },
          signal: abort.signal,
        });

        return new Response(response.body, {
          status: response.status,
          headers: {
            "content-type": response.headers.get("content-type") ?? "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
