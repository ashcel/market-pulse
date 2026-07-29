import { Link } from "@tanstack/react-router";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Lock,
  MoveRight,
  ShieldAlert,
  Target,
  TrendingDown,
  TrendingUp,
  Waves,
  Waypoints,
} from "lucide-react";

import { ConfidenceGauge } from "@/components/features/confidence-gauge";
import { IqCard } from "@/components/features/iq-card";
import { Badge } from "@/components/ui/badge";
import type { Candle } from "@/lib/engine/types";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import type { IntentAssessment } from "@/lib/engine/intent";
import { currentSweep, gradeRisk } from "@/lib/engine/quant";
import type { RiskRewardPlan, SignalEvaluation } from "@/lib/engine/quant";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import { formatMoney } from "@/lib/utils/format";
import { usePreferencesStore } from "@/stores/preferences";
import { cn } from "@/lib/utils";
import { InfoHint, humanSetup } from "@/components/features/token/shared";

export interface MarketPhase {
  phase: "No Edge" | "Standby" | "Transition" | "Opportunity";
  label: string;
  context: string;
}

export const BIAS_ADJ: Record<"long" | "short", string> = { long: "bullish", short: "bearish" };

/**
 * Presentation-only read of "why this verdict" as a phase + one-line context
 * — pure derivation from fields the engine already computes (contextBias,
 * isCounterTrend, setupType). Adds no new decision logic and changes no
 * verdict, so it carries no version-bump obligation (CLAUDE.md "Engine
 * change discipline").
 */
export function describeMarketPhase(assessment: DisplayIntentAssessment): MarketPhase {
  const { direction, contextBias, verdict, isCounterTrend, execution, definition } = assessment;
  const ctxTf = definition.contextTimeframe;
  const exeTf = definition.executionTimeframe;

  if (direction === "none") {
    return {
      phase: "No Edge",
      label: "No directional edge",
      context: `Neither ${ctxTf} nor ${exeTf} leans clearly either way — nothing to react to yet.`,
    };
  }

  if (isCounterTrend) {
    const moveWord = direction === "long" ? "Bounce" : "Pullback";
    const zoneWord = direction === "long" ? "supply" : "demand";
    return {
      phase: "Transition",
      label: `Counter-trend ${moveWord}`,
      context: `Higher timeframe remains ${BIAS_ADJ[contextBias === "none" ? (direction === "long" ? "short" : "long") : contextBias]}. Short-term momentum has shifted ${BIAS_ADJ[direction]} after a ${humanSetup(execution.setupType).toLowerCase()}. Expect a ${moveWord.toLowerCase()} into ${zoneWord} before trend continuation.`,
    };
  }

  if (verdict === "favored" || verdict === "caution") {
    return {
      phase: "Opportunity",
      label: "Trend continuation",
      context: `${ctxTf} and ${exeTf} agree ${direction} — with-trend conditions, no conflicting higher-timeframe pull to fade.`,
    };
  }

  return {
    phase: "Standby",
    label: "Waiting for trigger",
    context: `${ctxTf} leans ${direction}, but ${exeTf} hasn't confirmed the trigger yet — same direction, not tradable at current price.`,
  };
}

/** Overview-tab version: phase + label only, no prose — matches the tab's "decide in seconds" rule. Full one-line explanation lives in `MarketPhaseNote` on the Why tab. */
export function MarketPhaseBadge({ assessment }: { assessment: DisplayIntentAssessment }) {
  const phase = describeMarketPhase(assessment);
  return (
    <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      Market phase: <span className="text-foreground">{phase.phase}</span> · {phase.label}
    </p>
  );
}

/** Names the phase behind the verdict (e.g. "Transition — Counter-trend Pullback") and explains it in one line, so a counter-trend call reads as a legible market state rather than a bare badge. */
export function MarketPhaseNote({ assessment }: { assessment: DisplayIntentAssessment }) {
  const phase = describeMarketPhase(assessment);
  return (
    <div className="mt-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Market phase: <span className="text-foreground">{phase.phase}</span> · {phase.label}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{phase.context}</p>
    </div>
  );
}
export type GlanceTone = "bullish" | "bearish" | "warning" | "info" | "neutral" | "muted";

