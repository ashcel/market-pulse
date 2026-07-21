# EDR 0021: AI Desk Review — verdict-anchored trade-idea evaluation

- **Status:** Accepted (2026-07-21) — direction commit from the user; implements the AI CRO role pinned by EDR 0020 (the risk-gate layer).
- **Scope:** product plane — how the AI evaluates trade ideas; interaction UX (idea → chips → verdict); output structure and validation. **No engine decision/trigger semantics change and no `ENGINE_VERSION` change** — the 2.0.0 forward-test clock and deterministic gate remain untouched.
- **Supersedes:** the generic Ask-AI sidebar behavior (free-form chat without evidence anchoring or outcome structure). 
- **Depends on:** EDR 0020 (the AI as Chief Risk Officer, gating with deterministic rules); EDR 0017 decision 1 (the AI never originates signals).

## Problem

The Ask-AI sidebar was a generic chatbot bolted onto the dashboard — the user could ask any question and receive an answer without connection to the system's evidence or the user's stated intent. This fails the risk-desk model from EDR 0020: the AI must act as a Chief Risk Officer cross-examining a specific trade idea the trader proposes, backed by the engine's evidence, challenging instead of agreeing.

The generic UX also invites sycophancy through prompt design, confuses output format (chat vs. decision), and leaves no audit trail linking conclusions back to the evidence pack they claim to cite. A trade idea evaluated today must be reproducible from the same evidence pack later, after the trade settles, so desk decisions can be journaled and reconciled against forward-test outcomes.

## The decisions

### 1. Verdict anchor — deterministic cap, LLM confirms or downgrades

The engine computes a **verdict anchor** from the per-objective `IntentAssessment` (favored / caution / wait / avoid) crossed with the trader's stated direction (long / short / skip), plus a hard cap for sub-15-minute horizons (finer than the engine's finest 15M-candle evidence). This anchor is the maximum permissible outcome the LLM may endorse.

The AI may confirm the anchor or downgrade it (approve → conditional → reject); it may never upgrade. Sycophancy is handled structurally by the anchor, not by prompt exhortation. A `wait` verdict on a long entry anchors to "no-evidence," never "approve"; a `caution` verdict becomes "conditional" at best.

### 2. Five outcomes and missing-data policy

The AI returns one of five mutually exclusive outcomes: **approve**, **conditional**, **reject**, **out-of-scope**, **no-evidence**. Missing or insufficient data (symbol not in engine universe, timeframe below resolution, regime uncomputable) triggers **no-evidence**, never approval by default. Horizons outside the engine's evidence scope (e.g., sub-5-minute scalps) say "wrong instrument" or "outside engine resolution" rather than faking precision.

### 3. Evidence pack with citation discipline

The **evidence pack** is a versioned JSON object collecting ID'd items from the engine:

- **S** — structure (CHoCH, BOS, swing pivots)
- **L** — liquidity (fair-value gaps, order blocks, zones)
- **Z** — zones (support/resistance, equilibrium, session levels)
- **R** — risk plan (stop placement validity, R:R, account headroom)
- **O** — objective (the IntentAssessment for the stated timeframe / objective pair)
- **H** — history (prior similar setups, settlement outcomes)
- **X** — external (news, events, breadth, volatility regime)
- **C** — chart (current price, recent candle action, technical setup framing)

The LLM must cite item IDs (e.g., "S-2, L-5, O-1") for every factual claim or challenge. A post-parse validator:
- Strips citations of nonexistent IDs (flagging malformed references)
- Flags uncited factual claims (assertions not anchored to the pack)
- Flags numbers not present in the pack within 0.1% tolerance (halting obviously invented prices/levels)

### 4. Output structure — strict JSON, clamped to anchor

The verdict is returned as **strict JSON**, never streamed markdown:

```json
{
  "outcome": "approve|conditional|reject|out-of-scope|no-evidence",
  "thesis": "one-sentence core rationale",
  "challenges": [
    { "claim": "specific factual challenge", "citations": ["S-2", "L-3"], "severity": "structural|tactical|hygiene" }
  ],
  "conditions": ["if X, then upgrade to approve", "if Y holds, conditional remains valid"],
  "invalidation": "what trade action or price level would prove this desk review wrong",
  "watch": ["what to monitor post-entry"],
  "confidence": 0.0–1.0,
  "pack_id": "hash of evidence pack version"
}
```

