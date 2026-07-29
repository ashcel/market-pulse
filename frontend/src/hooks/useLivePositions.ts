import { useEffect, useState } from "react";

export interface LivePosition {
  symbol: string;
  side: "LONG" | "SHORT";
  positionAmt: number;
  entryPrice: number;
  unrealizedPnl: number;
  markPrice: number | null;
  leverage: number;
}

export function useLivePositions() {
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/positions/stream");

    source.addEventListener("positions", (event) => {
      try {
        const next = JSON.parse(event.data) as LivePosition[];
        setPositions(next.filter((position) => position.positionAmt !== 0));
        setIsLoading(false);
        setError(null);
      } catch {
        setIsLoading(false);
        setError("Invalid live position update");
      }
    });
    source.onerror = () => {
      setIsLoading(false);
      setError("Live positions disconnected; reconnecting...");
    };

    return () => source.close();
  }, []);

  return { positions, isLoading, error };
}
