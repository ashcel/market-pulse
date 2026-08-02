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

/** Live MP execution positions. */
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
