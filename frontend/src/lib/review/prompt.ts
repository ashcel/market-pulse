// Prompt builder + response parser for the Trade Review AI pipeline. Ported
// from tradereview's lib/services/review-engine.ts — the buildSystemPrompt /
// buildTradeContextPrompt / parseAndValidateReview trio only. getModel() and
// callOpenRouter() are intentionally NOT ported: this app is BYOK, so the
// model comes from the user's ai-settings (resolveAiConfig) and the LLM call
// goes through src/lib/ai/client.ts (runAiAnalyst), never through this
// server. Archetype narrative and tradereview-only trade columns (firstSl,
// the SL-slippage behavioral narrative, replay MFE/MAE) were dropped —
// reduced fidelity is fine for this port.

import type {
  CandleContext,
  ReviewMode,
  ReviewTrade,
  SeverityTier,
  TradeReview,
  TradeReviewSection,
  TradeReviewSectionType,
  UserBaseline,
  AnnotationPosition,
  AnnotationCategory,
} from "./types";
import type { MetricKey, TradeForensics } from "@/hooks/useForensics";

export function buildSystemPrompt(mode: ReviewMode, severityTier: SeverityTier): string {
  const base = `You are the AI engine behind Market Pulse's Trade Review — a brutally honest trading coach for crypto traders.

Your job is to analyze a single closed trade and generate a structured behavioral review.

## What you evaluate:
- Execution quality (entry timing, exit timing)
- Risk management (leverage sizing, stop loss discipline, position sizing)
- Emotional behavior (revenge patterns, overconfidence, fear exits)
- Market structure alignment (was entry logical given candle context?)
- Trade discipline (did behavior match a sound process?)

## What you are NOT:
- A signal provider
- A price predictor
- A hype chatbot
- A financial advisor

## Coaching philosophy:
- Evaluate process over outcome. A losing trade can be well-executed. A profitable trade can be a mess.
- Data first. Let numbers speak before making behavioral claims.
- Never affirm bad behavior to soften the blow.
- Be specific. Generic feedback ("work on discipline") is useless.
- Short is powerful. Dense, specific reviews beat long generic ones every time.

## Chart Annotations (max 5, included in JSON output):
Generate 2–5 chart annotations pinned to specific trade moments. Rules:
- Prioritize: biggest mistake, biggest strength, most important opportunity.
- Title: max 12 words. Message: max 20 words. No generic advice ("improve discipline" is not allowed — cite specific numbers).
- Supported categories: "risk" (high leverage, counter-trend, FOMO, oversized), "strength" (liquidity sweep, trend confirmation, good SL placement, strong exit), "opportunity" (partial TP zone, breakeven, re-entry), "execution" (good risk management, SL locked, excellent position mgmt).
- Use price field to anchor the annotation to the relevant price level on the chart.
- Each annotation needs a "position" field — the semantic moment in the trade. Allowed values and when to use them:
  • "entry"  → entry candle: counter-trend, FOMO, overleverage at open, good entry, liquidity sweep at entry
  • "early"  → first 25% of trade: early SL placement, initial momentum read, early risk signals
  • "mid"    → middle of trade: breakeven opportunity, mid-trade SL adjustment, max adverse excursion
  • "late"   → last 25% of trade: SL locked to profit, partial TP zone, late-trade momentum
  • "exit"   → exit candle: exit quality. CRITICAL — label the exit correctly:
      - closeTrigger = "tp_hit" → title MUST say "TP Hit" or "Take Profit Hit"
      - closeTrigger = "sl_hit" AND pnl > 0 → title MUST say "SL Locked In" or "Stop Hit in Profit" (NOT "TP Hit")
      - closeTrigger = "sl_hit" AND pnl < 0 → title MUST say "Stopped Out" or "Stop Loss Hit"
      - closeTrigger = "manual_market" → title MUST say "Manual Exit" or "Early Exit"
      - closeTrigger = "liquidation" → title MUST say "Liquidated"
- Every annotation MUST use a DIFFERENT position. Do NOT use the same position twice.
- The frontend uses "position" to place each annotation on the correct candle automatically.

## Tone by severity_tier:
- MILD: Curious, Socratic — "Interesting choice here — walk me through your thinking."
- MODERATE: Firm — state the pattern clearly, no hedging, not harsh.
- HIGH: Direct — name exactly what happened, no softening language.
- CRITICAL: No filter — this is account-ruin territory, say it plainly.

## Grading Rubric (grade = PROCESS quality, NOT PnL outcome):
A+ → Textbook execution. Entry confirmed, SL set, sized correctly, exit disciplined. Can still be a losing trade.
A  → Strong process with minor imperfections. 1 small mistake, well-contained.
B  → Reasonable setup, some execution gaps. Showed discipline in parts.
C  → Setup had merit but execution was weak. Multiple mistakes, got lucky or unlucky.
D  → Poor process. Emotional signals present. Risk not managed properly.
F  → Process failure. Revenge trade, no SL, overleverage, liquidation, or multiple CRITICAL behavioral tags.

## Scoring Rubric (1–10, process quality only, independent of PnL outcome):
- setup_quality_score: Was the entry logical? Structure confirmed, context valid, not chasing?
- execution_score: Did entry/exit timing match the plan?
- discipline_score: Was the plan followed? No SL moves, no rage exits, no position size deviation?
- risk_management_score: Was leverage appropriate? SL set? Position sized for account?

## Output format:
Return ONLY valid JSON. No markdown fences, no preamble, no text outside the JSON object.
The JSON must match this exact structure:
{
  "severity_tier": "MILD|MODERATE|HIGH|CRITICAL",
  "review_mode": "normal|strict",
  "one_liner": "string — max 15 words",
  "headline": "string — max 12 words",
  "grade": "A+|A|B|C|D|F",
  "setup_quality_score": 1-10,
  "execution_score": 1-10,
  "discipline_score": 1-10,
  "risk_management_score": 1-10,
  "sections": [
    { "type": "what_happened", "title": "What Happened", "content": "string" },
    { "type": "what_went_well", "title": "What Went Well", "content": "string or null" },
    { "type": "risks_weaknesses", "title": "Risks & Weaknesses", "content": "string" },
    { "type": "the_moment", "title": "The Moment That Defined This Trade", "content": "string" }
  ],
  "suggestion": "string — one actionable improvement, max 2 sentences",
  "closing_question": "string — reflective question ending with ?",
  "coaching_note": "string — what the ideal version of this trader would have done",
  "data_flags": ["string array of specific anomalies"],
  "annotations": [
    {
      "id": "ann-1",
      "position": "entry",
      "price": 43250.5,
      "category": "risk",
      "title": "Counter-trend Entry",
      "message": "Entered against higher timeframe momentum."
    }
  ]
}
Note: price is optional. Include 2–5 annotations. Each must have a unique position.`;

  const modeModifier =
    mode === "strict"
      ? `\n\nYou are in STRICT MODE. Prioritize execution quality and discipline above all. Call out every mistake explicitly. Do not soften critique. Still remain professional — never insulting.`
      : `\n\nYou are in NORMAL MODE. Balance critique with acknowledgment of what worked. Every review should have at least one genuine strength identified.`;

  return base + modeModifier;
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs > 0) return `${hrs}h ${rem}m`;
  return `${mins}m`;
}

