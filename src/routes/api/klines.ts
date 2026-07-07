import { createFileRoute } from "@tanstack/react-router";

import { fetchBinanceKlinesDirect, type MarketType } from "@/lib/engine/binance";
import { isTokenTimeframe } from "@/lib/engine/mock-candles";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

export const Route = createFileRoute("/api/klines")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const symbol = url.searchParams.get("symbol") ?? "";
        const timeframe = toTimeframe(url.searchParams.get("timeframe"));
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const endTimeParam = url.searchParams.get("endTime");
        const endTime = endTimeParam === null ? undefined : Number(endTimeParam);
        const market: MarketType = url.searchParams.get("market") === "perp" ? "perp" : "spot";

        const candles = await fetchBinanceKlinesDirect({
          symbol,
          timeframe,
          limit,
          endTime,
          market,
        });
        return Response.json(candles);
      },
    },
  },
});

function toTimeframe(value: string | null): TokenTimeframe {
  return isTokenTimeframe(value) ? value : "4H";
}
