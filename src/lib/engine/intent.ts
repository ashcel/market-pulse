import { gradeLocation, type LocationRead } from "./location";
import type { LiquidityPool } from "./liquidity";
import type { PerpRead } from "./perp";
import type { SessionLevel } from "./sessions";
import type { TokenTimeframe } from "./mock-candles";
import type { MarketRegime, RiskRewardPlan, SignalEvaluation, TradeDirection } from "./quant";
import type { BaseZone } from "./zones";

/** Fresh supply/demand zones per timeframe, for location grading + confluence. */
export type ZonesByTimeframe = Partial<Record<TokenTimeframe, BaseZone[]>>;

/**
 * The trader's objective. The same chart legitimately produces different
 * answers depending on what the trader is trying to do — a 4H downtrend with
 * a 1H bounce can be a bad swing long, an early swing short, and an
 * acceptable counter-trend scalp all at once. Each intent pairs a context
 * timeframe (which way is the tide?) with an execution timeframe (is there a
 * trigger right now?).
 */
export type TradingIntent = "scalp" | "intraday" | "swing" | "position";

/**
 * How the assistant answers "should I take this kind of trade?"
 * - favored: context and execution agree and the setup is confirmed
 * - caution: tradable, but against the higher-timeframe trend — reduced size
 * - wait: right idea, but confirmation is still missing — not yet
 * - avoid: wrong direction or the market doesn't suit this objective
 */
export type IntentVerdict = "favored" | "caution" | "wait" | "avoid";

export interface IntentDefinition {
  intent: TradingIntent;
  label: string;
  horizon: string;
  contextTimeframe: TokenTimeframe;
  executionTimeframe: TokenTimeframe;
  description: string;
}

export const INTENTS: readonly IntentDefinition[] = [
  {
    intent: "scalp",
    label: "Scalp",
    horizon: "minutes–hours",
    contextTimeframe: "1H",
    executionTimeframe: "15M",
    description: "Quick in-and-out trades riding short bursts of momentum.",
  },
  {
    intent: "intraday",
    label: "Intraday",
    horizon: "hours",
    contextTimeframe: "4H",
    executionTimeframe: "1H",
    description: "Positions opened and closed within the same day.",
  },
  {
    intent: "swing",
    label: "Swing",
    horizon: "days",
    contextTimeframe: "1D",
    executionTimeframe: "4H",
    description: "Multi-day positions around the dominant daily structure.",
  },
  {
    intent: "position",
    label: "Trend",
    horizon: "weeks",
    contextTimeframe: "1W",
    executionTimeframe: "1D",
    description: "Trend-following positions held for weeks.",
  },
];

export interface IntentChecklistItem {
  label: string;
  detail: string;
  done: boolean;
}

export interface IntentAssessment {
  intent: TradingIntent;
  definition: IntentDefinition;
  verdict: IntentVerdict;
  /** Recommended direction for this objective; "none" when standing aside. */
  direction: TradeDirection;
  isCounterTrend: boolean;
  /** 1 = full size, 0.5 = reduced (counter-trend). Applied to the plan. */
  sizeMultiplier: number;
  headline: string;
  summary: string;
  checklist: IntentChecklistItem[];
  /** Price events that would upgrade, downgrade, or flip this verdict. */
  triggers: string[];
  /** Engine confidence on the execution timeframe. */
  confidence: number;
  contextBias: TradeDirection;
  executionBias: TradeDirection;
  context: SignalEvaluation;
  execution: SignalEvaluation;
  /** Execution-timeframe plan (size-adjusted), or null when there is nothing to execute. */
  plan: RiskRewardPlan | null;
  /** Where price sits vs. structure for this direction; null when unavailable or standing aside. */
  location: LocationRead | null;
}

function human(value: string): string {
  return value.replaceAll("-", " ");
}

function regimeBias(regime: MarketRegime): TradeDirection {
  if (regime === "trending-up") return "long";
  if (regime === "trending-down") return "short";
  return "none";
}

/** Swing-structure lean of one timeframe: HH/HL → long, LH/LL → short. */
function structureBias(evaluation: SignalEvaluation): TradeDirection {
  if (evaluation.structure.trend === "uptrend") return "long";
  if (evaluation.structure.trend === "downtrend") return "short";
  return "none";
}

