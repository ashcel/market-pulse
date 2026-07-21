import { create } from "zustand";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import type { TradingIntent } from "@/lib/engine/intent";
import type { ChartStructure } from "@/lib/ai/analyst-context";
import type { ExternalContext } from "@/lib/engine/external-context";

export interface PageAiContext {
  symbol?: string;
  timeframe?: TokenTimeframe;
  evaluation?: SignalEvaluation | null;
  assessment?: DisplayIntentAssessment | null;
  /**
   * Every objective's assessment for the open page, keyed by intent — not just
   * the one the trader currently has selected. Lets the AI Desk Review (see
   * `ask-ai-sidebar.tsx`) match evidence to whichever intent a free-text idea
   * parses to, regardless of which tab is active. Optional/additive: pages
   * that only ever computed the single active assessment can omit it, and
   * evidence-gate logic falls back to `assessment` + an intent-match check.
   */
  assessments?: Partial<Record<TradingIntent, DisplayIntentAssessment>>;
  chartStructure?: ChartStructure | null;
  externalContext?: ExternalContext | null;
}

interface AiContextState {
  context: PageAiContext | null;
  setContext: (ctx: PageAiContext | null) => void;
}

export const useAiContext = create<AiContextState>((set) => ({
  context: null,
  setContext: (ctx) => set({ context: ctx }),
}));
