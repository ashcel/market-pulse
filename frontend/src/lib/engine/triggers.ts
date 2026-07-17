import { INTENT_MAX_HOLD_BARS } from "./hysteresis";
import { INTENTS } from "./intent";
import { STEP_SECONDS } from "./mock-candles";
import type { HeldVerdict, TriggerLevel } from "./hysteresis";
import type { NotificationEvent } from "./notifications";
import type { Candle } from "./types";

/**
 * Client-side trigger alerts. A held verdict names the exact price events that
 * would change its answer (see hysteresis.ts). This detects when one of those
 * events actually happens on a *closed* candle — the highest-value moment for a
 * discretionary trader — so the app can push it instead of making the user
 * poll the chart. Detection is pure; the watcher hook handles fetching and
 * presentation.
 */

const INTENT_LABEL = new Map(INTENTS.map((def) => [def.intent, def.label]));

function fmtLevel(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
}

function crosses(level: TriggerLevel, close: number): boolean {
  return level.side === "below" ? close < level.level : close > level.level;
}

/**
 * The most recent closed candle that both formed after the verdict was adopted
 * and hasn't aged past the intent's holding horizon. Returns null when there's
 * no fresh closed bar to judge against.
 */
function latestRelevantBar(held: HeldVerdict, closedBars: Candle[]): Candle | null {
  const heldAtSec = Date.parse(held.heldAt) / 1000;
  if (!Number.isFinite(heldAtSec)) return null;
  const step = STEP_SECONDS[held.executionTimeframe];
  const horizonSec = INTENT_MAX_HOLD_BARS[held.intent] * step;
  let latest: Candle | null = null;
  for (const bar of closedBars) {
    // The bar must have opened at/after adoption and its close must be recent
    // enough to still matter for this objective.
    if (bar.time < heldAtSec) continue;
    if (bar.time - heldAtSec > horizonSec) continue;
    if (!latest || bar.time > latest.time) latest = bar;
  }
  return latest;
}

export interface TriggerHit {
  kind: "invalidation" | "upgrade";
  event: NotificationEvent;
}

/**
 * Detects whether the latest closed candle broke one of the held verdict's
 * trigger levels. Invalidation (idea broke) takes priority over upgrade
 * (idea strengthened). The event id is deterministic — keyed on the exact bar
 * — so the same crossing can never alert twice.
 */
export function detectTriggerHit(held: HeldVerdict, closedBars: Candle[]): TriggerHit | null {
  const bar = latestRelevantBar(held, closedBars);
  if (!bar) return null;

  const dir = held.direction === "short" ? "short" : "long";
  const label = (INTENT_LABEL.get(held.intent) ?? held.intent).toLowerCase();
  const tf = held.executionTimeframe;
  const key = `${held.symbol}:${held.market}:${held.intent}`;
  const base = {
    ticker: held.symbol,
    createdAt: new Date((bar.time + STEP_SECONDS[tf]) * 1000).toISOString(),
  };

  if (held.invalidation && crosses(held.invalidation, bar.close)) {
    return {
      kind: "invalidation",
      event: {
        ...base,
        id: `trigger-${key}-${bar.time}-invalidation`,
        type: "trigger-hit",
        title: `${held.symbol} ${tf} broke your ${label} level`,
        body: `${tf} closed ${held.invalidation.side} ${fmtLevel(held.invalidation.level)} — the ${dir} ${label} idea just invalidated. Re-check the setup.`,
      },
    };
  }

  // Upgrade alerts only matter while there's still room to confirm.
  const canUpgrade = held.verdict === "wait" || held.verdict === "caution";
  if (canUpgrade && held.upgradeTrigger && crosses(held.upgradeTrigger, bar.close)) {
    return {
      kind: "upgrade",
      event: {
        ...base,
        id: `trigger-${key}-${bar.time}-upgrade`,
        type: "trigger-hit",
        title: `${held.symbol} ${tf} trigger hit`,
        body: `${tf} closed ${held.upgradeTrigger.side} ${fmtLevel(held.upgradeTrigger.level)} — strengthens the ${dir} ${label} case. It may now be favored.`,
      },
    };
  }

  return null;
}
