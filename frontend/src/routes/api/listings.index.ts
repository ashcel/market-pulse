import { createFileRoute } from "@tanstack/react-router";

/**
 * Server-side proxy for the FastAPI new-listing screener
 * (`backend/app/listings`).
 *
 * Public, like /api/patterns/reaccumulation: exchange listing data plus a
 * deterministic screener read, no user content — so this forwards with no
 * session check, matching the FastAPI router which carries no auth dependency.
 *
 *   GET /api/listings?limit=&status=&grade=&min_score=&sort=&include_rejected=
 *       → screener list, soonest listing first then score
 */
const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";

const FORWARDED = ["limit", "status", "grade", "min_score", "sort", "include_rejected"] as const;

export const Route = createFileRoute("/api/listings/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const params = new URLSearchParams();
        for (const key of FORWARDED) {
          const value = url.searchParams.get(key);
          if (value) params.set(key, value);
        }

        const res = await fetch(`${BACKEND_BASE}/api/v1/listings?${params.toString()}`);
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
