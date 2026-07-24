import { create } from "zustand";
import { persist } from "zustand/middleware";

/** User chart drawings. Anchored in (logical index, price) space — not pixels —
 *  so they survive pan/zoom/resize and re-render at the right spot. Purely a
 *  charting aid: drawings never feed the engine, the verdict, or the permit. */
export type DrawingTool = "trendline" | "hline" | "box" | "fib";

export interface DrawAnchor {
  /** Time-scale logical index (can be fractional / beyond the data). */
  logical: number;
  price: number;
}

export interface Drawing {
  id: string;
  tool: DrawingTool;
  a: DrawAnchor;
  b: DrawAnchor;
  color: string;
}

interface DrawingsState {
  bySymbol: Record<string, Drawing[]>;
  add: (symbol: string, drawing: Drawing) => void;
  remove: (symbol: string, id: string) => void;
  clear: (symbol: string) => void;
}

export const useDrawingsStore = create<DrawingsState>()(
  persist(
    (set) => ({
      bySymbol: {},
      add: (symbol, drawing) =>
        set((s) => ({
          bySymbol: {
            ...s.bySymbol,
            [symbol]: [...(s.bySymbol[symbol] ?? []), drawing],
          },
        })),
      remove: (symbol, id) =>
        set((s) => ({
          bySymbol: {
            ...s.bySymbol,
            [symbol]: (s.bySymbol[symbol] ?? []).filter((d) => d.id !== id),
          },
        })),
      clear: (symbol) => set((s) => ({ bySymbol: { ...s.bySymbol, [symbol]: [] } })),
    }),
    { name: "iq-chart-drawings" },
  ),
);
