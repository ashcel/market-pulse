import { create } from "zustand";

export interface AiDeskPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number;
  leverage: number;
}

interface AiDeskMessage {
  id: number;
  text: string;
  source?: string;
  positions?: AiDeskPosition[];
}

interface AiDeskState {
  open: boolean;
  incomingMessage: AiDeskMessage | null;
  setOpen: (open: boolean) => void;
  addAssistantMessage: (text: string, source?: string, positions?: AiDeskPosition[]) => void;
  clearIncomingMessage: () => void;
}

export const useAiDeskStore = create<AiDeskState>((set) => ({
  open: true,
  incomingMessage: null,
  setOpen: (open) => set({ open }),
  addAssistantMessage: (text, source, positions) =>
    set({ open: true, incomingMessage: { id: Date.now(), text, source, positions } }),
  clearIncomingMessage: () => set({ incomingMessage: null }),
}));
