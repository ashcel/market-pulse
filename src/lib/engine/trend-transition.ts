import {
  trendFrom,
  type MarketStructure,
  type StructureTrend,
  type SwingLabel,
  type SwingPoint,
} from "./structure";

/**
 * Trend transitions — the narrative connecting structure.ts' two outputs. The
 * structure maintains a *current* trend and discrete CHoCH/BOS events, but
 * nothing says "the downtrend that CHoCH hinted against is now a confirmed
 * uptrend as of swing X". This deriver folds the already-labeled swing
 * sequence back through `trendFrom` (the exact evolution
 * `computeMarketStructure` maintains — parity-pinned) and emits transition
 * records:
 *
 * - **choch-hint**: a CHoCH printed against the prevailing trend — the first
 *   structural hint, not yet a new trend. A hint that never confirms simply
 *   stays a hint in the history, superseded by whatever happened instead.
 * - **confirmed**: the running trend actually flipped. When a pending hint
 *   pointed this way the hint record upgrades in place (keeping the
 *   originating CHoCH swing); a flip with no hint — structure forming out of
 *   a range — confirms directly with `chochSwing: null`.
 *
 * Falls *into* range are deliberately not records: a range is the space
 * between trends, and the next transition's `from` field carries it.
 *
 * Replay-safe: labels and events are frozen per swing (structure.ts' own
 * rule) and the fold is forward-only. Display-plane: read by no verdict —
 * hysteresis' contextBias-flip release stays the only trend reactivity in
 * the decision path.
 */

export type TransitionPhase = "choch-hint" | "confirmed";

export interface TrendTransition {
  /** The trend the market is leaving — the prevailing state when the transition opened. */
  from: StructureTrend;
  /** The newly established trend (confirmed) or the hinted direction (choch-hint). */
  to: StructureTrend;
  phase: TransitionPhase;
  /** The CHoCH that opened the transition; null when structure formed straight out of a range. */
  chochSwing: SwingPoint | null;
  /** The swing whose labels completed the flip; null while the hint is live. */
  confirmSwing: SwingPoint | null;
  /** Time of the latest phase advance. */
  time: number;
}

/** Full transition history, chronological. */
export function deriveTrendTransitions(structure: MarketStructure): TrendTransition[] {
  const out: TrendTransition[] = [];
  let highLabel: SwingLabel | null = null;
  let lowLabel: SwingLabel | null = null;
  let trend: StructureTrend = "range";
  let pending: TrendTransition | null = null;

  for (const swing of structure.swings) {
    // A new opposing extreme kills a live hint — the market resumed instead.
    // A fall into range does NOT: the interlude between CHoCH and the
    // confirming swing is range by construction (HH beside a stale LL).
    if (
      pending !== null &&
      ((pending.to === "uptrend" && swing.label === "LL") ||
        (pending.to === "downtrend" && swing.label === "HH"))
    ) {
      pending = null;
    }

    // A CHoCH opens (or reopens) a transition toward its break direction.
    if (swing.event === "choch") {
      pending = {
        from: trend,
        to: swing.label === "HH" ? "uptrend" : "downtrend",
        phase: "choch-hint",
        chochSwing: swing,
        confirmSwing: null,
        time: swing.time,
      };
      out.push(pending);
    }

    if (swing.kind === "high") highLabel = swing.label;
    else lowLabel = swing.label;
    const next = trendFrom(highLabel, lowLabel);

    if (next !== trend && next !== "range") {
      if (pending !== null && pending.to === next) {
        // The hinted reversal completed — upgrade the record in place so the
        // history reads hint → confirmation as one transition.
        pending.phase = "confirmed";
        pending.confirmSwing = swing;
        pending.time = swing.time;
      } else {
        out.push({
          from: trend,
          to: next,
          phase: "confirmed",
          chochSwing: null,
          confirmSwing: swing,
          time: swing.time,
        });
      }
      pending = null;
    }

    trend = next;
  }

  return out;
}

/** The most recent transition record (confirmed or still a live hint); null when none. */
export function latestTransition(structure: MarketStructure): TrendTransition | null {
  return deriveTrendTransitions(structure).at(-1) ?? null;
}