export const GLANCE_TONE_TEXT: Record<GlanceTone, string> = {
  bullish: "text-bullish",
  bearish: "text-bearish",
  warning: "text-warning",
  info: "text-info",
  neutral: "text-foreground",
  muted: "text-muted-foreground",
};

export interface GlanceChip {
  icon: typeof Activity;
  label: string;
  value: string;
  sub: string;
  tone: GlanceTone;
}

/**
 * The five reads a trader needs before anything else, each straight from the
 * engine: HTF trend (the active objective's context lean), the chart
 * timeframe's regime + setup, its swing structure with the live BOS/CHoCH,
 * the liquidity state (recent sweep, else intact pools), and where the active
 * objective's entry sits relative to structure.
 */
export function buildGlanceChips(
  assessment: DisplayIntentAssessment | null,
  evaluation: SignalEvaluation,
  timeframe: TokenTimeframe,
  candles: Candle[],
): GlanceChip[] {
  const chips: GlanceChip[] = [];

  // 1 — Higher-timeframe trend, from the objective's reconciled context lean.
  if (assessment) {
    const bias = assessment.contextBias;
    chips.push({
      icon: bias === "long" ? TrendingUp : bias === "short" ? TrendingDown : MoveRight,
      label: `${assessment.definition.contextTimeframe} trend`,
      value: bias === "long" ? "Bullish" : bias === "short" ? "Bearish" : "Neutral",
      sub: assessment.context.regime.replaceAll("-", " "),
      tone: bias === "long" ? "bullish" : bias === "short" ? "bearish" : "neutral",
    });
  } else {
    chips.push({
      icon: MoveRight,
      label: "HTF trend",
      value: "—",
      sub: "assessing…",
      tone: "muted",
    });
  }

  // 2 — The chart timeframe's regime, with the classified setup as detail.
  const regimeTone: GlanceTone =
    evaluation.regime === "trending-up"
      ? "bullish"
      : evaluation.regime === "trending-down"
        ? "bearish"
        : evaluation.regime === "high-volatility" || evaluation.regime === "choppy"
          ? "warning"
          : evaluation.regime === "breakout-compression" || evaluation.regime === "mean-reversion"
            ? "info"
            : "neutral";
  chips.push({
    icon: Activity,
    label: `${timeframe} state`,
    value: evaluation.regime.replaceAll("-", " "),
    sub:
      evaluation.setupType === "no-clear-setup"
        ? "no clear setup"
        : humanSetup(evaluation.setupType),
    tone: regimeTone,
  });

  // 3 — Swing structure, with the break event only while it is still live.
  const s = evaluation.structure;
  const eventCurrent =
    s.event && s.eventSwing && (s.eventSwing === s.lastHigh || s.eventSwing === s.lastLow);
  const eventSub = eventCurrent
    ? s.event === "bos"
      ? "BOS — trend confirmed"
      : "CHoCH — reversal risk"
    : `last ${s.lastHigh?.label ?? "–"} high · ${s.lastLow?.label ?? "–"} low`;
  chips.push({
    icon: Waypoints,
    label: "Structure",
    value: s.trend === "uptrend" ? "HH / HL" : s.trend === "downtrend" ? "LH / LL" : "Range",
    sub: eventSub,
    tone: s.trend === "uptrend" ? "bullish" : s.trend === "downtrend" ? "bearish" : "neutral",
  });

  // 4 — Liquidity: a live sweep is the headline; otherwise the intact pools.
  // Recency is the engine's own rule (currentSweep), so this chip headlines a
  // raid exactly while setup classification still treats it as a trigger.
  const sweeps = evaluation.liquiditySweeps;
  const recentSweep = currentSweep(sweeps, candles);
  if (recentSweep) {
    chips.push({
      icon: Waves,
      label: "Liquidity",
      value: recentSweep.side === "ssl" ? "SSL swept" : "BSL swept",
      sub: recentSweep.side === "ssl" ? "stop hunt below — fuel up" : "stop hunt above — fuel down",
      tone: recentSweep.side === "ssl" ? "bullish" : "bearish",
    });
  } else {
    const sweptPools = new Set(sweeps.map((sweep) => sweep.pool));
    const intact = evaluation.liquidity.filter((pool) => pool.intact && !sweptPools.has(pool));
    const bsl = intact.filter((pool) => pool.side === "bsl").length;
    const ssl = intact.length - bsl;
    const parts = [bsl > 0 ? `${bsl} BSL` : null, ssl > 0 ? `${ssl} SSL` : null].filter(Boolean);
    chips.push({
      icon: Waves,
      label: "Liquidity",
      value: parts.length ? parts.join(" · ") : "None mapped",
      sub: parts.length ? "intact pools — price magnets" : "no equal highs/lows",
      tone: parts.length ? "info" : "muted",
    });
  }

  // 5 — Entry location for the active objective's direction.
  const location = assessment?.location ?? null;
  if (location) {
    chips.push({
      icon: Target,
      label: "Entry location",
      value: location.label,
      sub:
        location.confluence === "multi-timeframe"
          ? "MTF zone confluence"
          : location.confluence === "single-timeframe"
            ? "zone-backed"
            : `${Math.round(Math.min(1, Math.max(0, location.rangePosition)) * 100)}% of S→R range`,
      tone:
        location.grade === "at-structure"
          ? "bullish"
          : location.grade === "extended"
            ? "warning"
            : "info",
    });
  } else {
    chips.push({
      icon: Target,
      label: "Entry location",
      value: "—",
      sub: "no directional read",
      tone: "muted",
    });
  }

  return chips;
}

