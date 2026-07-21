import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { DeskOutcome } from "@/lib/ai/trade-idea";
import type { TradingIntent } from "@/lib/engine/intent";

// Offline cache of past AI Desk Review runs — a convenience history list for
// the sidebar's empty/composer state, NOT a system of record (no server
// mirror, nothing else reads it). Newest first, capped at 20.
export interface DeskReviewHistoryEntry {
  id: string;
  at: string;
  ideaText: string;
  symbol: string | null;
  direction: "long" | "short" | null;
  intent: TradingIntent | null;
  outcome: DeskOutcome;
  thesis: string;
}

const MAX_HISTORY = 20;

interface DeskReviewsState {
  reviews: DeskReviewHistoryEntry[];
  addReview: (entry: DeskReviewHistoryEntry) => void;
  clear: () => void;
}

export const useDeskReviewsStore = create<DeskReviewsState>()(
  persist(
    (set) => ({
      reviews: [],
      addReview: (entry) => set((s) => ({ reviews: [entry, ...s.reviews].slice(0, MAX_HISTORY) })),
      clear: () => set({ reviews: [] }),
    }),
    { name: "iq-desk-reviews" },
  ),
);
