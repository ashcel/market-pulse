import { nearestSessionStructure, type SessionLevel } from "./sessions";
import type { SignalEvaluation, TradeDirection } from "./quant";
import type { BaseZone } from "./zones";

/**
 * Entry-location grading. A directionally-correct verdict is still a bad trade
 * when price is extended away from the structure you'd want to enter against —
 * a long chased into resistance has a far stop and poor reward:risk even though
 * the thesis is right. This grades *where* price sits in the support→resistance
 * range for the trade's direction, so "favored" can be reserved for setups that
 * are also well located, and everything else can say "right direction, wrong
 * price — wait for a pullback to $X".
 *
 * Grading runs on the last *closed* bar's analytics (same basis as the rest of
 * the engine), so it changes once per bar rather than flickering intra-bar.
 */

export type LocationGrade = "at-structure" | "mid-range" | "extended";

/** How much fresh supply/demand structure backs the entry location. */
export type ZoneConfluence = "none" | "single-timeframe" | "multi-timeframe";

export interface LocationRead {
  grade: LocationGrade;
  /** Short chip label for the UI. */
  label: string;
  /** One-sentence plain explanation. */
  note: string;
  /** The level to wait for a pullback/rally toward (support for a long, resistance for a short). */
  pullbackTarget: number;
  /** 0 = at support, 1 = at resistance. May sit slightly outside [0,1] when price breaks a level. */
  rangePosition: number;
  /**
   * Fresh supply/demand backing: "none", "single-timeframe" (price sits on a
   * zone on the execution timeframe), or "multi-timeframe" (a higher-timeframe
   * zone lines up too — the confluence discretionary traders wait for).
   */
  confluence: ZoneConfluence;
}

/** Execution- and context-timeframe zones for grading + confluence. */
export interface LocationZones {
  execution: BaseZone[];
  context: BaseZone[];
}

const LABELS: Record<LocationGrade, string> = {
  "at-structure": "At structure",
  "mid-range": "Mid-range",
  extended: "Extended",
};