/**
 * Directional lean of one timeframe: the setup's direction when there is one.
 * Otherwise the MA-based regime and the swing-structure read decide together:
 * either alone may supply the lean, but when both speak and disagree (price
 * above a rising 20MA while printing LH/LL), that is not a context a trade
 * should inherit — the honest lean is none.
 */
export function timeframeBias(evaluation: SignalEvaluation): TradeDirection {
  if (evaluation.direction !== "none") return evaluation.direction;
  const regime = regimeBias(evaluation.regime);
  const structure = structureBias(evaluation);
  if (regime === "none") return structure;
  if (structure === "none" || structure === regime) return regime;
  return "none";
}

function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
}

export function scalePlan(plan: RiskRewardPlan, multiplier: number): RiskRewardPlan {
  if (multiplier === 1) return plan;
  const money = (v: number) => Math.round(v * multiplier * 100) / 100;
  return {
    ...plan,
    positionSize: Math.round(plan.positionSize * multiplier * 1e6) / 1e6,
    maxDollarRisk: money(plan.maxDollarRisk),
    maxDollarLoss: money(plan.maxDollarLoss),
    estimatedGain1: money(plan.estimatedGain1),
    estimatedGain2: money(plan.estimatedGain2),
  };
}

/** Short clause describing entry location, for the favored-verdict summary. */
function locationClause(location: LocationRead): string {
  if (location.confluence === "multi-timeframe")
    return "price is sitting on a multi-timeframe supply/demand confluence — the highest-quality entry structure";
  if (location.confluence === "single-timeframe")
    return "price is sitting on a fresh supply/demand zone for a tight-stop entry";
  return location.grade === "at-structure"
    ? "price is well located against structure for a tight-stop entry"
    : "price is mid-range but still a workable entry";
}

function buildChecklist(
  def: IntentDefinition,
  direction: TradeDirection,
  ctx: SignalEvaluation,
  exe: SignalEvaluation,
  location: LocationRead | null,
): IntentChecklistItem[] {
  const ctxBias = timeframeBias(ctx);
  const items: IntentChecklistItem[] = [
    {
      label: `${def.contextTimeframe} trend agrees`,
      done: direction !== "none" && ctxBias === direction,
      detail:
        ctxBias === "none"
          ? `The ${def.contextTimeframe} chart shows no clear trend (${human(ctx.regime)}).`
          : `The ${def.contextTimeframe} chart leans ${ctxBias} (${human(ctx.regime)}).`,
    },
  ];
  for (const component of exe.components) {
    if (component.status === "neutral") continue;
    items.push({
      label: component.name,
      done: component.status === "pass",
      detail: component.explanation,
    });
  }
  if (location) {
    items.push({
      label: "Price at a good entry location",
      done: location.grade !== "extended",
      detail: location.note,
    });
  }
  return items;
}

function buildTriggers(
  def: IntentDefinition,
  direction: TradeDirection,
  isCounterTrend: boolean,
  ctx: SignalEvaluation,
  exe: SignalEvaluation,
  location: LocationRead | null,
): string[] {
  const triggers: string[] = [];
  const a = exe.analytics;
  const exeTf = def.executionTimeframe;
  const ctxTf = def.contextTimeframe;

  if (direction === "long") {
    if (a.resistance !== null)
      triggers.push(`A ${exeTf} close above ${fmtPrice(a.resistance)} strengthens the long case.`);
    triggers.push(
      `A ${exeTf} close below ${fmtPrice(a.support ?? exe.risk.invalidation)} invalidates the long idea.`,
    );
  } else if (direction === "short") {
    if (a.support !== null)
      triggers.push(`A ${exeTf} close below ${fmtPrice(a.support)} strengthens the short case.`);
    triggers.push(
      `A ${exeTf} close above ${fmtPrice(a.resistance ?? exe.risk.invalidation)} invalidates the short idea.`,
    );
  } else {
    triggers.push(
      `A decisive ${exeTf} close above ${fmtPrice(a.resistance)} would create a long bias; below ${fmtPrice(a.support)}, a short bias.`,
    );
  }

  if (isCounterTrend) {
    const level = direction === "long" ? ctx.analytics.resistance : ctx.analytics.support;
    triggers.push(
      `If ${ctxTf} ${direction === "long" ? "reclaims" : "loses"} ${fmtPrice(level)}, this stops being counter-trend and can be traded at full size.`,
    );
  } else if (direction !== "none") {
    const level = direction === "long" ? ctx.analytics.support : ctx.analytics.resistance;
    triggers.push(
      `Today's answer flips if ${ctxTf} ${direction === "long" ? "breaks below" : "breaks above"} ${fmtPrice(level)}.`,
    );
  }

  // When price is extended, the pullback is the event to watch — surface it first.
  if (location && location.grade === "extended") {
    triggers.unshift(
      `A pullback toward ${fmtPrice(location.pullbackTarget)} would set up a cleaner ${direction} entry and can upgrade this to favored.`,
    );
  }

  return triggers.slice(0, 3);
}