/**
 * Glanceable market read under the chart — five chips a trader can absorb in
 * seconds, mirroring the same engine state the verdict panel reasons from.
 */
export function GlanceStrip({
  assessment,
  evaluation,
  timeframe,
  candles,
}: {
  assessment: DisplayIntentAssessment | null;
  evaluation: SignalEvaluation;
  timeframe: TokenTimeframe;
  candles: Candle[];
}) {
  const chips = buildGlanceChips(assessment, evaluation, timeframe, candles);
  return (
    <IqCard
      padded={false}
      className="grid shrink-0 grid-cols-2 gap-px rounded-none border-0 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-border"
    >
      {chips.map((chip) => (
        <div key={chip.label} className="flex min-w-0 items-center gap-2.5 px-3 py-2">
          <chip.icon className={cn("h-4 w-4 shrink-0", GLANCE_TONE_TEXT[chip.tone])} />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              {chip.label}
            </div>
            <div
              className={cn(
                "truncate text-xs font-bold capitalize",
                GLANCE_TONE_TEXT[chip.tone === "muted" ? "muted" : chip.tone],
              )}
            >
              {chip.value}
            </div>
            <div className="truncate text-[9px] text-muted-foreground">{chip.sub}</div>
          </div>
        </div>
      ))}
    </IqCard>
  );
}
export function verdictTone(assessment: IntentAssessment): string {
  if (assessment.verdict === "favored")
    return assessment.direction === "short"
      ? "border-bearish/30 bg-bearish-soft"
      : "border-bullish/30 bg-bullish-soft";
  if (assessment.verdict === "caution") return "border-warning/30 bg-warning-soft";
  if (assessment.verdict === "wait") return "border-info/30 bg-info-soft";
  return "border-border bg-muted/40";
}
/**
 * The five-second read: one big colored word for the verdict. Favored/caution
 * lead with the direction itself; wait and avoid lead with the answer. The
 * badges keep the counter-trend/half-size nuance the old text badge carried.
 */