/** Metric key → the label and formatter the memo is allowed to quote. */
const FORENSIC_LABELS: Partial<Record<MetricKey, string>> = {
  mae_percent: "MAE (% of entry)",
  mae_r: "MAE (R)",
  mfe_percent: "MFE (% of entry)",
  mfe_r: "MFE (R)",
  exit_efficiency: "Exit efficiency (% of favorable excursion captured)",
  slippage_adverse: "Adverse stop slippage (quote)",
  slippage_adverse_r: "Adverse stop slippage (R)",
  violation_depth_r: "Traded past the stop (R)",
  realized_r: "Realized (R)",
  reentry_latency_seconds: "Re-entry latency (seconds)",
  sizing_notional: "Position notional (quote)",
  sizing_size_ratio: "Size vs. your median (×)",
};

/**
 * The measurements block. Available rows carry their number; unavailable rows
 * carry their reason so the model sees the absence explicitly rather than
 * inferring silence. Anything not listed here is ungrounded and the backend
 * groundedness check will strip it (backend/app/review/groundedness.py).
 */
function buildForensicsBlock(forensics: TradeForensics | null): string {
  if (!forensics) {
    return `## FORENSIC MEASUREMENTS
Not computed for this trade. Do NOT state any excursion, efficiency, R-multiple, slippage, latency, or sizing number.`;
  }
  const lines = Object.entries(FORENSIC_LABELS).map(([key, label]) => {
    const metric = forensics.metrics[key as MetricKey];
    if (!metric) return `- ${label}: not measured`;
    return metric.available && metric.value !== null
      ? `- ${label}: ${metric.value.toFixed(4)}${metric.flags.length ? ` [${metric.flags.join(", ")}]` : ""}`
      : `- ${label}: UNAVAILABLE (${metric.reason ?? "not measured"}) — do not state a value`;
  });
  return `## FORENSIC MEASUREMENTS (deterministic, from exchange rows + klines)
Measured on ${forensics.kline_interval ?? "unknown"} candles${
    forensics.boundary_inflation_bound_pct !== null
      ? `, boundary error bound ±${forensics.boundary_inflation_bound_pct.toFixed(2)}%`
      : ""
  }. Stop evidence: ${forensics.stop_evidence}.
${lines.join("\n")}

RULES FOR THESE NUMBERS:
- Quote only the values listed above. Never compute, estimate, or infer a
  number that is marked UNAVAILABLE — say what is missing and why instead.
- An R-multiple exists only where a stop is evidenced on the exchange row.
- Never present any of these as a probability, a win rate, or an edge.`;
}