export function assessIntent(
  def: IntentDefinition,
  evals: Partial<Record<TokenTimeframe, SignalEvaluation>>,
  zonesByTimeframe?: ZonesByTimeframe,
  perp?: PerpRead | null,
  sessionLevels?: SessionLevel[],
): IntentAssessment | null {
  const ctx = evals[def.contextTimeframe];
  const exe = evals[def.executionTimeframe];
  if (!ctx || !exe) return null;

  const ctxBias = timeframeBias(ctx);
  const exeBias = timeframeBias(exe);
  // Swing/position trades live or die by the higher-timeframe trend; scalps
  // and intraday trades are driven by the execution timeframe.
  const trendHorizon = def.intent === "swing" || def.intent === "position";
  const direction = trendHorizon ? ctxBias : exeBias !== "none" ? exeBias : ctxBias;
  const isCounterTrend = direction !== "none" && ctxBias !== "none" && direction !== ctxBias;
  const confirmed =
    (exe.decision === "buy-candidate" && direction === "long") ||
    (exe.decision === "short-candidate" && direction === "short");

  const label = def.label.toLowerCase();
  const exeTf = def.executionTimeframe;
  const ctxTf = def.contextTimeframe;
  const dirWord = direction === "long" ? "Long" : "Short";

  // Where price sits vs. structure for this direction — gates the favored
  // verdict, sharpened by fresh supply/demand zones and their cross-timeframe
  // confluence when available.
  const location = gradeLocation(
    exe,
    direction,
    zonesByTimeframe
      ? {
          execution: zonesByTimeframe[def.executionTimeframe] ?? [],
          context: zonesByTimeframe[def.contextTimeframe] ?? [],
        }
      : undefined,
    sessionLevels,
  );

  let verdict: IntentVerdict;
  let headline: string;
  let summary: string;

  if (direction === "none") {
    verdict = "avoid";
    headline = `No ${label} edge either way`;
    summary = trendHorizon
      ? `The ${ctxTf} chart has no established trend to lean on (${human(ctx.regime)}), and ${label} trades need one. Check back when a direction asserts itself.`
      : `Neither ${exeTf} nor ${ctxTf} shows a directional edge (${human(exe.regime)}). Forcing a ${label} here is a coin flip.`;
  } else if (!trendHorizon && exe.regime === "low-volatility" && !confirmed) {
    verdict = "avoid";
    headline = `Too quiet for ${label}s`;
    summary = `${exeTf} volatility is compressed — the moves on offer are too small to pay for a ${label}. Wait for range expansion before working this style.`;
  } else if (trendHorizon && exeBias !== "none" && exeBias !== direction) {
    verdict = "wait";
    headline = `${dirWord} ${label} — not yet`;
    summary = `The ${ctxTf} trend still points ${direction}, but ${exeTf} is currently moving against it. That's an entry-timing problem, not a broken thesis — let ${exeTf} turn back ${direction} before committing.`;
  } else if (isCounterTrend) {
    if (confirmed) {
      verdict = "caution";
      headline = `Counter-trend ${dirWord.toLowerCase()} ${label} — half size`;
      summary = `The ${exeTf} setup is valid (${human(exe.setupType)}), but it trades against the ${ctxTf} ${ctxBias === "short" ? "downtrend" : "uptrend"}. Acceptable as a quick ${label} at reduced size with a fast exit — not a trade to marry.`;
    } else if (exe.confidence >= 45) {
      verdict = "wait";
      headline = `Counter-trend ${dirWord.toLowerCase()} — needs confirmation`;
      summary = `A ${direction} ${label} against the ${ctxTf} trend is only worth taking fully confirmed. Wait for the unchecked items below before committing even reduced size.`;
    } else {
      verdict = "avoid";
      headline = `Skip the ${dirWord.toLowerCase()} ${label}`;
      summary = `This would be a weak, unconfirmed trade against the ${ctxTf} trend — the kind that bleeds accounts. Either trade ${ctxBias} with the trend or stand aside.`;
    }
  } else if (confirmed && location?.grade === "extended") {
    // Right direction, confirmed trigger — but price has run away from the
    // structure you'd enter against. That's an entry-location problem, not a
    // broken thesis, so it's a "wait for a pullback", not a "favored".
    verdict = "wait";
    headline = `${dirWord} ${label} — wait for a pullback`;
    summary = `${ctxTf} trend and ${exeTf} trigger agree on a ${direction} ${label}, but ${location.note} Right idea, wrong price — let price come back to structure before committing.`;
  } else if (confirmed) {
    verdict = "favored";
    headline = `${dirWord} ${label} favored`;
    summary = `${ctxTf} trend and ${exeTf} trigger agree, the ${exeTf} setup is confirmed (${human(exe.setupType)}), and ${location ? locationClause(location) : "the plan below is ready"}. Conditions currently pay this objective — execute the plan below.`;
  } else {
    verdict = "wait";
    headline = `${dirWord} ${label} — wait for the trigger`;
    summary = `Direction is right, but the ${exeTf} trigger isn't confirmed yet. "Not yet" — the unchecked confirmations below are exactly what's missing.`;
  }

  // Higher-timeframe liquidity overlay: the context timeframe's intact pools
  // mark where resting stops cluster on the horizon that governs this
  // objective. Entering right below one (long) or right above one (short) is
  // entering where raids reject, so a favored call trims to caution until the
  // level resolves. A pool merely on the path to target is the level to
  // expect a reaction at — noted, never a downgrade.
  let htfPoolTrim = false;
  const entryPrice = exe.analytics.lastClose;
  const opposingPools =
    direction === "none" || !entryPrice
      ? []
      : ctx.liquidity.filter(
          (pool) =>
            pool.intact &&
            (direction === "long"
              ? pool.side === "bsl" && pool.price > entryPrice
              : pool.side === "ssl" && pool.price < entryPrice),
        );
  const htfPool = opposingPools.reduce<LiquidityPool | null>(
    (best, pool) =>
      !best || Math.abs(pool.price - entryPrice) < Math.abs(best.price - entryPrice) ? pool : best,
    null,
  );
  const htfPoolProximate =
    htfPool !== null &&
    (Math.abs(htfPool.price - entryPrice) / entryPrice) * 100 <
      Math.max(0.35, (ctx.analytics.atrPercent ?? 1) * 0.55);
  if (htfPool) {
    const sideWord = htfPool.side === "bsl" ? "buy-side" : "sell-side";
    if (htfPoolProximate) {
      if (verdict === "favored") {
        verdict = "caution";
        htfPoolTrim = true;
        headline = `${dirWord} ${label} — into ${ctxTf} liquidity, trim size`;
      }
      summary = `${summary} Note: an intact ${ctxTf} ${sideWord} liquidity pool sits at ${fmtPrice(htfPool.price)}, right ${direction === "long" ? "above" : "below"} the entry — stop raids reject from these levels, so let it resolve before pressing.`;
    } else if (
      exe.risk.direction === direction &&
      (direction === "long" ? htfPool.price <= exe.risk.target1 : htfPool.price >= exe.risk.target1)
    ) {
      summary = `${summary} The first ${ctxTf} liquidity magnet on the path is ${fmtPrice(htfPool.price)} — expect a reaction there.`;
    }
  }

  // Perp positioning overlay: funding says which side is crowded, and joining
  // the crowd means buying into squeeze risk. When funding is with your
  // direction we caution (extreme funding downgrades a favored call to a
  // trimmed caution); when the crowd is offside, the squeeze runs your way —
  // noted as a tailwind but never used to upgrade.
  let crowdedTrim = false;
  if (perp && direction !== "none" && perp.fundingBias !== "neutral") {
    const crowdedWithYou =
      (direction === "long" && perp.fundingBias === "longs-crowded") ||
      (direction === "short" && perp.fundingBias === "shorts-crowded");
    const apr = `${perp.fundingAnnualizedPct > 0 ? "+" : ""}${perp.fundingAnnualizedPct.toFixed(0)}% APR`;
    if (crowdedWithYou && perp.fundingExtreme && verdict === "favored") {
      verdict = "caution";
      crowdedTrim = true;
      headline = `${dirWord} ${label} — crowded, trim size`;
      summary = `${summary} But funding is extreme with the crowd already ${direction} (${apr}): you'd be joining a crowded ${direction} into squeeze risk, so take it smaller with a tighter leash.`;
    } else if (crowdedWithYou) {
      summary = `${summary} Heads-up: funding leans ${direction} (${apr}), so positioning is a little crowded on your side — don't chase.`;
    } else {
      summary = `${summary} Tailwind: the crowd is offside (${apr}), and a squeeze would run in your favor.`;
    }
  }

  const sizeMultiplier = isCounterTrend || crowdedTrim || htfPoolTrim ? 0.5 : 1;
  const plan =
    verdict !== "avoid" && direction !== "none" && exe.risk.direction === direction
      ? scalePlan(exe.risk, sizeMultiplier)
      : null;

  const checklist = buildChecklist(def, direction, ctx, exe, location);
  if (htfPool) {
    const sideWord = htfPool.side === "bsl" ? "buy-side" : "sell-side";
    checklist.push({
      label: `No ${ctxTf} liquidity pool at the entry`,
      done: !htfPoolProximate,
      detail: htfPoolProximate
        ? `An intact ${ctxTf} ${sideWord} pool at ${fmtPrice(htfPool.price)} sits within reach of the entry — the level stop raids reject from.`
        : `The nearest intact ${ctxTf} ${sideWord} pool (${fmtPrice(htfPool.price)}) leaves the entry room to work.`,
    });
  }
  if (perp && direction !== "none" && perp.fundingBias !== "neutral") {
    const crowdedWithYou =
      (direction === "long" && perp.fundingBias === "longs-crowded") ||
      (direction === "short" && perp.fundingBias === "shorts-crowded");
    checklist.push({
      label: "Funding not crowded against the trade",
      done: !crowdedWithYou,
      detail: perp.note,
    });
  }

  return {
    intent: def.intent,
    definition: def,
    verdict,
    direction,
    isCounterTrend,
    sizeMultiplier,
    headline,
    summary,
    checklist,
    triggers: buildTriggers(def, direction, isCounterTrend, ctx, exe, location),
    confidence: exe.confidence,
    contextBias: ctxBias,
    executionBias: exeBias,
    context: ctx,
    execution: exe,
    plan,
    location,
  };
}

