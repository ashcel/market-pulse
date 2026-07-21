// Deterministic front door for the "AI Desk Review" feature: it turns a
// trader's free-text idea into a structured `TradeIdea`, maps its horizon onto
// the engine's objective ladder, and — crucially — computes the *ceiling* the
// LLM reviewer is allowed to reach (`computeDeskAnchor`). Per EDR 0020 the AI
// narrates and gates but never originates a signal, and no AI output may loosen
// a deterministic rejection. This module is the mechanical enforcement of that
// rule: everything here is pure, framework-free, and client-safe (no server
// imports). The LLM is only ever a fallback parser or a constrained narrator.

import type { IntentAssessment, TradingIntent } from "@/lib/engine/intent";

/**
 * A trader's stated idea, normalized. Every field is nullable/optional because
 * the parser never guesses: a missing piece stays absent so the anchor can
 * refuse to review an under-specified idea rather than invent one.
 */
export interface TradeIdea {
  /** The original utterance, verbatim — the reviewer sees what the trader wrote. */
  rawText: string;
  symbol: string | null;
  direction: "long" | "short" | null;
  /** Parsed holding horizon in minutes (upper bound of any range). */
  horizonMinutes: number | null;
  /** The engine objective whose evidence best matches the horizon. */
  intent: TradingIntent | null;
  /** Caveat when the idea's horizon is finer than the engine's finest evidence. */
  horizonNote: string | null;
  entry?: number;
  stop?: number;
  target?: number;
}

// ── Fast-path parser ────────────────────────────────────────────────────────

const LONG_WORDS = ["long", "buy", "accumulate", "bullish"];
const SHORT_WORDS = ["short", "sell", "fade", "bearish"];

// Uppercase tokens that look like tickers but never are — units, order-type
// abbreviations, and the quote asset. `BTC`/`ETH`/etc. are intentionally NOT
// here: they are valid symbols.
const SYMBOL_STOPWORDS = new Set([
  "USDT",
  "USD",
  "USDC",
  "SL",
  "TP",
  "RR",
  "R",
  "I",
  "A",
  "AT",
  "TO",
  "THE",
  "AND",
  "OR",
  "IF",
  "IN",
  "ON",
  "IT",
  "IS",
  "BE",
  "OK",
  "NO",
  "GO",
  "AM",
  "PM",
  "EUR",
  "ETF",
  "CEO",
  "ATH",
  "ATL",
  "DCA",
  "FOMO",
  "FUD",
]);