export function buildTradeContextPrompt(params: {
  trade: ReviewTrade;
  baseline: UserBaseline;
  candleContext: CandleContext;
  severityTier: SeverityTier;
  mode: ReviewMode;
  previousTrade: ReviewTrade | null;
  forensics: TradeForensics | null;
}): string {
  const { trade, baseline, candleContext, severityTier, mode, previousTrade, forensics } = params;

  const pnl = trade.realized_pnl;
  const roi = trade.roi_percent ?? 0;
  const { leverage, entry_price: entryPrice, exit_price: exitPrice } = trade;

  const durationMs =
    trade.opened_at && trade.closed_at
      ? new Date(trade.closed_at).getTime() - new Date(trade.opened_at).getTime()
      : 0;

  const isLiquidated =
    roi <= -100 || (pnl < 0 && Math.abs(roi) > 99) || trade.close_trigger === "liquidation";
  const slSet = trade.stop_loss !== null && trade.stop_loss > 0;
  const tpSet = trade.take_profit !== null && trade.take_profit > 0;

  const prevResult = previousTrade ? (previousTrade.realized_pnl > 0 ? "win" : "loss") : null;

  const timeSincePrev =
    previousTrade?.closed_at && trade.opened_at
      ? new Date(trade.opened_at).getTime() - new Date(previousTrade.closed_at).getTime()
      : null;

  const closeTrigger = trade.close_trigger;

  let behavioralAnalysisNote = "";
  if (closeTrigger === "manual_market" && pnl < 0) {
    behavioralAnalysisNote += `\n- Position closed manually at a loss — not via stop loss. This might indicate fear exiting, panicking, or deviation from a planned stop loss.`;
  } else if (closeTrigger === "liquidation") {
    behavioralAnalysisNote += `\n- POSITION WAS LIQUIDATED. Complete process, sizing, and risk management failure. Auto-bump severity to CRITICAL.`;
  }

  return `Analyze this closed trade and generate a behavioral review.

## TRADER PROFILE
- Avg Leverage (baseline): ${baseline.avgLeverage.toFixed(1)}x
- Avg Trade Duration (baseline): ${formatDuration(baseline.avgDurationMs)}
- Overall Win Rate: ${baseline.winRate.toFixed(1)}%

## TRADE DATA
- Pair: ${trade.symbol}
- Direction: ${trade.side}
- Trade Open Time: ${trade.opened_at || "Unknown"}
- Trade Close Time: ${trade.closed_at || "Unknown"}
- Entry Price: $${entryPrice.toLocaleString()}
- Exit Price: ${exitPrice > 0 ? `$${exitPrice.toLocaleString()}` : "Liquidated"}
- Leverage Used: ${leverage}x
- Trade Duration: ${durationMs > 0 ? formatDuration(durationMs) : "Unknown"}
- ROI: ${roi.toFixed(2)}%
- PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD
- Fees: ${trade.fees.toFixed(4)} USD
- Stop Loss Set: ${slSet ? `Yes (${trade.stop_loss})` : "No"}
- Take Profit Set: ${tpSet ? `Yes (${trade.take_profit})` : "No"}
- Close Trigger: ${closeTrigger ? closeTrigger.toUpperCase() : "Unknown"}
- Liquidated: ${isLiquidated ? "Yes" : "No"}
${behavioralAnalysisNote ? `\n## BEHAVIORAL SIGNALS DETECTED\n${behavioralAnalysisNote}\n` : ""}

${buildForensicsBlock(forensics)}

## CANDLE CONTEXT (preprocessed)
- Trend: ${candleContext.trend_summary}
- Volatility: ${candleContext.volatility_summary}
- Structure: ${candleContext.structure_summary}
- Liquidity Sweep Detected: ${candleContext.sweep_detected ? `Yes (${candleContext.sweep_direction})` : "No"}
- Entry Context: ${candleContext.entry_context}
- Exit Context: ${candleContext.exit_context}

## SEQUENCE CONTEXT
- Previous Trade Result: ${prevResult ? `${prevResult} (${previousTrade!.realized_pnl.toFixed(2)} USD)` : "No previous trade data"}
- Time Since Previous Trade: ${timeSincePrev != null ? formatDuration(timeSincePrev) : "N/A"}
- Streak Note: ${previousTrade ? (prevResult === "loss" && timeSincePrev != null && timeSincePrev < 5 * 60 * 1000 ? "Entered within 5 minutes of a loss" : "Normal timing") : "No context"}

## SEVERITY TIER (pre-computed): ${severityTier}
## REVIEW MODE: ${mode.toUpperCase()}

Generate the behavioral review JSON now.`;
}

// ============================================================
// Response Parser + Validator
// ============================================================

const EXPECTED_SECTION_TYPES: TradeReviewSectionType[] = [
  "what_happened",
  "what_went_well",
  "risks_weaknesses",
  "the_moment",
];

const SECTION_DEFAULT_TITLE: Record<TradeReviewSectionType, string> = {
  what_happened: "What Happened",
  what_went_well: "What Went Well",
  risks_weaknesses: "Risks & Weaknesses",
  the_moment: "The Moment That Defined This Trade",
};

const SECTION_DEFAULT_CONTENT: Record<TradeReviewSectionType, string | null> = {
  what_happened: "Trade executed according to strategy parameters.",
  what_went_well: null,
  risks_weaknesses: "Risk parameters were set within bounds.",
  the_moment: "Trade reached completion target.",
};

const VALID_POSITIONS: AnnotationPosition[] = ["entry", "early", "mid", "late", "exit"];
const VALID_CATEGORIES: AnnotationCategory[] = ["risk", "strength", "opportunity", "execution"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Escape bare control characters inside a JSON-ish string (avoids a no-control-regex lint trip). */
function escapeControlChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code <= 0x1f || code === 0x7f)
      out += ""; // strip other control chars
    else out += ch;
  }
  return out;
}

function parseJsonLoosely(raw: string): unknown {
  // Strip markdown fences if the model adds them.
  const clean = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    // Try to extract a JSON object from surrounding text.
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Could not extract JSON from LLM response");
    try {
      return JSON.parse(match[0]);
    } catch (innerErr) {
      // Attempt to fix common LLM JSON issues: trailing commas, unescaped
      // control characters inside strings.
      const withoutTrailingCommas = match[0].replace(/,\s*([\]}])/g, "$1");
      const fixedJson = escapeControlChars(withoutTrailingCommas);
      try {
        return JSON.parse(fixedJson);
      } catch {
        throw new Error(
          `Could not parse LLM JSON response: ${innerErr instanceof Error ? innerErr.message : "Unknown parse error"}`,
        );
      }
    }
  }
}

export function parseAndValidateReview(raw: string): TradeReview {
  const parsedUnknown = parseJsonLoosely(raw);
  const parsed: Record<string, unknown> = isRecord(parsedUnknown) ? parsedUnknown : {};

  // Populate defaults for missing fields instead of throwing, to keep review
  // generation resilient to imperfect model output.
  const severity_tier: SeverityTier = isSeverityTier(parsed.severity_tier)
    ? parsed.severity_tier
    : "MILD";
  const review_mode: ReviewMode = parsed.review_mode === "strict" ? "strict" : "normal";
  const one_liner = typeof parsed.one_liner === "string" ? parsed.one_liner : "Analysis complete.";
  const headline = typeof parsed.headline === "string" ? parsed.headline : "Trade Analyzed";
  const grade = isTradeGrade(parsed.grade) ? parsed.grade : "B";
  const suggestion =
    typeof parsed.suggestion === "string"
      ? parsed.suggestion
      : "Review trade setup and continue following your checklist.";
  const closing_question =
    typeof parsed.closing_question === "string"
      ? parsed.closing_question
      : "What is your main takeaway from this trade?";
  const coaching_note =
    typeof parsed.coaching_note === "string"
      ? parsed.coaching_note
      : "Ensure consistency in execution going forward.";
  const data_flags = Array.isArray(parsed.data_flags)
    ? parsed.data_flags.filter((f): f is string => typeof f === "string")
    : [];
  const unsupported_claims = Array.isArray(parsed.unsupported_claims)
    ? parsed.unsupported_claims.filter((claim): claim is string => typeof claim === "string")
    : [];

  const scoreOrUndefined = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  // Normalize sections — ensure all expected types are present.
  const rawSections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const sections: TradeReviewSection[] = EXPECTED_SECTION_TYPES.map((type) => {
    const existing = rawSections.find(
      (s): s is Record<string, unknown> => isRecord(s) && s.type === type,
    );
    if (existing) {
      return {
        type,
        title: typeof existing.title === "string" ? existing.title : SECTION_DEFAULT_TITLE[type],
        content:
          typeof existing.content === "string" ? existing.content : SECTION_DEFAULT_CONTENT[type],
      };
    }
    return { type, title: SECTION_DEFAULT_TITLE[type], content: SECTION_DEFAULT_CONTENT[type] };
  });

  // Normalize annotations — max 5, required fields only, unique positions.
  const rawAnnotations = Array.isArray(parsed.annotations) ? parsed.annotations : [];
  const usedPositions = new Set<AnnotationPosition>();
  const annotations = rawAnnotations
    .filter((a): a is Record<string, unknown> => isRecord(a) && !!a.category && !!a.title)
    .slice(0, 5)
    .map((a, i) => {
      let position: AnnotationPosition = VALID_POSITIONS.includes(a.position as AnnotationPosition)
        ? (a.position as AnnotationPosition)
        : (VALID_POSITIONS[i] ?? "mid");
      if (usedPositions.has(position)) {
        position = VALID_POSITIONS.find((p) => !usedPositions.has(p)) ?? VALID_POSITIONS[i % 5];
      }
      usedPositions.add(position);
      return {
        id: typeof a.id === "string" ? a.id : `ann-${i + 1}`,
        position,
        price: typeof a.price === "number" ? a.price : undefined,
        category: VALID_CATEGORIES.includes(a.category as AnnotationCategory)
          ? (a.category as AnnotationCategory)
          : "execution",
        title: String(a.title).slice(0, 80),
        message: String(a.message ?? "").slice(0, 150),
      };
    });

  return {
    severity_tier,
    review_mode,
    one_liner,
    headline,
    grade,
    setup_quality_score: scoreOrUndefined(parsed.setup_quality_score),
    execution_score: scoreOrUndefined(parsed.execution_score),
    discipline_score: scoreOrUndefined(parsed.discipline_score),
    risk_management_score: scoreOrUndefined(parsed.risk_management_score),
    sections,
    suggestion,
    closing_question,
    coaching_note,
    data_flags,
    unsupported_claims,
    annotations,
  };
}

function isSeverityTier(value: unknown): value is SeverityTier {
  return value === "MILD" || value === "MODERATE" || value === "HIGH" || value === "CRITICAL";
}

function isTradeGrade(value: unknown): value is TradeReview["grade"] {
  return (
    value === "A+" ||
    value === "A" ||
    value === "B" ||
    value === "C" ||
    value === "D" ||
    value === "F"
  );
}