export function assessIntents(
  evals: Partial<Record<TokenTimeframe, SignalEvaluation>>,
  zonesByTimeframe?: ZonesByTimeframe,
  perp?: PerpRead | null,
  sessionLevels?: SessionLevel[],
): IntentAssessment[] {
  return INTENTS.map((def) =>
    assessIntent(def, evals, zonesByTimeframe, perp, sessionLevels),
  ).filter((a): a is IntentAssessment => a !== null);
}

// ---------------------------------------------------------------------------
// Market-wide outlook (dashboard): which objectives does today's tape favor?
// Derived from the snapshot regime rather than per-token evaluations, so it
// answers "what kind of trading pays today?" before a token is even picked.
// ---------------------------------------------------------------------------

export type IntentStance = "favored" | "selective" | "avoid";

export interface IntentOutlookEntry {
  intent: TradingIntent;
  label: string;
  stance: IntentStance;
  note: string;
}

export function marketIntentOutlook(
  regime: "Risk On" | "Risk Off" | "Neutral",
  trendStrength: "High" | "Medium" | "Low",
  volatility: "Low" | "Medium" | "High",
): IntentOutlookEntry[] {
  const trending = regime !== "Neutral" && trendStrength !== "Low";
  const side = regime === "Risk Off" ? "short side" : "long side";

  return [
    {
      intent: "scalp",
      label: "Scalps",
      stance: volatility === "Low" ? "avoid" : "favored",
      note:
        volatility === "Low"
          ? "Tape too quiet — fees eat the edge"
          : volatility === "High"
            ? "Plenty of movement; reduce size"
            : "Enough movement to work with",
    },
    {
      intent: "intraday",
      label: "Intraday",
      stance: volatility === "Low" && !trending ? "selective" : "favored",
      note: trending ? `Cleanest on the ${side}` : "Trade the range edges",
    },
    {
      intent: "swing",
      label: "Swings",
      stance: trending ? "favored" : "selective",
      note: trending ? `Trend supports the ${side}` : "No strong trend — be picky",
    },
    {
      intent: "position",
      label: "Trend",
      stance:
        trending && trendStrength === "High"
          ? "favored"
          : regime === "Neutral"
            ? "avoid"
            : "selective",
      note:
        trending && trendStrength === "High"
          ? `Ride the ${side}`
          : regime === "Neutral"
            ? "No regime to lean on"
            : "Wait for trend strength",
    },
  ];
}

