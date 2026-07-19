import { useState, useCallback, useMemo } from "react";
export interface TradeTicketState {
  symbol: string;
  side: "LONG" | "SHORT";
  entry_type: "MARKET" | "LIMIT";
  entry_price: number | "";
  stop_price: number | "";
  target_price: number | "";
  risk_percent: number;
  leverage: number;
  correlation_bucket: string;
}

export const DEFAULT_TRADE_TICKET_STATE: TradeTicketState = {
  symbol: "",
  side: "LONG",
  entry_type: "MARKET",
  entry_price: "",
  stop_price: "",
  target_price: "",
  risk_percent: 1.0,
  leverage: 1,
  correlation_bucket: "other",
};

export function useTradeTicket(initialState: Partial<TradeTicketState> = {}) {
  const getInitialState = useCallback(
    (): TradeTicketState => ({ ...DEFAULT_TRADE_TICKET_STATE, ...initialState }),
    [initialState],
  );
  const [state, setState] = useState<TradeTicketState>(getInitialState);

  const setField = useCallback(
    <K extends keyof TradeTicketState>(field: K, value: TradeTicketState[K]) => {
      setState((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const reset = useCallback(() => {
    setState(getInitialState());
  }, [getInitialState]);

  const replace = useCallback((next: Partial<TradeTicketState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const isValid = useMemo(() => {
    if (!state.symbol) return false;
    if (state.entry_type === "LIMIT" && (state.entry_price === "" || state.entry_price <= 0))
      return false;
    if (state.stop_price === "" || state.stop_price <= 0) return false;
    if (state.risk_percent <= 0 || state.risk_percent > 100) return false;
    return true;
  }, [state]);

  const estimatedRR = useMemo(() => {
    // For MARKET, we might not have a reliable entry price unless the user types it in.
    // If entry_price is empty, we can't compute RR.
    if (
      state.entry_price === "" ||
      state.stop_price === "" ||
      state.entry_price <= 0 ||
      state.stop_price <= 0
    )
      return null;

    const entry = Number(state.entry_price);
    const stop = Number(state.stop_price);

    // In LONG: entry > stop. In SHORT: entry < stop.
    // Risk = |entry - stop|
    const risk = Math.abs(entry - stop);
    if (risk === 0) return null;

    if (state.target_price !== "") {
      const target = Number(state.target_price);
      if (target > 0) {
        const reward = Math.abs(target - entry);
        return reward / risk;
      }
    }
    return null;
  }, [state]);

  return {
    state,
    setField,
    replace,
    reset,
    isValid,
    estimatedRR,
  };
}
