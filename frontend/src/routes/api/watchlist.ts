import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";
import { getWatchlist, putWatchlist } from "@/server/db/repo";

/**
 * Server-side watchlist (Phase 2.5): the source of truth for signed-in users,
 * so the token-event watcher can target notifications and the list follows the
 * user across devices. The zustand store remains the offline/signed-out cache.
 *
 *   GET          → the caller's watchlist tickers
 *   PUT {tickers} → replace-all sync (the client's full list is the payload)
 */
export const Route = createFileRoute("/api/watchlist")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        return Response.json({ tickers: await getWatchlist(auth.user.id) });
      },
      PUT: async ({ request }) => {
        const auth = await requireAuth(request);
        if (isResponse(auth)) return auth;
        let tickers: unknown;
        try {
          tickers = ((await request.json()) as { tickers?: unknown }).tickers;
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        if (!Array.isArray(tickers) || tickers.some((t) => typeof t !== "string")) {
          return Response.json({ error: "tickers must be a string array" }, { status: 400 });
        }
        await putWatchlist(auth.user.id, tickers as string[]);
        return Response.json({ ok: true });
      },
    },
  },
});