/**
 * Two-to-three sentence market narrative for the token page — the story an
 * experienced trader would tell before making any recommendation: big picture
 * first, then the near-term tape, then what that combination rewards.
 */
export function describeMarketOutlook(
  evals: Partial<Record<TokenTimeframe, SignalEvaluation>>,
): string {
  const weekly = evals["1W"];
  const daily = evals["1D"];
  const fourH = evals["4H"];
  const hourly = evals["1H"];
  const sentences: string[] = [];

  // The narrative must be regime-led: describing a chart as "trending down"
  // and "leaning long" in the same breath reads as a contradiction, so the
  // big-picture bias comes from regimes first and setups only as a hint.
  const wr = weekly ? regimeBias(weekly.regime) : "none";
  const dr = daily ? regimeBias(daily.regime) : "none";
  const bigBias: TradeDirection =
    wr !== "none"
      ? wr
      : dr !== "none"
        ? dr
        : daily
          ? timeframeBias(daily)
          : weekly
            ? timeframeBias(weekly)
            : "none";

  // 1) Big picture: weekly + daily structure.
  if (weekly && daily) {
    if (wr !== "none" && wr === dr) {
      sentences.push(
        `The big picture is firmly ${wr === "long" ? "bullish" : "bearish"}: both the weekly and the daily are ${human(daily.regime)}.`,
      );
    } else if (wr === "none" && dr === "none") {
      sentences.push(
        `The big picture is directionless — the weekly is ${human(weekly.regime)} and the daily is ${human(daily.regime)}, with neither asserting a trend${bigBias !== "none" ? `, though daily structure hints ${bigBias}` : ""}.`,
      );
    } else if (wr !== "none" && dr !== "none") {
      sentences.push(
        `The big picture is split: the weekly is ${human(weekly.regime)} while the daily is ${human(daily.regime)}.`,
      );
    } else {
      const leadTf = wr !== "none" ? "weekly" : "daily";
      const leadEval = wr !== "none" ? weekly : daily;
      const otherTf = wr !== "none" ? "daily" : "weekly";
      const otherEval = wr !== "none" ? daily : weekly;
      sentences.push(
        `The big picture leans ${bigBias}: the ${leadTf} is ${human(leadEval.regime)} while the ${otherTf} is ${human(otherEval.regime)} inside that trend.`,
      );
    }
  }

  // 2) Near-term tape: 4H + 1H behavior.
  if (fourH && hourly) {
    const fBias = timeframeBias(fourH);
    const hBias = timeframeBias(hourly);
    const fPhrase = `the 4H is ${human(fourH.regime)}${fourH.direction !== "none" ? ` with a ${fourH.direction} setup forming` : ""}`;
    const hPhrase =
      hBias === "none"
        ? "the 1H is undecided"
        : fBias === "none"
          ? `the 1H is pushing ${hBias}`
          : hBias === fBias
            ? `the 1H agrees, pushing ${hBias}`
            : `the 1H pushes ${hBias} against it`;
    sentences.push(`Closer in, ${fPhrase} and ${hPhrase}.`);
  }

  // 3) What this combination rewards — uses the same biases as sentences 1-2.
  const nearBias: TradeDirection = hourly
    ? timeframeBias(hourly)
    : fourH
      ? timeframeBias(fourH)
      : "none";
  if (bigBias !== "none" && bigBias === nearBias) {
    sentences.push(
      "With the timeframes aligned, with-trend entries are the highest-quality trades on offer — counter-trend has no case today.",
    );
  } else if (bigBias !== "none" && nearBias !== "none") {
    sentences.push(
      `That conflict rewards quick counter-trend tactics at reduced size, while ${bigBias} entries at slower horizons should let the ${nearBias === "long" ? "bounce" : "pullback"} finish first.`,
    );
  } else if (bigBias === "none" && nearBias !== "none") {
    sentences.push(
      "Until a larger trend forms this tape pays short-horizon trades and punishes patience plays.",
    );
  } else if (bigBias !== "none") {
    sentences.push(
      `The ${bigBias === "long" ? "up" : "down"}trend is intact but intraday is churning — trend traders can work the ${bigBias} side, short-term traders still need a trigger.`,
    );
  } else {
    sentences.push(
      "With no timeframe asserting a direction, the highest-value action is setting alerts at the range edges and waiting for the break.",
    );
  }

  return sentences.slice(0, 3).join(" ");
}

