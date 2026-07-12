import { createFileRoute } from "@tanstack/react-router";

import { isResponse, requireAuth } from "@/server/auth/session";
import {
  getWatchlist,
  listTokenEvents,
  listTokenEventsForSymbols,
  listTrackedByOwner,
} from "@/server/db/repo";

const RELEVANT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Token events (Phase 2.5).
 *
 *   GET ?symbol=BTC          → recent events for one token (public — news-plane
 *                              data with no user content, like the news page)
 *   GET ?view=relevant       → last 7d of events across the caller's watchlist
 *                              + tokens they hold an active followed signal on
 */
export const Route = createFileRoute("/api/token-events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);

        if (url.searchParams.get("view") === "relevant") {
          const auth = await requireAuth(request);
          if (isResponse(auth)) return auth;
          const [watchlist, follows] = await Promise.all([
            getWatchlist(auth.user.id),
            listTrackedByOwner(auth.user.id),
          ]);
          const symbols = [
            ...new Set([
              ...watchlist,
              ...follows.filter((f) => f.status === "active").map((f) => f.symbol),
            ]),
          ];
          const since = new Date(Date.now() - RELEVANT_WINDOW_MS).toISOString();
          return Response.json(await listTokenEventsForSymbols(symbols, since));
        }

        const symbol = url.searchParams.get("symbol");
        if (!symbol) return Response.json({ error: "missing symbol" }, { status: 400 });
        return Response.json(await listTokenEvents(symbol, 20));
      },
    },
  },
});