export function VerdictHero({ assessment }: { assessment: DisplayIntentAssessment }) {
  const { verdict, direction, isCounterTrend, sizeMultiplier } = assessment;
  const DirIcon =
    direction === "long" ? TrendingUp : direction === "short" ? TrendingDown : MoveRight;
  const word =
    verdict === "favored" || verdict === "caution"
      ? direction.toUpperCase()
      : verdict === "wait"
        ? direction === "none"
          ? "NOT YET"
          : `${direction.toUpperCase()} · NOT YET`
        : "STAND ASIDE";
  const text =
    verdict === "favored"
      ? direction === "short"
        ? "text-bearish"
        : "text-bullish"
      : verdict === "caution"
        ? "text-warning"
        : verdict === "wait"
          ? "text-info"
          : "text-muted-foreground";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DirIcon className={cn("h-6 w-6 shrink-0", text)} />
      <span className={cn("text-2xl font-bold leading-none tracking-tight", text)}>{word}</span>
      {sizeMultiplier < 1 && (
        <Badge variant="outline" className="border-warning/30 bg-warning-soft text-warning">
          ½ size
        </Badge>
      )}
      {isCounterTrend && (
        <Badge variant="outline" className="border-warning/30 bg-warning-soft text-warning">
          counter-trend
        </Badge>
      )}
    </div>
  );
}
/**
 * The engine's confidence, presented as what it actually is: the strength of
 * the *directional read*, not permission to act. The number is never rescaled
 * or capped — hysteresis and the tracker store this same raw value — but the
 * ring takes the verdict's color and the hint states the verdict's meaning,
 * so "NOT YET beside a high number" reads as "strong read, entry conditions
 * not yet satisfied" rather than a contradiction.
 */
export function ReadStrengthGauge({ assessment }: { assessment: DisplayIntentAssessment }) {
  const { verdict, direction } = assessment;
  const tone =
    verdict === "favored"
      ? direction === "short"
        ? "var(--color-bearish)"
        : "var(--color-bullish)"
      : verdict === "caution"
        ? "var(--color-warning)"
        : verdict === "wait"
          ? "var(--color-info)"
          : "var(--color-muted-foreground)";
  const meaning =
    verdict === "favored"
      ? "Here the read and the entry conditions agree — the setup is confirmed."
      : verdict === "caution"
        ? "The read is tradable but fights the higher timeframe — hence reduced size."
        : verdict === "wait"
          ? "A strong number beside 'not yet' is not a contradiction: the engine is confident about the direction while the entry conditions are still unsatisfied — the checklist shows exactly what's missing."
          : "Whatever its strength, this market doesn't pay your objective — stand aside.";
  return (
    <div className="flex shrink-0 flex-col items-center">
      <ConfidenceGauge value={assessment.confidence} size={60} tone={tone} />
      <span className="mt-0.5 flex items-center gap-1 text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">
        Read strength
        <InfoHint
          text={`How strongly the engine's evidence points in one direction — signal strength, not a win probability. The verdict word is the action. ${meaning}`}
        />
      </span>
    </div>
  );
}
/** R:R to each target and risk level — the ref-style stat row. */
export function EdgeStats({ assessment }: { assessment: DisplayIntentAssessment }) {
  const risk = assessment.execution.risk;
  const atr = assessment.execution.analytics.atrPercent;
  // The engine owns the risk formula (ATR bands + counter-trend bump).
  const grade = gradeRisk(atr, assessment.isCounterTrend);
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <GlanceStat
        label="R:R to T1"
        value={`${risk.rewardRisk1}R`}
        sub="target 1 vs. stop"
        tone={risk.rewardRisk1 >= 1 ? "bullish" : undefined}
      />
      <GlanceStat
        label="R:R to T2"
        value={`${risk.rewardRisk2}R`}
        sub="target 2 vs. stop"
        tone={risk.rewardRisk2 >= 1 ? "bullish" : undefined}
      />
      <GlanceStat
        label="Risk level"
        value={grade ? grade[0].toUpperCase() + grade.slice(1) : "n/a"}
        sub={
          [atr !== null ? `ATR ${atr}%` : null, assessment.isCounterTrend ? "counter-trend" : null]
            .filter(Boolean)
            .join(" · ") || "no ATR read"
        }
        tone={grade === "high" ? "bearish" : grade === "medium" ? "warning" : undefined}
      />
    </div>
  );
}
export function GlanceStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "bullish" | "bearish" | "warning";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-2">
      <div className="truncate text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 truncate text-sm font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
      <div className="truncate text-[9px] text-muted-foreground">{sub}</div>
    </div>
  );
}
/** One trade-plan level, ref-style: colored dot, label, monospaced price. */
export function PlanRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="num truncate text-[11px] font-semibold">{value}</span>
    </div>
  );
}
/**
 * Mini vertical map of the plan: green reward band up to T1 (fainter on to
 * T2), blue entry pocket, red risk band to the stop — the same bands the
 * chart's trade zones paint, at a glance next to the numbers. Orientation
 * follows the actual prices, so shorts render inverted automatically.
 */
