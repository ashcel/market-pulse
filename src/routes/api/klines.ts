import { createFileRoute } from "@tanstack/react-router";

import { fetchBinanceKlinesDirect } from "@/lib/engine/binance";
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

        const candles = await fetchBinanceKlinesDirect({ symbol, timeframe, limit });
        return Response.json(candles);
      },
    },
  },
});

function toTimeframe(value: string | null): TokenTimeframe {
  return isTokenTimeframe(value) ? value : "4H";
}