function fmtPrice(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function zonesOverlap(a: BaseZone, b: BaseZone): boolean {
  return a.priceLow <= b.priceHigh && a.priceHigh >= b.priceLow;
}

/**
 * The best fresh/tested zone price is sitting on for the trade direction: a
 * demand zone at/just-below price for a long, a supply zone at/just-above for a
 * short. Fresh zones win over tested; ties break to the nearest proximal edge.
 */
function entryZoneAtPrice(
  zones: BaseZone[],
  direction: "long" | "short",
  price: number,
  atr: number | null,
): BaseZone | null {
  const kind = direction === "long" ? "demand" : "supply";
  const matches = zones.filter((z) => {
    if (z.kind !== kind) return false;
    const buffer = atr && atr > 0 ? atr * 0.5 : (z.priceHigh - z.priceLow) * 0.5 || price * 0.002;
    return direction === "long"
      ? price >= z.priceLow && price <= z.priceHigh + buffer
      : price <= z.priceHigh && price >= z.priceLow - buffer;
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => {
    if (a.freshness !== b.freshness) return a.freshness === "fresh" ? -1 : 1;
    const pa = direction === "long" ? a.priceHigh : a.priceLow;
    const pb = direction === "long" ? b.priceHigh : b.priceLow;
    return Math.abs(price - pa) - Math.abs(price - pb);
  })[0];
}

/** The nearest fresh directional zone still ahead of a pullback (below for a long). */
function pullbackZone(
  zones: BaseZone[],
  direction: "long" | "short",
  price: number,
): BaseZone | null {
  const kind = direction === "long" ? "demand" : "supply";
  const candidates = zones.filter(
    (z) =>
      z.kind === kind &&
      z.freshness === "fresh" &&
      (direction === "long" ? z.priceHigh < price : z.priceLow > price),
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) =>
    direction === "long" ? b.priceHigh - a.priceHigh : a.priceLow - b.priceLow,
  )[0];
}

/**
 * Grades where price sits for the given direction. Returns null when there
 * isn't a usable support/resistance frame to judge against. When `zones` is
 * supplied, fresh supply/demand structure can promote the grade to
 * at-structure and flag multi-timeframe confluence.
 */
export function gradeLocation(
  evaluation: SignalEvaluation,
  direction: TradeDirection,
  zones?: LocationZones,
  sessionLevels?: SessionLevel[],
): LocationRead | null {
  if (direction !== "long" && direction !== "short") return null;
  const { support, resistance, lastClose, atrPercent } = evaluation.analytics;
  if (support === null || resistance === null || !lastClose || resistance <= support) return null;

  // Fraction of the support→resistance band where price sits.
  const pos = clamp((lastClose - support) / (resistance - support), -0.5, 1.5);
  // Proximity to the *ideal* entry structure: 0 = right at it, 1 = chasing into
  // the opposite level. Long enters near support; short near resistance.
  const proximity = direction === "long" ? pos : 1 - pos;
  const pullbackTarget = direction === "long" ? support : resistance;

  // In a wide range, price can be within a bar's worth of the level yet still
  // read mid-range by fraction alone — treat "within ~1 ATR of structure" as
  // at-structure regardless.
  const atrPct = atrPercent && atrPercent > 0 ? atrPercent : null;
  const distToStructurePct =
    direction === "long"
      ? ((lastClose - support) / lastClose) * 100
      : ((resistance - lastClose) / lastClose) * 100;
  const hugsStructure = atrPct !== null && distToStructurePct <= atrPct * 1.1;

  let grade: LocationGrade;
  if (proximity <= 0.4 || hugsStructure) grade = "at-structure";
  else if (proximity >= 0.7) grade = "extended";
  else grade = "mid-range";

  const nearLevel = direction === "long" ? support : resistance;
  const farLevel = direction === "long" ? resistance : support;
  const side = direction === "long" ? "support" : "resistance";
  const ceiling = direction === "long" ? "resistance" : "support";
  const zoneWord = direction === "long" ? "demand" : "supply";

  // Fresh supply/demand backing. A zone price is literally sitting on is a
  // better read of "at structure" than a pivot fraction, so it can promote the
  // grade; a higher-timeframe zone lining up is multi-timeframe confluence.
  const atr = evaluation.analytics.atr14;
  const exeZone = zones ? entryZoneAtPrice(zones.execution, direction, lastClose, atr) : null;
  let pullbackLevel = pullbackTarget;
  let confluence: ZoneConfluence = "none";
  let note: string;

  if (exeZone) {
    grade = "at-structure";
    const higherZone = zones?.context.find(
      (z) =>
        z.kind === exeZone.kind &&
        (zonesOverlap(z, exeZone) || (lastClose >= z.priceLow && lastClose <= z.priceHigh)),
    );
    confluence = higherZone ? "multi-timeframe" : "single-timeframe";
    note =
      confluence === "multi-timeframe"
        ? `Price is on a ${exeZone.freshness} ${zoneWord} zone (${fmtPrice(exeZone.priceLow)}–${fmtPrice(exeZone.priceHigh)}) that lines up with a higher-timeframe ${zoneWord} zone — multi-timeframe confluence, the highest-quality ${direction} entry on offer.`
        : `Price is on a ${exeZone.freshness} ${zoneWord} zone (${fmtPrice(exeZone.priceLow)}–${fmtPrice(exeZone.priceHigh)}) — a structure-backed ${direction} entry with a tight stop below it.`;
  } else if (grade === "at-structure") {
    note = `Price is hugging ${side} (${fmtPrice(nearLevel)}) — a clean spot to enter a ${direction} with a tight stop.`;
  } else if (grade === "mid-range") {
    note = `Price is mid-range between ${fmtPrice(support)} and ${fmtPrice(resistance)} — a workable but not ideal ${direction} entry; a pullback toward ${fmtPrice(pullbackTarget)} would be cleaner.`;
  } else {
    // When extended, a fresh zone beyond price is a better pullback target than
    // the raw pivot — that's where a discretionary trader would wait.
    const zone = zones ? pullbackZone(zones.execution, direction, lastClose) : null;
    if (zone) pullbackLevel = direction === "long" ? zone.priceHigh : zone.priceLow;
    note = zone
      ? `Price is extended toward ${ceiling} (${fmtPrice(farLevel)}). Wait for a pullback into the fresh ${zoneWord} zone near ${fmtPrice(pullbackLevel)} — a far cleaner ${direction} entry than chasing here.`
      : `Price is extended toward ${ceiling} (${fmtPrice(farLevel)}) — entering here chases the move with a wide stop and little room to target. Wait for a pullback toward ${fmtPrice(pullbackLevel)}.`;
  }

  // Session high/low levels are horizontal intraday structure. A session level
  // price is holding on the entry side is a concrete place to lean a stop —
  // strong enough to read as "at structure" on its own, and extra confluence
  // when it stacks on a supply/demand zone.
  const sessionHugDist = atr && atr > 0 ? atr * 0.75 : lastClose * 0.004;
  const sessionHug = sessionLevels?.length
    ? nearestSessionStructure(sessionLevels, direction, lastClose, sessionHugDist)
    : null;
  if (sessionHug) {
    const held = direction === "long" ? "holding" : "capped at";
    if (exeZone) {
      note += ` It stacks on the ${sessionHug.label} session ${sessionHug.kind} (${fmtPrice(sessionHug.price)}) — added session-level confluence.`;
    } else if (grade !== "at-structure") {
      grade = "at-structure";
      note = `Price is ${held} the ${sessionHug.label} session ${sessionHug.kind} (${fmtPrice(sessionHug.price)}) — an intraday level to lean a tight stop against for a ${direction} entry.`;
    } else {
      note += ` It also aligns with the ${sessionHug.label} session ${sessionHug.kind} (${fmtPrice(sessionHug.price)}).`;
    }
  }

  return {
    grade,
    label: LABELS[grade],
    note,
    pullbackTarget: pullbackLevel,
    rangePosition: pos,
    confluence,
  };
}