export function PlanLadder({ plan }: { plan: RiskRewardPlan }) {
  const prices = [plan.stop, plan.entry, plan.entryLow, plan.entryHigh, plan.target1, plan.target2];
  if (prices.some((value) => !Number.isFinite(value))) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (!(max > min)) return null;
  const pct = (value: number) => ((max - value) / (max - min)) * 100;
  const band = (a: number, b: number) => ({
    top: `${Math.min(pct(a), pct(b))}%`,
    height: `${Math.max(1.5, Math.abs(pct(a) - pct(b)))}%`,
  });
  return (
    <div
      aria-hidden
      className="relative w-9 shrink-0 self-stretch overflow-hidden rounded-md border border-border bg-surface"
    >
      <div
        className="absolute inset-x-1 rounded-sm bg-bullish/10"
        style={band(plan.target1, plan.target2)}
      />
      <div
        className="absolute inset-x-1 rounded-sm bg-bullish/25"
        style={band(plan.entry, plan.target1)}
      />
      <div
        className="absolute inset-x-1 rounded-sm bg-bearish/25"
        style={band(plan.entry, plan.stop)}
      />
      <div
        className="absolute inset-x-0 rounded-sm border border-info/50 bg-info/30"
        style={band(plan.entryLow, plan.entryHigh)}
      />
    </div>
  );
}
export function VerdictDot({ assessment }: { assessment: IntentAssessment | undefined }) {
  return (
    <span
      className={cn(
        "h-1 w-1 rounded-full",
        !assessment && "bg-muted-foreground/30",
        assessment?.verdict === "favored" &&
          (assessment.direction === "short" ? "bg-bearish" : "bg-bullish"),
        assessment?.verdict === "caution" && "bg-warning",
        assessment?.verdict === "wait" && "bg-info",
        assessment?.verdict === "avoid" && "bg-muted-foreground/30",
      )}
    />
  );
}
/**
 * The Overview's one-line status: what stands between you and the trade (or
 * what pays instead), without the prose — the Why tab carries the full
 * reasoning. This is the "not-yet / wrong-strategy / what-flips-it" answer
 * compressed to a glance.
 */
