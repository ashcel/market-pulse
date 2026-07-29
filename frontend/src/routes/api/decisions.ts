import { createFileRoute } from "@tanstack/react-router";
import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

function headers(userId: string) {
  return {
    "content-type": "application/json",
    "x-internal-key": INTERNAL_KEY,
    "x-internal-user-id": userId,
  };
}

async function proxy(request: Request, method: "GET" | "POST") {
  const auth = await requireAuth(request);
  if (isResponse(auth)) return auth;
  const query = new URL(request.url).search;
  const res = await fetch(`${BACKEND_BASE}/api/v1/decisions${query}`, {
    method,
    headers: headers(auth.user.id),
    body: method === "POST" ? await request.text() : undefined,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

export const Route = createFileRoute("/api/decisions")({
  server: {
    handlers: {
      GET: ({ request }) => proxy(request, "GET"),
      POST: ({ request }) => proxy(request, "POST"),
    },
  },
});
