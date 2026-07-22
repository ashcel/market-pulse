// The constrained LLM narrator for an AI Desk Review. `buildDeskSystem` frames
// the model as a senior institutional risk-desk reviewer whose ceiling was
// already set deterministically (`DeskAnchor`); `parseDeskReview` then MECHANI-
// CALLY enforces that ceiling on whatever the model returns — clamping over-
// permissive outcomes, forcing forced anchors, dropping citations that don't
// exist in the pack, and flagging numbers the pack can't back. Per EDR 0020 no
// AI output may loosen a deterministic rejection; this file is where that
// promise is kept in code, not in the prompt. Pure + client-safe.

import {
  OUTCOME_PERMISSIVENESS,
  type DeskAnchor,
  type DeskOutcome,
  type TradeIdea,
} from "./trade-idea";
import { extractNumbers, renderEvidencePack, type EvidencePack } from "./evidence-pack";

export interface DeskChallenge {
  claim: string;
  citations: string[];
}

export interface DeskReviewResult {
  outcome: DeskOutcome;
  thesis: string;
  challenges: DeskChallenge[];
  conditions: string[];
  /** The price/structure event that kills the idea; null when unstated. */
  invalidation: string | null;
  watch: string[];
  confidence: number | null;
  /** Distinct pack IDs actually cited (after dropping unknown ones). */
  citedIds: string[];
  /** Every enforcement action taken on the raw response — surfaced in the UI. */
  warnings: string[];
  raw: string;
}

const VALID_OUTCOMES: readonly DeskOutcome[] = [
  "approve",
  "conditional",
  "reject",
  "out-of-scope",
  "no-evidence",
];

function ideaLine(idea: TradeIdea): string {
  const bits: string[] = [];
  bits.push(`symbol ${idea.symbol ?? "unspecified"}`);
  bits.push(`direction ${idea.direction ?? "unspecified"}`);
  if (idea.horizonMinutes !== null) bits.push(`horizon ~${idea.horizonMinutes} minutes`);
  if (idea.intent) bits.push(`nearest engine objective: ${idea.intent}`);
  if (idea.entry !== undefined) bits.push(`entry ${idea.entry}`);
  if (idea.stop !== undefined) bits.push(`stop ${idea.stop}`);
  if (idea.target !== undefined) bits.push(`target ${idea.target}`);
  return bits.join(", ");
}

/**
 * Build the desk-reviewer system prompt: the trader's idea restated, the
 * deterministic ceiling and why it was set, the evidence pack, hard grounding
 * rules, an anti-sycophancy clause, and a strict-JSON output contract. The
 * model may confirm the ceiling or move toward reject — never past it.
 */
export function buildDeskSystem(idea: TradeIdea, anchor: DeskAnchor, pack: EvidencePack): string {
  const parts: string[] = [
    "You are a senior institutional risk-desk reviewer. A trader has brought you a trade idea. Your job is to pressure-test it against the desk's deterministic engine evidence — NOT to cheerlead, and NOT to originate a new idea of your own.",
    "",
    "## The trader's stated idea",
    `- ${idea.rawText}`,
    `- Parsed: ${ideaLine(idea)}`,
    "",
    "## The desk's deterministic ceiling",
    `The engine's deterministic ceiling for this idea is "${anchor.maxOutcome}". You may confirm it or move it toward reject; you may NEVER exceed it.`,
  ];

  if (anchor.forced) {
    parts.push(
      `This ceiling is FORCED: your "outcome" MUST be exactly "${anchor.maxOutcome}". Your job is only to explain why, and to state precisely what would have to change for a different verdict — you may not choose any other outcome.`,
    );
  } else {
    parts.push(
      `Outcomes in order of permissiveness: approve > conditional > reject > out-of-scope/no-evidence. You may output "${anchor.maxOutcome}" or anything less permissive, never more.`,
    );
  }

  parts.push("", "Why the ceiling is set here:");
  for (const reason of anchor.reasons) parts.push(`- ${reason}`);

  parts.push("", renderEvidencePack(pack));

  parts.push(
    "",
    "## Hard grounding rules",
    "- Use ONLY the evidence pack above. You have no market feed of your own. Never invent prices, levels, zones, structure, or news.",
    '- Every claim in `challenges` MUST carry one or more citation IDs (e.g. "S1", "R2") that appear in the evidence pack. A claim you cannot cite does not belong in the review.',
    "- Never state a number that isn't in the pack. If the pack doesn't contain a figure, don't assert it.",
    "- The trader's conviction is NOT evidence. If the pack contradicts the idea, say so plainly and let the outcome reflect it — a confident trader with the evidence against them still gets a reject.",
    "- `invalidation` is the concrete price/structure event that kills this idea. `watch` is what to monitor over the idea's horizon.",
  );

  if (pack.items.some((it) => it.topic === "econ")) {
    parts.push(
      "- Economic-calendar entries in the pack (ID prefix \"M\") are SCHEDULING FACTS only — impact/forecast/previous exactly as given, market-wide and not specific to this idea's symbol. Never treat one as a directional signal; only cite it for timing risk against the idea's horizon.",
    );
  }

  parts.push(
    "",
    "## Output contract",
    "Return STRICT JSON only — no markdown, no code fences, no prose outside the JSON object — with exactly this schema:",
    '{"outcome": "approve"|"conditional"|"reject"|"out-of-scope"|"no-evidence", "thesis": string, "challenges": [{"claim": string, "citations": ["S1"]}], "conditions": [string], "invalidation": string|null, "watch": [string], "confidence": number}',
    '- "outcome": your verdict, bound by the ceiling above.',
    '- "thesis": 1–3 sentences on your overall read.',
    '- "challenges": the strongest points against the idea, each citing pack IDs.',
    '- "conditions": what would make this tradeable; REQUIRED non-empty when "outcome" is "conditional".',
    '- "confidence": an integer 0–100 for how strongly the evidence supports your outcome.',
  );

  return parts.join("\n");
}

