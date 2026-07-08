import { useEffect, useRef } from "react";

import { dropUnclosedCandle, fetchBinanceKlines } from "@/lib/engine/binance";
import { STEP_SECONDS } from "@/lib/engine/mock-candles";
import { settleShadowSignal } from "@/lib/engine/shadow";
import { isTerminalStatus, settleTrackedSignalWithCandles } from "@/lib/engine/tracker";
import { useShadowSignalsStore } from "@/stores/shadow-signals";
import { useTrackedSignalsStore } from "@/stores/tracked-signals";
import type { MarketType } from "@/lib/engine/binance";
import type { ShadowSignal } from "@/lib/engine/shadow";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { TrackedSignal } from "@/lib/engine/tracker";

const SETTLE_INTERVAL_MS = 5 * 60_000;
const MIN_RUN_GAP_MS = 60_000;

interface SettlementGroup {
  symbol: string;
  timeframe: TokenTimeframe;
  market: MarketType;
  earliestSec: number;
  shadow: ShadowSignal[];
  tracked: TrackedSignal[];
}

function groupKey(symbol: string, timeframe: TokenTimeframe, market: MarketType): string {
  return `${symbol}:${timeframe}:${market}`;
}

function collectGroups(shadow: ShadowSignal[], tracked: TrackedSignal[]): SettlementGroup[] {
  const groups = new Map<string, SettlementGroup>();
  const add = (
    symbol: string,
    timeframe: TokenTimeframe,
    market: MarketType,
    openedAt: string,
    assign: (group: SettlementGroup) => void,
  ) => {
    const openedSec = Date.parse(openedAt) / 1000;
    if (!Number.isFinite(openedSec)) return;
    const key = groupKey(symbol, timeframe, market);
    const group = groups.get(key) ?? {
      symbol,
      timeframe,
      market,
      earliestSec: openedSec,
      shadow: [],
      tracked: [],
    };
    group.earliestSec = Math.min(group.earliestSec, openedSec);
    assign(group);
    groups.set(key, group);
  };

  for (const s of shadow) add(s.symbol, s.timeframe, s.market, s.openedAt, (g) => g.shadow.push(s));
  for (const s of tracked)
    add(s.symbol, s.timeframe, s.market ?? "spot", s.followedAt, (g) => g.tracked.push(s));
  return [...groups.values()];
}

/**
 * Kline-based catch-up settlement for shadow and user-tracked signals.
 * Polled last price misses wicks between polls; this walks real intrabar
 * highs/lows since each signal opened. Mounted once at the root so the record
 * keeps settling no matter which page the user is on.
 */
export function useSignalSettlement() {
  const shadowOpenKey = useShadowSignalsStore((s) =>
    s.signals
      .filter((item) => item.status === "active")
      .map((item) => item.id)
      .join(","),
  );
  const trackedOpenKey = useTrackedSignalsStore((s) =>
    s.signals
      .filter((item) => !isTerminalStatus(item.status))
      .map((item) => item.id)
      .join(","),
  );
  const openKey = `${shadowOpenKey}|${trackedOpenKey}`;
  const running = useRef(false);
  const lastRun = useRef(0);

  useEffect(() => {
    if (openKey === "|") return;

    const settle = async () => {
      if (running.current || Date.now() - lastRun.current < MIN_RUN_GAP_MS) return;
      running.current = true;
      lastRun.current = Date.now();
      try {
        const shadow = useShadowSignalsStore
          .getState()
          .signals.filter((s) => s.status === "active");
        const tracked = useTrackedSignalsStore
          .getState()
          .signals.filter((s) => !isTerminalStatus(s.status));
        const applyShadowPatch = useShadowSignalsStore.getState().applyPatch;
        const applySettlement = useTrackedSignalsStore.getState().applySettlement;

        for (const group of collectGroups(shadow, tracked)) {
          const step = STEP_SECONDS[group.timeframe];
          const elapsedBars = Math.ceil((Date.now() / 1000 - group.earliestSec) / step) + 3;
          const limit = Math.min(1000, Math.max(10, elapsedBars));
          const candles = dropUnclosedCandle(
            await fetchBinanceKlines(group.symbol, group.timeframe, limit, undefined, group.market),
          );
          if (candles.length === 0) continue; // unreachable data — never settle against nothing

          for (const signal of group.shadow) {
            const patch = settleShadowSignal(signal, candles);
            if (patch) applyShadowPatch(signal.id, patch);
          }
          for (const signal of group.tracked) {
            const patch = settleTrackedSignalWithCandles(signal, candles);
            if (patch) applySettlement(signal.id, patch);
          }
        }
      } finally {
        running.current = false;
      }
    };

    void settle();
    const timer = setInterval(() => void settle(), SETTLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [openKey]);
}
