import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

import { dropUnclosedCandle, fetchBinanceKlines } from "@/lib/engine/binance";
import { INTENT_MAX_HOLD_BARS } from "@/lib/engine/hysteresis";
import { STEP_SECONDS } from "@/lib/engine/mock-candles";
import { detectTriggerHit } from "@/lib/engine/triggers";
import { presentNotification } from "@/lib/notifications/present";
import { useNotificationsStore } from "@/stores/notifications";
import { usePreferencesStore } from "@/stores/preferences";
import { useVerdictHoldsStore } from "@/stores/verdict-holds";
import type { MarketType } from "@/lib/engine/binance";
import type { HeldVerdict } from "@/lib/engine/hysteresis";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";

const POLL_MS = 60_000;
const MIN_RUN_GAP_MS = 30_000;
// Bound request volume: watch only the most recently held groups. A held
// verdict older than this list is either stale or something the user has moved
// on from.
const MAX_WATCHED_GROUPS = 12;

interface WatchGroup {
  symbol: string;
  timeframe: TokenTimeframe;
  market: MarketType;
  holds: HeldVerdict[];
}

/** A hold is worth watching only while it's within horizon and has a checkable level. */
function isWatchable(held: HeldVerdict, nowMs: number): boolean {
  if (!held.invalidation && !held.upgradeTrigger) return false;
  const heldAtMs = Date.parse(held.heldAt);
  if (!Number.isFinite(heldAtMs)) return false;
  const horizonMs =
    INTENT_MAX_HOLD_BARS[held.intent] * STEP_SECONDS[held.executionTimeframe] * 1000;
  return nowMs - heldAtMs <= horizonMs;
}

function buildGroups(holds: HeldVerdict[], nowMs: number): WatchGroup[] {
  const watchable = holds
    .filter((h) => isWatchable(h, nowMs))
    .sort((a, b) => Date.parse(b.heldAt) - Date.parse(a.heldAt));

  const groups = new Map<string, WatchGroup>();
  for (const held of watchable) {
    const key = `${held.symbol}:${held.executionTimeframe}:${held.market}`;
    const group = groups.get(key);
    if (group) {
      group.holds.push(held);
    } else {
      if (groups.size >= MAX_WATCHED_GROUPS) continue;
      groups.set(key, {
        symbol: held.symbol,
        timeframe: held.executionTimeframe,
        market: held.market,
        holds: [held],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Watches every held verdict's own trigger levels and pushes an alert the
 * moment one breaks on a closed candle — the highest-value event for a
 * discretionary trader, and the whole point of holding a verdict instead of
 * re-deriving it. Purely client-side: the held verdicts live in the browser,
 * so there's nothing the server could watch on the user's behalf.
 */
export function useTriggerAlerts() {
  const router = useRouter();
  const enabled = usePreferencesStore((s) => s.notifications.triggerAlert);
  const holdKeys = useVerdictHoldsStore((s) => Object.keys(s.holds).sort().join(","));
  const running = useRef(false);
  const lastRun = useRef(0);
  // Deterministic per-bar event ids we've already surfaced; seeded from the
  // persisted bell history so a reload doesn't re-alert past crossings.
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || holdKeys === "") return;

    if (seen.current === null) {
      seen.current = new Set(
        useNotificationsStore
          .getState()
          .items.filter((item) => item.type === "trigger-hit")
          .map((item) => item.id),
      );
    }
    const seenIds = seen.current;

    const scan = async () => {
      if (running.current || Date.now() - lastRun.current < MIN_RUN_GAP_MS) return;
      running.current = true;
      lastRun.current = Date.now();
      try {
        const holds = Object.values(useVerdictHoldsStore.getState().holds);
        const add = useNotificationsStore.getState().add;

        for (const group of buildGroups(holds, Date.now())) {
          const candles = dropUnclosedCandle(
            await fetchBinanceKlines(group.symbol, group.timeframe, 5, undefined, group.market),
          );
          if (candles.length === 0) continue; // data unreachable — don't fabricate a break

          for (const held of group.holds) {
            const hit = detectTriggerHit(held, candles);
            if (!hit || seenIds.has(hit.event.id)) continue;
            seenIds.add(hit.event.id);
            add(hit.event);
            presentNotification(hit.event, () =>
              router.navigate({ to: "/token/$symbol", params: { symbol: held.symbol } }),
            );
          }
        }
      } finally {
        running.current = false;
      }
    };

    void scan();
    const timer = setInterval(() => void scan(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, holdKeys, router]);
}