Output is clamped to the verdict anchor: if the anchor is "conditional," an LLM-generated outcome of "approve" is downgraded before return. If the anchor is "no-evidence," the outcome is forced to "no-evidence" regardless.

### 5. UX — review-first, not chat-first

The interaction sequence is:

1. **Idea intake**: free-text proposal ("I want to short DEXE for the next 5–15 minutes")
2. **Intent parsing**: a fast regex path extracts symbol/side/timeframe; on ambiguity or novel phrasing, the LLM fallback parser returns a structured `IntentChip` {symbol, side, timeframe_minutes, confidence} for the user to confirm
3. **Verdict card**: once intent is locked, the desk review streams as a card showing outcome, thesis, top challenges, invalidation, and watch list — not a chat message
4. **Follow-up thread**: only the verdict card's evidence pack is in scope for follow-ups; a question like "why did you reject this?" pulls citations from the same pack; a question about an unrelated trade surfaces "different instrument, need a new review"

Plain chat remains only as a fallback for non-idea questions (e.g., "what's the Fear & Greed index?"), which bypass the structured review pipeline and are labeled as informational, not desk decisions.

### 6. BYOK and client-side, with future server-side path

The pack builder and anchor-computation logic are **framework-free pure modules** (TypeScript, no React/server dependencies), living in `src/lib/engine/` alongside the signal engine. The full review pipeline (parser, LLM call, validator, output formatter) is BYOK and runs client-side for now.

This design permits later migration to the Python worker without redesign: the pack builder and anchor can be ported to `backend/app/worker/` to produce server-side desk reviews (e.g., scheduled reviews of the day's setups, journaled alongside forward-test settlements), with only the UX layer staying browser-side.

## What this does **not** change

- **Engine role (0020 decision 2 / 0017 decision 2)**: the engine remains the sole signal originator; AI reads engine output, it does not compute or override verdicts or triggers. Desk review is an AI layer over deterministic engine reads, not a second opinion on the signal itself.
- **Risk gate determinism (0020 decision 2)**: the desk review is an advisory layer on top of the Trading Constitution; it cannot approve trades the deterministic gate rejects, and it is not the gate.
- **R-multiples (0017 decision 3)**: unchanged — desk review uses the same R/MAE-MFE display rules as the rest of the system.
- **BYOK custody (0020, 0017)**: analyst keys stay in the browser; this decision does not affect key handling.

## What was intentionally rejected

- **Outcome upgrade by LLM**: the anchor is a cap, never a floor. If the engine says "wait," no prompt can get the AI to say "approve."
- **Chat-first UX**: free-form question-answer builds confusion about what is a desk decision vs. passing information. Review-first (structured idea intake, locked intent, outcome card) disciplines both the trader and the AI.
- **Uncited claims**: numbers or levels in the verdict that don't appear in the evidence pack (within tolerance) halt the response; this prevents hallucinated levels or prices that sound plausible but diverge from engine reality.
- **Backtest win rates or confidence in output**: the confidence field in the verdict JSON is internal (pack validator uses it); no user-facing "AI Confidence" or win-probability emerges from this layer. The Trade Quality Score (EDR 0020 decision 5) is the only confidence metric shown in execution UI.

## Validation performed

Docs-only diff (this file + links in CLAUDE.md). Measurable validation lives in the M9 / M10 implementation DoDs: pack-builder unit tests (structure/liquidity/objective sampling), anchor-computation property tests (verdict + direction → outcome rules), citation-validator tests (detect uncited claims and invented numbers), LLM integration tests (prove downgrade-cap is enforced), UI interaction tests (parse chips → confirm → verdict card flow), follow-up thread scope tests (pack-locked queries).

## Future extension points

1. **Server-side reviews** — once the pack builder and anchor module mature on the client, they can port to the Python worker, enabling scheduled desk reviews of candidate setups without user interaction; journal these alongside forward-test outcomes to build a desk track record.
2. **Desk-review analytics** — track approval rate, reasons for rejection, outcome precision (how often invalidation actually triggered); feed into behavior-review layer as a CRO fitness metric.
3. **Multi-leg coordination** — extend verdict anchor to handle stacked multi-leg ideas (spread, ratio, hedge) where one leg's engine read informs another's desk decision.
