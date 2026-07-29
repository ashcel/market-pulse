import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useSnapshotMeta, useCatalystRailEvents } from "@/hooks/queries";
import { useBinanceKeyStatus } from "@/hooks/useReview";
import { useWatchlistStore } from "@/stores/watchlist";
import { useLivePriceStore } from "@/stores/live-prices";
import { fetchHealthServer } from "@/lib/engine/system";

export type TrustStatus = "healthy" | "stale" | "unavailable";
export type TrustEnvironment = "demo" | "testnet" | "live";

export interface TrustDetail {
  status: TrustStatus;
  reason: string;
  updatedAt: number | null;
}

export function useTrustState() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const market = useSnapshotMeta();
  const account = useBinanceKeyStatus();
  const watched = useWatchlistStore((state) => state.tickers);
  const catalyst = useCatalystRailEvents(watched);
  const ticks = useLivePriceStore((state) => state.ticks);
  const worker = useQuery({
    queryKey: ["system-health"],
    queryFn: () => fetchHealthServer(),
    staleTime: 2 * 60_000,
    refetchInterval: 60_000,
  });

  const classify = (updatedAt: number | null, threshold: number, unavailable: boolean, label: string): TrustDetail => {
    if (unavailable || updatedAt === null) return { status: "unavailable", reason: `${label} unavailable`, updatedAt };
    const age = now - updatedAt;
    return age > threshold
      ? { status: "stale", reason: `${label} stale (${Math.round(age / 1000)}s old)`, updatedAt }
      : { status: "healthy", reason: `${label} current`, updatedAt };
  };

  const marketAt = market.data?.updatedAt ? Date.parse(market.data.updatedAt) : null;
  const accountAt = account.lastSyncedAt ? Date.parse(account.lastSyncedAt) : null;
  const tickAt = Math.max(0, ...Object.values(ticks).map((tick) => tick.updatedAt)) || null;
  const details = {
    market: classify(marketAt, 30_000, market.isError, "Market data"),
    account: classify(accountAt, 60_000, account.isError || !account.connected, account.authenticated ? "Account snapshot" : "Account (sign in required)"),
    websocket: classify(tickAt, 30_000, false, "WebSocket"),
    catalyst: classify(catalyst.dataUpdatedAt || null, 5 * 60_000, catalyst.isError, "Catalyst data"),
    worker: classify(worker.dataUpdatedAt || null, 2 * 60_000, worker.isError || worker.data?.status === "error", "Worker"),
  };
  const states = Object.values(details).map((detail) => detail.status);
  const status: TrustStatus = states.includes("unavailable") ? "unavailable" : states.includes("stale") ? "stale" : "healthy";
  const environment: TrustEnvironment = market.data?.source !== "live" ? "demo" : worker.data?.environment === "production" || worker.data?.environment === "live" ? "live" : "testnet";

  return { status, environment, details };
}
