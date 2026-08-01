import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export interface MarketPosition {
  symbol: string;
  side: string;
  positionAmt?: number;
  size?: number | string;
  entryPrice?: number | string;
  markPrice?: number | string | null;
  unrealizedPnl?: number | string;
  unrealisedPnl?: number | string;
  leverage?: number | string;
  positionValue?: number | string;
}

export interface TradewayPositionsResult {
  positions: MarketPosition[];
  offline: boolean;
  detail?: string;
}

function positionsFrom(body: unknown): MarketPosition[] {
  if (Array.isArray(body)) return body as MarketPosition[];
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  for (const key of ["positions", "data", "result"]) {
    const value = record[key];
    if (Array.isArray(value)) return value as MarketPosition[];
    if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).list)) {
      return (value as Record<string, unknown>).list as MarketPosition[];
    }
  }
  return [];
}

async function fetchTradewayPositions(): Promise<TradewayPositionsResult> {
  const response = await fetch("/api/tradeway/positions", { credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 503) {
    const detail = body && typeof body === "object" ? String((body as Record<string, unknown>).detail ?? "") : "";
    return { positions: [], offline: true, detail };
  }
  if (!response.ok) throw new Error(`Tradeway tidak dapat dimuat (${response.status})`);
  return { positions: positionsFrom(body), offline: false };
}

/** Live MP execution positions. The stream is intentionally separate from Tradeway. */
export function useMpPositions() {
  const [positions, setPositions] = useState<MarketPosition[]>([]);
  const [state, setState] = useState<"connecting" | "live" | "error">("connecting");

  useEffect(() => {
    const stream = new EventSource("/api/positions/stream");
    stream.addEventListener("positions", (event) => {
      try {
        setPositions(positionsFrom(JSON.parse((event as MessageEvent<string>).data)));
        setState("live");
      } catch {
        setState("error");
      }
    });
    stream.onerror = () => setState("error");
    return () => stream.close();
  }, []);

  return { positions, state };
}

export function useTradewayPositions() {
  return useQuery({
    queryKey: ["tradeway", "positions"],
    queryFn: fetchTradewayPositions,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}