// ---------------------------------------------------------------------------
// Today's edge (dashboard): which *style* of trading the market rewards now.
// ---------------------------------------------------------------------------

export interface MarketEdge {
  /** e.g. "Trend following · long side", "Mean reversion", "Breakout watch". */
  label: string;
  detail: string;
}

export function marketEdge(
  regime: "Risk On" | "Risk Off" | "Neutral",
  trendStrength: "High" | "Medium" | "Low",
  volatility: "Low" | "Medium" | "High",
): MarketEdge {
  const side = regime === "Risk Off" ? "short side" : "long side";
  if (regime !== "Neutral" && trendStrength === "High") {
    return {
      label: `Trend following · ${side}`,
      detail: `A high-strength ${regime} regime rewards riding the ${side} and punishes fading it — pullback entries in trend direction beat counter-trend fades.`,
    };
  }
  if (regime !== "Neutral" && trendStrength === "Medium") {
    return {
      label: `Pullback entries · ${side}`,
      detail: `The ${regime} lean is real but not yet powerful — buying dips${regime === "Risk Off" ? " (selling rips)" : ""} toward structure pays better than chasing extension.`,
    };
  }
  if (regime !== "Neutral") {
    return {
      label: "Selective mean reversion",
      detail: `The regime says ${regime} but trend strength is low — fade overextensions back to the mean rather than trusting follow-through.`,
    };
  }
  if (volatility === "Low") {
    return {
      label: "Breakout watch",
      detail:
        "No regime and a quiet tape — compression like this tends to resolve violently. The edge is preparing breakout orders at the range edges, not trading the chop inside them.",
    };
  }
  if (volatility === "High") {
    return {
      label: "Counter-trend scalps · reduced size",
      detail:
        "No directional regime but plenty of movement — quick fades of overextensions pay, while trend positions get whipsawed. Keep size down and exits fast.",
    };
  }
  return {
    label: "Mean reversion",
    detail:
      "A neutral regime with ordinary volatility rewards fading the range edges back to the middle — trend following has no tailwind today.",
  };
}

