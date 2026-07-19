import { useState, useCallback, useEffect } from "react";
import type { PermitIssuedEnvelope, PermitResponse } from "@/lib/types/execution";
import type { TradeTicketState } from "./useTradeTicket";

export function usePermit() {
  const [permit, setPermit] = useState<PermitResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number>(0);

  const requestPermit = useCallback(async (ticket: TradeTicketState) => {
    setLoading(true);
    setError(null);
    setPermit(null);
    setTimeRemainingSeconds(0);
    try {
      const body = {
        proposal: {
          symbol: ticket.symbol,
          side: ticket.side,
          entry_price: ticket.entry_price !== "" ? Number(ticket.entry_price) : null,
          stop_price: ticket.stop_price !== "" ? Number(ticket.stop_price) : null,
          take_profit_price: ticket.target_price !== "" ? Number(ticket.target_price) : null,
          risk_percent: ticket.risk_percent,
          leverage: ticket.leverage,
          correlation_bucket: ticket.correlation_bucket,
        },
      };

      const res = await fetch("/api/execution/permit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Failed to request permit: ${res.statusText}`);
      }

      const envelope = (await res.json()) as PermitIssuedEnvelope;
      if (!envelope?.data?.decision) {
        throw new Error("Invalid permit response from server");
      }
      setPermit(envelope.data);
    } catch (err: unknown) {
      setError((err as Error).message || "An error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  const clearPermit = useCallback(() => {
    setPermit(null);
    setError(null);
    setTimeRemainingSeconds(0);
  }, []);

  useEffect(() => {
    if (!permit?.decision?.expires_at) {
      setTimeRemainingSeconds(0);
      return;
    }

    const expiresAt = new Date(permit.decision.expires_at).getTime();

    const updateTimer = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
      setTimeRemainingSeconds(remaining);
    };

    updateTimer();
    const intervalId = setInterval(updateTimer, 1000);

    return () => clearInterval(intervalId);
  }, [permit]);

  const isExpired = timeRemainingSeconds <= 0 && permit !== null;

  return {
    permit,
    loading,
    error,
    timeRemainingSeconds,
    isExpired,
    requestPermit,
    clearPermit,
  };
}
