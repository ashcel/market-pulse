import { createFileRoute } from "@tanstack/react-router";

import { fetchBinanceKlinesDirect } from "@/lib/engine/binance";
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
  if (value === "1H" || value === "4H" || value === "1D" || value === "1W") return value;
  return "4H";
}
