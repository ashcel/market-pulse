import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";

const BACKEND_BASE = process.env.BACKEND_URL ?? "http://localhost:8002";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

/**
 * Derivatives Intelligence proxy.
 *
 * `?symbol=BTC` returns the full read model; adding `?metric=&window=` asks
 * for the sparkline series instead. One route rather than two because the
 * upstream path segment (`/derivatives/{symbol}`) would otherwise need a
 * `$symbol` route file for what is the same authorization and the same
 * forwarding.
 *
 * The symbol is normalized upstream (uppercase, strip non-alphanumerics,
 * append USDT), so a bare ticker from the Ticket page is fine here.
 */
export const Route = createFileRoute("/api/derivatives")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;

        const url = new URL(request.url);

        // `?summary=1` asks for the cross-symbol read (Now strip / Ideas
        // badge / Lab leaderboard) instead of one symbol's card.
        if (url.searchParams.get("summary")) {
          const res = await fetch(`${BACKEND_BASE}/api/v1/derivatives/summary`, {
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
        }

        const symbol = url.searchParams.get("symbol") ?? "";
        if (!symbol) {
          return new Response(
            JSON.stringify({ data: null, meta: null, error: { code: "MISSING_SYMBOL" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const metric = url.searchParams.get("metric");
        const window = url.searchParams.get("window");
        const path = metric
          ? `/derivatives/${encodeURIComponent(symbol)}/history?metric=${encodeURIComponent(metric)}&window=${encodeURIComponent(window ?? "1h")}`
          : `/derivatives/${encodeURIComponent(symbol)}`;

        const res = await fetch(`${BACKEND_BASE}/api/v1${path}`, {
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