export function DecisionBanner({
  active,
  assessments,
}: {
  active: DisplayIntentAssessment;
  assessments: DisplayIntentAssessment[];
}) {
  const done = active.checklist.filter((item) => item.done).length;
  const total = active.checklist.length;
  const next = active.checklist.find((item) => !item.done);
  const heldFor = active.hold.isHeld ? formatHeldFor(active.hold.heldAt) : null;

  let tone: string;
  let Icon: typeof CheckCircle2;
  let headline: string;
  let detail: string | null;
  if (active.verdict === "favored") {
    tone = "border-bullish/30 bg-bullish-soft text-bullish";
    Icon = CheckCircle2;
    headline = `Setup confirmed — ${done}/${total} checks in`;
    detail = next ? `Open: ${next.label}` : null;
  } else if (active.verdict === "caution") {
    tone = "border-warning/30 bg-warning-soft text-warning";
    Icon = ShieldAlert;
    headline = active.isCounterTrend ? "Counter-trend — tradable at ½ size" : "Tradable at ½ size";
    detail = next
      ? `${total - done} check${total - done === 1 ? "" : "s"} open — next: ${next.label}`
      : null;
  } else if (active.verdict === "wait") {
    tone = "border-info/30 bg-info-soft text-info";
    Icon = CircleAlert;
    const extended = active.location?.grade === "extended";
    headline = extended
      ? `No entry at current price — ${total - done} of ${total} confirmations missing`
      : `Not yet — ${total - done} of ${total} confirmations missing`;
    detail = next
      ? `Next: ${next.label}${
          active.plan
            ? ""
            : extended
              ? " · plan appears once price returns to the zone"
              : " · plan appears once the trigger confirms"
        }`
      : null;
  } else {
    tone = "border-border bg-muted/40 text-muted-foreground";
    Icon = CircleX;
    headline = "Doesn't pay this objective";
    const alt = assessments.find(
      (a) =>
        a.intent !== active.intent &&
        (a.verdict === "favored" || a.verdict === "caution") &&
        a.plan !== null,
    );
    detail = alt
      ? `${alt.definition.label} has a ${alt.direction} setup on the ${alt.definition.executionTimeframe}`
      : "No other objective is payable — flat is a position";
  }

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border p-2.5", tone)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[11px] font-semibold">{headline}</div>
        {detail && <div className="mt-0.5 truncate text-[10px] opacity-80">{detail}</div>}
      </div>
      {heldFor && (
        <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold uppercase tracking-wider opacity-80">
          <Lock className="h-3 w-3" />
          held {heldFor}
        </span>
      )}
    </div>
  );
}
// When there is nothing to execute for the chosen objective, say what would
// pay instead — "no trade" should read as "wrong objective", not "go away".
export function planEmptyMessage(
  active: IntentAssessment,
  assessments: IntentAssessment[],
): string {
  const alt = assessments.find(
    (a) =>
      a.intent !== active.intent &&
      (a.verdict === "favored" || a.verdict === "caution") &&
      a.plan !== null,
  );
  const extended = active.verdict === "wait" && active.location?.grade === "extended";
  const base = extended
    ? active.anticipatoryPlan
      ? `No ${active.direction} at current price — price is extended into structure. If it ${active.direction === "long" ? "pulls back" : "rallies"} to ${formatMoney(active.anticipatoryPlan.zone.priceLow)}–${formatMoney(active.anticipatoryPlan.zone.priceHigh)}, a ${active.direction} becomes viable (see the conditional setup below).`
      : `No ${active.direction} at current price — price is extended into structure. Wait for a pullback.`
    : active.verdict === "wait"
      ? "No entry yet — the plan appears the moment the trigger confirms."
      : "This market doesn't pay your objective right now.";
  if (alt) {
    return `${base} If you want action today, the ${alt.definition.label.toLowerCase()} objective has a ${alt.verdict === "caution" ? "reduced-size " : ""}${alt.direction} setup on the ${alt.definition.executionTimeframe}.`;
  }
  return `${base} No other objective has a payable setup either — flat is a position.`;
}
export function SizingNote({ multiplier = 1 }: { multiplier?: number }) {
  const risk = usePreferencesStore((s) => s.risk);
  return (
    <p className="text-[10px] leading-relaxed text-muted-foreground">
      Sized for a ${risk.accountSize.toLocaleString()} account risking {risk.maxRiskPerTradePercent}
      % per trade ({risk.stopMethod.replaceAll("-", " ")} stop).
      {multiplier < 1 && (
        <span className="font-semibold text-warning">
          {" "}
          Shown at half size — counter-trend for this objective.
        </span>
      )}{" "}
      <Link to="/settings" className="font-semibold text-info hover:underline">
        Adjust →
      </Link>
    </p>
  );
}
export function formatHeldFor(heldAt: string): string {
  const ms = Date.now() - Date.parse(heldAt);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
export function HoldNote({ hold }: { hold: DisplayIntentAssessment["hold"] }) {
  if (hold.isHeld) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
        <Lock className="h-3 w-3 shrink-0" />
        <span>
          Verdict held {formatHeldFor(hold.heldAt)} — it stands until a trigger below fires, so it
          won't flicker between refreshes.
        </span>
      </div>
    );
  }
  if (hold.adoptedBecause) {
    return (
      <div className="mt-1.5 flex items-start gap-1.5 text-[10px] font-medium text-info">
        <MoveRight className="mt-0.5 h-3 w-3 shrink-0" />
        <span>Updated: {hold.adoptedBecause}</span>
      </div>
    );
  }
  return null;
}
