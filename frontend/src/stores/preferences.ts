import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { TradingIntent } from "@/lib/engine/intent";
import type { StopMethod } from "@/lib/engine/quant";
import type { MarketType } from "@/lib/engine/binance";
import { clampLeverage } from "@/lib/utils/leverage";

export interface RiskPreferences {
  accountSize: number;
  maxRiskPerTradePercent: number;
  minimumRewardRisk: number;
  stopMethod: StopMethod;
}

/** Which segment of the market the trader mainly works — drives risk defaults. `null` = not chosen yet. */
export type CapSegment = "bigcap" | "smallcap" | null;

/** Risk/leverage defaults applied when the user picks a cap segment. Small caps move faster and
 * gap harder, so they get tighter risk, lower leverage, and demand more reward for the risk taken. */
export function riskDefaultsForCapSegment(
  segment: Exclude<CapSegment, null>,
): Pick<RiskPreferences, "maxRiskPerTradePercent" | "minimumRewardRisk"> & { leverage: number } {
  return segment === "bigcap"
    ? { maxRiskPerTradePercent: 1.0, minimumRewardRisk: 1.5, leverage: 5 }
    : { maxRiskPerTradePercent: 0.5, minimumRewardRisk: 2.0, leverage: 2 };
}

/** Sanitize a persisted/server value down to a valid CapSegment, else null. */
export function sanitizeCapSegment(value: unknown): CapSegment {
  return value === "bigcap" || value === "smallcap" ? value : null;
}

/** Toggleable overlays on the token detail chart. */
export type ChartIndicatorKey =
  | "volume"
  | "emaFast"
  | "emaSlow"
  | "support"
  | "resistance"
  | "pivots"
  | "plan"
  | "zones"
  | "sdZones"
  | "sessions"
  | "liquidity"
  | "events";

interface PreferencesState {
  refreshIntervalMs: number;
  activeAsset: string;
  notifications: {
    regime: boolean;
    rotation: boolean;
    highImpactNews: boolean;
    highQualitySetup: boolean;
    /** Alert when a held verdict's own trigger level breaks on a closed candle. */
    triggerAlert: boolean;
    /** Market-wide discovery: a vertical spike on abnormal volume, immediately rejected. */
    spikeAlert: boolean;
  };
  risk: RiskPreferences;
  /** The trader's current objective — drives the token-page decision assistant. */
  tradingIntent: TradingIntent;
  /** Price the token page against Binance spot or perpetual futures. */
  marketType: MarketType;
  /** Leverage for perpetual position sizing (margin + liquidation display). */
  leverage: number;
  hiddenChartIndicators: Partial<Record<ChartIndicatorKey, boolean>>;
  /** Big-cap vs small-cap trading focus, chosen once via the first-run modal (or later in Settings). */
  capSegment: CapSegment;
  setRefreshInterval: (ms: number) => void;
  setActiveAsset: (ticker: string) => void;
  toggleNotification: (key: keyof PreferencesState["notifications"]) => void;
  setRisk: (patch: Partial<RiskPreferences>) => void;
  setTradingIntent: (intent: TradingIntent) => void;
  setMarketType: (market: MarketType) => void;
  setLeverage: (leverage: number) => void;
  toggleChartIndicator: (key: ChartIndicatorKey) => void;
  /** Explicit user choice: sets the segment AND applies its risk defaults (leverage + risk prefs).
   * The user can still hand-tune those afterwards in Settings. */
  setCapSegment: (segment: Exclude<CapSegment, null>) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      refreshIntervalMs: 30_000,
      activeAsset: "BTC",
      notifications: {
        regime: true,
        rotation: true,
        highImpactNews: true,
        highQualitySetup: true,
        triggerAlert: true,
        spikeAlert: true,
      },
      risk: {
        accountSize: 10_000,
        maxRiskPerTradePercent: 0.5,
        minimumRewardRisk: 1.6,
        stopMethod: "swing",
      },
      tradingIntent: "swing",
      marketType: "spot",
      leverage: 5,
      hiddenChartIndicators: {},
      capSegment: null,
      setRefreshInterval: (ms) => set({ refreshIntervalMs: ms }),
      setActiveAsset: (ticker) => set({ activeAsset: ticker }),
      toggleNotification: (key) =>
        set((s) => ({
          notifications: { ...s.notifications, [key]: !s.notifications[key] },
        })),
      setRisk: (patch) => set((s) => ({ risk: { ...s.risk, ...patch } })),
      setTradingIntent: (intent) => set({ tradingIntent: intent }),
      setMarketType: (marketType) => set({ marketType }),
      setLeverage: (leverage) => set({ leverage: clampLeverage(leverage) }),
      toggleChartIndicator: (key) =>
        set((s) => ({
          hiddenChartIndicators: {
            ...s.hiddenChartIndicators,
            [key]: !s.hiddenChartIndicators[key],
          },
        })),
      setCapSegment: (segment) =>
        set((s) => {
          const defaults = riskDefaultsForCapSegment(segment);
          return {
            capSegment: segment,
            leverage: clampLeverage(defaults.leverage),
            risk: {
              ...s.risk,
              maxRiskPerTradePercent: defaults.maxRiskPerTradePercent,
              minimumRewardRisk: defaults.minimumRewardRisk,
            },
          };
        }),
    }),
    {
      name: "iq-preferences",
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<PreferencesState>;
        return {
          ...current,
          ...stored,
          marketType: stored.marketType === "perp" ? "perp" : "spot",
          leverage: clampLeverage(
            typeof stored.leverage === "number" ? stored.leverage : current.leverage,
          ),
          notifications: { ...current.notifications, ...stored.notifications },
          risk: { ...current.risk, ...stored.risk },
          hiddenChartIndicators: {
            ...current.hiddenChartIndicators,
            ...stored.hiddenChartIndicators,
          },
          capSegment: sanitizeCapSegment(stored.capSegment),
        };
      },
    },
  ),
);
