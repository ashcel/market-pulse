import { create } from "zustand";
import { persist } from "zustand/middleware";

interface WatchlistState {
  tickers: string[];
  toggle: (ticker: string) => void;
  has: (ticker: string) => boolean;
}

export const useWatchlistStore = create<WatchlistState>()(
  persist(
    (set, get) => ({
      tickers: ["BTC", "ETH", "NVDA", "SPY"],
      toggle: (ticker) =>
        set((s) => ({
          tickers: s.tickers.includes(ticker)
            ? s.tickers.filter((t) => t !== ticker)
            : [...s.tickers, ticker],
        })),
      has: (ticker) => get().tickers.includes(ticker),
    }),
    { name: "iq-watchlist" },
  ),
);