/** Index of the earliest whole-word match of any keyword, or -1. */
function earliestWord(text: string, words: string[]): number {
  let best = -1;
  for (const w of words) {
    const m = new RegExp(`\\b${w}\\b`, "i").exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

function parseDirection(text: string): "long" | "short" | null {
  const longAt = earliestWord(text, LONG_WORDS);
  const shortAt = earliestWord(text, SHORT_WORDS);
  if (longAt === -1 && shortAt === -1) return null;
  if (shortAt === -1) return "long";
  if (longAt === -1) return "short";
  // Both present — the one the trader said first sets the intent.
  return longAt <= shortAt ? "long" : "short";
}

function parseSymbol(text: string): string | null {
  // 1) Explicit $TICKER is unambiguous and wins.
  const tagged = /\$([A-Za-z][A-Za-z0-9]{1,5})\b/.exec(text);
  if (tagged) return tagged[1].toUpperCase();

  // 2) Otherwise the first standalone 2–6 char all-caps token that isn't a
  //    known non-symbol word.
  const re = /\b([A-Z][A-Z0-9]{1,5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[1];
    if (!SYMBOL_STOPWORDS.has(token)) return token;
  }
  return null;
}

/** Ordered horizon patterns — first match wins, most specific first. */
const HORIZON_RULES: Array<{ re: RegExp; minutes: (m: RegExpMatchArray) => number }> = [
  // Ranges like "5-15 minutes" / "5 to 15 mins" → upper bound.
  {
    re: /(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:minutes?|mins?)\b/i,
    minutes: (m) => Number(m[2]),
  },
  {
    re: /(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:hours?|hrs?|h)\b/i,
    minutes: (m) => Number(m[2]) * 60,
  },
  {
    re: /(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:days?|d)\b/i,
    minutes: (m) => Number(m[2]) * 1440,
  },
  { re: /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/i, minutes: (m) => Number(m[1]) },
  { re: /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, minutes: (m) => Number(m[1]) * 60 },
  { re: /(\d+(?:\.\d+)?)\s*(?:weeks?|wks?|w)\b/i, minutes: (m) => Number(m[1]) * 10080 },
  { re: /(\d+(?:\.\d+)?)\s*(?:days?|d)\b/i, minutes: (m) => Number(m[1]) * 1440 },
  { re: /\b(?:next|an?|the|this|coming)\s+hour\b/i, minutes: () => 60 },
  { re: /\bcouple\s+(?:of\s+)?hours\b/i, minutes: () => 120 },
  { re: /\bfew\s+hours\b/i, minutes: () => 180 },
  { re: /\b(?:today|intraday|this\s+session)\b/i, minutes: () => 720 },
  { re: /\bcouple\s+(?:of\s+)?days\b/i, minutes: () => 2880 },
  { re: /\bfew\s+days\b/i, minutes: () => 4320 },
  { re: /\b(?:this|next|the|coming)\s+week\b/i, minutes: () => 7200 },
  { re: /\b(?:this|next|the|coming)\s+month\b/i, minutes: () => 43200 },
];

function parseHorizon(text: string): number | null {
  for (const rule of HORIZON_RULES) {
    const m = text.match(rule.re);
    if (m) {
      const mins = rule.minutes(m);
      if (Number.isFinite(mins) && mins > 0) return mins;
    }
  }
  return null;
}

function firstNumber(text: string, re: RegExp): number | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Regex fast path: parse an idea without an LLM round-trip. Missing pieces stay
 * null/undefined — the parser never guesses. `buildIntentParsePrompt` +
 * `parseIntentParseResponse` are the LLM fallback for utterances this can't
 * crack.
 */
export function parseTradeIdeaFast(text: string): TradeIdea {
  const horizonMinutes = parseHorizon(text);
  const { intent, note } = mapHorizonToIntent(horizonMinutes);
  const idea: TradeIdea = {
    rawText: text,
    symbol: parseSymbol(text),
    direction: parseDirection(text),
    horizonMinutes,
    intent,
    horizonNote: note,
  };
  const entry = firstNumber(
    text,
    /\bentry\s*(?:price|zone|around|near|at|@|:|=)?\s*\$?(\d+(?:\.\d+)?)/i,
  );
  const stop = firstNumber(
    text,
    /\b(?:stop(?:\s*loss)?|sl)\s*(?:at|@|:|=|around|near)?\s*\$?(\d+(?:\.\d+)?)/i,
  );
  const target = firstNumber(
    text,
    /\b(?:target|tp|take\s*profit)\s*(?:at|@|:|=|around|near)?\s*\$?(\d+(?:\.\d+)?)/i,
  );
  if (entry !== undefined) idea.entry = entry;
  if (stop !== undefined) idea.stop = stop;
  if (target !== undefined) idea.target = target;
  return idea;
}

/** Note shown when a sub-15m idea is graded on the engine's finest (15M) read. */
export const SUB_GRANULARITY_NOTE =
  "The idea's horizon is finer than the engine's finest evidence (15M candles), so this scalp read is the nearest available instrument, not a sub-15m signal.";

/**
 * The engine's finest evidence is the 15M candle. A horizon at or below it
 * (≤15 minutes) is finer than any signal we can produce, so its scalp read is a
 * proxy carrying `SUB_GRANULARITY_NOTE`. Boundary is ≤15 (not <15) so the
 * canonical "5-15 minutes" idea — whose upper bound is exactly 15 — is treated
 * as sub-granularity rather than a clean 15M signal.
 */
export const SUB_GRANULARITY_MAX_MINUTES = 15;

/**
 * Map a horizon (minutes) onto the engine's objective ladder. Boundaries: ≤15
 * and ≤120 both land on scalp (the sub-granularity case carries a caveat),
 * ≤1440 intraday, ≤10080 swing, else position.
 */
export function mapHorizonToIntent(minutes: number | null): {
  intent: TradingIntent | null;
  note: string | null;
} {
  if (minutes === null) return { intent: null, note: null };
  if (minutes <= SUB_GRANULARITY_MAX_MINUTES)
    return { intent: "scalp", note: SUB_GRANULARITY_NOTE };
  if (minutes <= 120) return { intent: "scalp", note: null };
  if (minutes <= 1440) return { intent: "intraday", note: null };
  if (minutes <= 10080) return { intent: "swing", note: null };
  return { intent: "position", note: null };
}

// ── LLM fallback parser ─────────────────────────────────────────────────────

/**
 * System prompt for an LLM that extracts the same `TradeIdea` fields as the
 * fast path, for utterances the regexes can't crack. Strict JSON out, nulls for
 * unknowns, no prose. `intent`/`horizonNote` are derived deterministically from
 * `horizonMinutes` afterwards (`parseIntentParseResponse`), never trusted from
 * the model.
 */
export function buildIntentParsePrompt(text: string): string {
  return [
    "You extract structured fields from a crypto trader's free-text trade idea.",
    "Return STRICT JSON only — no markdown, no code fences, no prose — with exactly these keys:",
    '{"symbol": string|null, "direction": "long"|"short"|null, "horizonMinutes": number|null, "entry": number|null, "stop": number|null, "target": number|null}',
    "",
    "Rules:",
    "- symbol: the base ticker in UPPERCASE (e.g. BTC, DEXE), without the $ or the /USDT quote. null if none stated.",
    '- direction: "long" for buy/accumulate/bullish, "short" for sell/fade/bearish. null if not stated.',
    '- horizonMinutes: the trade\'s intended holding time as a number of minutes (use the UPPER bound of any range). Examples: "5-15 minutes" → 15, "next hour" → 60, "a few hours" → 180, "today" → 720, "this week" → 7200, "2 weeks" → 20160. null if not stated.',
    "- entry/stop/target: numeric price levels if the trader named them, else null.",
    "- Never guess. If a field isn't clearly stated, use null.",
    "",
    "Examples:",
    'Input: "thinking about longing SOL over the next few hours, entry near 142, stop 138"',
    'Output: {"symbol":"SOL","direction":"long","horizonMinutes":180,"entry":142,"stop":138,"target":null}',
    "",
    'Input: "I want to short DEXE for the next 5-15 minutes"',
    'Output: {"symbol":"DEXE","direction":"short","horizonMinutes":15,"entry":null,"stop":null,"target":null}',
    "",
    'Input: "is it a good time to buy?"',
    'Output: {"symbol":null,"direction":"long","horizonMinutes":null,"entry":null,"stop":null,"target":null}',
    "",
    "Now extract from this input:",
    JSON.stringify(text),
  ].join("\n");
}

function stripFences(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").trim();
}

function asNumberOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Tolerantly parse an LLM parser response back into a `TradeIdea`. Strips code
 * fences, extracts the first JSON object, validates each field's type, then
 * fills `intent`/`horizonNote` deterministically from `horizonMinutes`. Returns
 * null only when no JSON object can be recovered at all.
 */
export function parseIntentParseResponse(raw: string, originalText: string): TradeIdea | null {
  const cleaned = stripFences(raw);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const symbol =
    typeof parsed.symbol === "string" && parsed.symbol.trim() !== ""
      ? parsed.symbol.trim().toUpperCase()
      : null;
  const direction =
    parsed.direction === "long" || parsed.direction === "short" ? parsed.direction : null;
  const horizonMinutes =
    typeof parsed.horizonMinutes === "number" &&
    Number.isFinite(parsed.horizonMinutes) &&
    parsed.horizonMinutes > 0
      ? parsed.horizonMinutes
      : null;
  const { intent, note } = mapHorizonToIntent(horizonMinutes);

  const idea: TradeIdea = {
    rawText: originalText,
    symbol,
    direction,
    horizonMinutes,
    intent,
    horizonNote: note,
  };
  const entry = asNumberOrUndef(parsed.entry);
  const stop = asNumberOrUndef(parsed.stop);
  const target = asNumberOrUndef(parsed.target);
  if (entry !== undefined) idea.entry = entry;
  if (stop !== undefined) idea.stop = stop;
  if (target !== undefined) idea.target = target;
  return idea;
}

// ── Deterministic desk anchor ───────────────────────────────────────────────

/**
 * The desk's verdict vocabulary. `out-of-scope` = the idea isn't reviewable
 * against the engine's objective; `no-evidence` = the idea is too under-
 * specified to review at all. Both are floor outcomes (permissiveness 0).
 */
export type DeskOutcome = "approve" | "conditional" | "reject" | "out-of-scope" | "no-evidence";

/**
 * Total order on how *permissive* an outcome is. The LLM may confirm or move
 * toward reject, never past the anchor ceiling — enforced by comparing these
 * ranks (`parseDeskReview` clamps anything more permissive than the anchor).
 */
export const OUTCOME_PERMISSIVENESS: Record<DeskOutcome, number> = {
  approve: 3,
  conditional: 2,
  reject: 1,
  "out-of-scope": 0,
  "no-evidence": 0,
};

/**
 * The deterministic ceiling for a desk review. `maxOutcome` is the most
 * permissive verdict the LLM may reach; `forced` means it must output EXACTLY
 * that (no-evidence, out-of-scope, and hard rejects), leaving the model only
 * the job of explaining why and what would change it.
 */
export interface DeskAnchor {
  maxOutcome: DeskOutcome;
  forced: boolean;
  reasons: string[];
}

function capAt(current: DeskOutcome, ceiling: DeskOutcome): DeskOutcome {
  // Cap never raises: only lowers when `current` is more permissive.
  return OUTCOME_PERMISSIVENESS[current] > OUTCOME_PERMISSIVENESS[ceiling] ? ceiling : current;
}

/**
 * Compute the deterministic ceiling for reviewing `idea` against the engine's
 * `assessment` for the matching objective. This is the mechanical guarantee
 * that the AI can never upgrade a trade past what the engine's evidence
 * supports (EDR 0020): the LLM receives this anchor and is clamped to it.
 */
export function computeDeskAnchor(
  idea: TradeIdea,
  assessment: IntentAssessment | null,
): DeskAnchor {
  const reasons: string[] = [];

  // No reviewable evidence: name exactly what's missing.
  if (!assessment || !idea.symbol || !idea.direction) {
    const missing: string[] = [];
    if (!idea.symbol) missing.push("no symbol was identified in the idea");
    if (!idea.direction) missing.push("no trade direction (long/short) was stated");
    if (!assessment) missing.push("the engine has no objective assessment for this idea's horizon");
    reasons.push(
      `Cannot review: ${missing.join("; ")}. Ask the trader for the missing piece rather than guessing.`,
    );
    return { maxOutcome: "no-evidence", forced: true, reasons };
  }

  const engineDir = assessment.direction; // "long" | "short" | "none"
  const matches = engineDir === idea.direction;
  const opposite = (engineDir === "long" || engineDir === "short") && engineDir !== idea.direction;
  const verdict = assessment.verdict;

  let maxOutcome: DeskOutcome;
  let forced: boolean;

  if (opposite && verdict !== "avoid") {
    // Engine has a directional read opposite the trader on a live objective:
    // this is a hard reject regardless of the verdict's strength.
    maxOutcome = "reject";
    forced = true;
    reasons.push(
      `The engine's ${assessment.definition.label} read favors the ${engineDir} side, opposite the idea's ${idea.direction}. Trading against a same-timeframe engine bias is a hard reject.`,
    );
  } else if (verdict === "favored") {
    if (matches) {
      maxOutcome = "approve";
      forced = false;
      reasons.push(
        `The engine's ${assessment.definition.label} objective is FAVORED ${engineDir} and agrees with the idea — approval is available if the evidence holds up under challenge.`,
      );
    } else {
      // engineDir "none" under a favored verdict shouldn't occur, but degrade safely.
      maxOutcome = "conditional";
      forced = false;
      reasons.push(
        `The engine is favored but without a directional match to the idea — conditional at best.`,
      );
    }
  } else if (verdict === "caution") {
    maxOutcome = "conditional";
    forced = false;
    reasons.push(
      matches
        ? `The engine's ${assessment.definition.label} read is CAUTION ${engineDir} (counter-trend / reduced size). The idea can be conditional at best — smaller size, tighter leash.`
        : `The engine's ${assessment.definition.label} read is only CAUTION and offers no clean directional agreement — conditional at best.`,
    );
  } else if (verdict === "wait") {
    // Right idea, confirmation missing: conditional ceiling regardless of match.
    maxOutcome = "conditional";
    forced = false;
    reasons.push(
      `The engine's ${assessment.definition.label} read is WAIT — the direction may be right but the trigger isn't confirmed yet. Conditional at best, pending the missing confirmation.`,
    );
  } else {
    // verdict === "avoid"
    maxOutcome = "reject";
    forced = true;
    reasons.push(
      `The engine's ${assessment.definition.label} read is AVOID — there is no edge for this objective. Reject.`,
    );
  }

  // Sub-granularity ideas (≤15m) are at or finer than the engine's finest
  // evidence (15M); the scalp read is a proxy, not a signal, so never let it
  // clear "conditional".
  if (idea.horizonMinutes !== null && idea.horizonMinutes <= SUB_GRANULARITY_MAX_MINUTES) {
    const capped = capAt(maxOutcome, "conditional");
    if (capped !== maxOutcome) {
      maxOutcome = capped;
      reasons.push(
        `The idea's ${idea.horizonMinutes}-minute horizon is finer than the engine's 15M finest evidence, so the ceiling is capped at conditional — the read is a proxy, not a sub-15m signal.`,
      );
    } else {
      reasons.push(
        `The idea's ${idea.horizonMinutes}-minute horizon is finer than the engine's 15M finest evidence; treat the scalp read as a proxy, not a sub-15m signal.`,
      );
    }
  }

  return { maxOutcome, forced, reasons };
}
