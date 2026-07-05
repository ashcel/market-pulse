import { useEffect, useState } from "react";

export interface LivePrice {
  price: number;
  change24h: number;
}

/**
 * Streams last price + 24h change from Binance's miniTicker WebSocket.
 * Returns null until the first tick (callers should fall back to REST data).
 * Reconnects with capped backoff; disable for demo/synthetic symbols.
 */
export function useLivePrice(symbol: string, enabled: boolean): LivePrice | null {
  const [tick, setTick] = useState<LivePrice | null>(null);

  useEffect(() => {
    setTick(null);
    if (!enabled || typeof WebSocket === "undefined") return;

    const stream = `${symbol.toLowerCase()}usdt@miniTicker`;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as { c?: string; o?: string };
          const price = Number(data.c);
          const open = Number(data.o);
          if (!Number.isFinite(price) || !Number.isFinite(open) || open === 0) return;
          attempts = 0;
          setTick({ price, change24h: Number((((price - open) / open) * 100).toFixed(2)) });
        } catch {
          // Ignore malformed frames.
        }
      };
      socket.onclose = () => {
        if (closed || attempts >= 5) return;
        attempts++;
        retryTimer = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempts));
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [symbol, enabled]);

  return tick;
}
