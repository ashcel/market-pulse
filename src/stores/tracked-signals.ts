import { create } from "zustand";
import { persist } from "zustand/middleware";

import { evaluateTrackedSignal, type TrackedSignal } from "@/lib/engine/tracker";

export type FollowInput = Omit<TrackedSignal, "id" | "followedAt" | "status">;

interface TrackedSignalsState {
  signals: TrackedSignal[];
  follow: (input: FollowInput) => void;
  applyPriceUpdate: (id: string, latestPrice: number) => void;
  remove: (id: string) => void;
  hasOpenSignal: (
    symbol: string,
    intent: TrackedSignal["intent"],
    direction: TrackedSignal["direction"],
  ) => boolean;
}

export const useTrackedSignalsStore = create<TrackedSignalsState>()(
  persist(
    (set, get) => ({
      signals: [],
      follow: (input) =>
        set((s) => ({
          signals: [
            {
              ...input,
              id: crypto.randomUUID(),
              followedAt: new Date().toISOString(),
              status: "active",
            },
            ...s.signals,
          ],
        })),
      applyPriceUpdate: (id, latestPrice) => {
        const signal = get().signals.find((s) => s.id === id);
        if (!signal) return;
        const patch = evaluateTrackedSignal(signal, latestPrice, new Date().toISOString());
        if (!patch) return;
        set((s) => ({
          signals: s.signals.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        }));
      },
      remove: (id) => set((s) => ({ signals: s.signals.filter((item) => item.id !== id) })),
      hasOpenSignal: (symbol, intent, direction) =>
        get().signals.some(
          (s) =>
            s.symbol === symbol &&
            s.intent === intent &&
            s.direction === direction &&
            s.status === "active",
        ),
    }),
    { name: "iq-tracked-signals" },
  ),
);