/** One-sentence synthesis of what the timeframes are collectively doing. */
export function describeMarketRead(
  evals: Partial<Record<TokenTimeframe, SignalEvaluation>>,
): string {
  const higher = evals["1D"] ?? evals["1W"];
  const lower = evals["1H"] ?? evals["15M"];
  if (!higher || !lower) return "";
  const hi = timeframeBias(higher);
  const lo = timeframeBias(lower);

  if (hi === "none" && lo === "none")
    return "No timeframe shows a clean directional edge right now — the market is undecided, and most objectives should wait.";
  if (hi === lo)
    return `Higher and lower timeframes both lean ${hi} — with-trend conditions. Trend-following objectives are in play; counter-trend trades have no case.`;
  if (hi !== "none" && lo === "none")
    return `The ${hi === "long" ? "up" : "down"}trend on the higher timeframes is intact while intraday churns sideways — trend traders can work the ${hi} side, but short-term traders still need a trigger.`;
  if (hi === "none")
    return `Intraday momentum leans ${lo}, but the higher timeframes have no established trend — this pays short-term objectives only, not swings.`;
  return `The higher-timeframe trend points ${hi} while intraday pushes ${lo} against it — a counter-trend move inside a larger ${hi === "short" ? "downtrend" : "uptrend"}. Quick counter-trend trades are possible at reduced size; ${hi} entries should wait for the ${lo === "long" ? "bounce" : "pullback"} to end.`;
}