// ── Enforcement ─────────────────────────────────────────────────────────────

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Best-effort salvage of a `"thesis": "..."` field from JSON too broken to parse (e.g. truncated by a token limit), so the UI shows the model's actual read instead of a raw JSON dump. */
function salvageThesis(raw: string): string | null {
  const match = raw.match(/"thesis"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  const thesis = match[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
  return thesis === "" ? null : thesis;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
}

/** Count significant digits so small integer counts ("2 touches") skip the audit. */
function significantDigits(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  const digits = Math.abs(n).toString().replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length;
}

/**
 * Enforce the deterministic ceiling on a raw LLM desk-review response. Tolerant
 * JSON extraction, then five mechanical guards (in order): outcome validity,
 * anchor clamp/force, citation validation against the pack, a numeric-claim
 * audit, and confidence-range clamping. Every intervention is recorded in
 * `warnings`. A total parse failure degrades to the anchor's ceiling with the
 * raw text as the thesis.
 */
export function parseDeskReview(
  rawText: string,
  anchor: DeskAnchor,
  pack: EvidencePack,
): DeskReviewResult {
  const warnings: string[] = [];
  const parsed = extractJsonObject(rawText);

  if (!parsed) {
    warnings.push("unstructured-response");
    return {
      outcome: anchor.maxOutcome,
      thesis: salvageThesis(rawText) ?? rawText.trim(),
      challenges: [],
      conditions: [],
      invalidation: null,
      watch: [],
      confidence: null,
      citedIds: [],
      warnings,
      raw: rawText,
    };
  }

  // (1) Outcome validity.
  let outcome = parsed.outcome as DeskOutcome;
  if (!VALID_OUTCOMES.includes(outcome)) {
    warnings.push("invalid-outcome");
    outcome = anchor.maxOutcome;
  }

  // (2) Anchor enforcement: forced anchors pin the outcome exactly; otherwise
  //     clamp anything more permissive than the ceiling down to it.
  if (anchor.forced) {
    if (outcome !== anchor.maxOutcome) {
      warnings.push("forced-to-anchor");
      outcome = anchor.maxOutcome;
    }
  } else if (OUTCOME_PERMISSIVENESS[outcome] > OUTCOME_PERMISSIVENESS[anchor.maxOutcome]) {
    warnings.push("clamped-to-anchor");
    outcome = anchor.maxOutcome;
  }

  // (3) Citation validation against the pack's ID set.
  const validIds = new Set(pack.items.map((it) => it.id));
  const rawChallenges = Array.isArray(parsed.challenges) ? parsed.challenges : [];
  const challenges: DeskChallenge[] = [];
  const citedIds = new Set<string>();
  for (const rc of rawChallenges) {
    if (typeof rc !== "object" || rc === null) continue;
    const c = rc as Record<string, unknown>;
    const claim = typeof c.claim === "string" ? c.claim.trim() : "";
    if (claim === "") continue;
    const kept: string[] = [];
    for (const id of asStringArray(c.citations)) {
      if (validIds.has(id)) {
        kept.push(id);
        citedIds.add(id);
      } else {
        warnings.push(`unknown-citation:${id}`);
      }
    }
    if (kept.length === 0) warnings.push("uncited-claim");
    challenges.push({ claim, citations: kept });
  }

  // (4) Numeric-claim audit: any figure >3 significant digits in the thesis or
  //     challenges that the pack can't back within 0.1% is flagged.
  const thesis = typeof parsed.thesis === "string" ? parsed.thesis.trim() : "";
  const packNumbers = pack.items.flatMap((it) => it.numbers);
  const claimText = [thesis, ...challenges.map((c) => c.claim)].join(" ");
  for (const n of extractNumbers(claimText)) {
    if (significantDigits(n) <= 3) continue;
    const backed = packNumbers.some(
      (p) => p === n || (p !== 0 && Math.abs(p - n) / Math.abs(p) <= 0.001),
    );
    if (!backed) warnings.push(`unverified-number:${n}`);
  }

  // (5) Confidence range.
  let confidence: number | null = null;
  if (typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)) {
    confidence = parsed.confidence >= 0 && parsed.confidence <= 100 ? parsed.confidence : null;
  }

  return {
    outcome,
    thesis,
    challenges,
    conditions: asStringArray(parsed.conditions),
    invalidation:
      typeof parsed.invalidation === "string" && parsed.invalidation.trim() !== ""
        ? parsed.invalidation.trim()
        : null,
    watch: asStringArray(parsed.watch),
    confidence,
    citedIds: [...citedIds],
    warnings,
    raw: rawText,
  };
}
