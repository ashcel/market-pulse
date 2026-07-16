# M0-T5a — Core engine confidence: add heuristic disclosure

## Context

Milestone M0 (Honesty pass & direction commit). M0-T4 produced
`docs/score-inventory.md`, an audit of every user-facing numeric score. This
task executes that doc's `demote-to-rank` decision for the score family that
all derives from `evaluateSignal`'s `rawConfidence`
(`src/lib/engine/quant.ts:852-853`, a weighted rule-based checklist over
trend/structure/volume/candle/RR/support-resistance/liquidity/extension, base
35, clamped 0-100). Per EDR 0017 (`docs/decisions/0017-product-direction.md`),
the engine is a context instrument pending its 1.0.0 forward-test verdict —
so a bare `NN/100` or `NN%` reads as more proven than it is. The rubric's
fix for `demote-to-rank` is: "replace with a qualitative band/rank, or an
explicit heuristic-not-proven-edge disclosure."

**Decision for this task: use the disclosure approach, not a redesign.**
This codebase already has an established, working pattern for exactly this —
two of the render sites already do it correctly:
- `src/routes/technical.tsx:120-123` — a `<p>` under the gauge: "How
  strongly the engine's evidence points in one direction — not the
  probability the trade wins. Composite of trend, structure, volume, and
  risk on live 1H bars." **This site needs no change** — it already
  satisfies the rubric. Leave it exactly as-is.
- `src/routes/token.$symbol.tsx:3060-3062` — an `InfoHint` next to the
  "Read strength" gauge: "How strongly the engine's evidence points in one
  direction — signal strength, not a win probability. The verdict word is
  the action. {meaning}". **This site also needs no change.**

Reuse that same house voice at the sites below that currently show the
number with **no** disclosure at all. Keep the fix minimal: a native `title`
attribute (tooltip on hover/long-press) where no dedicated hint component
exists in the file already, or a short adjacent caption where a `title`
attribute would be invisible/unreachable (e.g. a markdown export). Don't
invent a new shared component for this — `InfoHint` is already duplicated
per-file in this codebase (`token.$symbol.tsx:801`,
`structure-alignment-card.tsx`) and this task doesn't need a third copy;
reach for `title` first.

**Canonical disclosure copy** (adapt length to the site, keep the meaning):
- Full: "Rule-based checklist score, not a calibrated win probability —
  pending the engine's 1.0.0 forward-test verdict."
- Short (for tight spaces like table headers): "Heuristic checklist score,
  not a proven-edge probability."

## Task

There are three distinct numeric fields in play, all built from or
alongside `evaluateSignal`'s confidence — treat each render site below.

**1. `asset.technical`** (= the raw `evaluateSignal` confidence, aliased as
"technical" in `src/lib/engine/market.ts:243` context and reused verbatim)
- `src/routes/rankings.tsx` — the "Technical" sortable column header
  (`sortKey === "technical"`, around line 195-210) and its cell render
  (`{a.technical}`, around line 291-294 based on the column order — verify
  against current source). Add the short disclosure as a `title` on the
  header's button/span.
- `src/routes/index.tsx:340` — the "Technical Data" stat card
  (`footerLeft="Avg Signal Score"`, `footerRight={... {technical.data.score}
  / 100 ...}`, built from `market.ts:570-574`'s mean of all assets'
  `technical`). Wrap `footerLeft` in a `<span title="...">` with the full
  disclosure (mention it's an average across the tracked universe).

**2. `asset.confidence`** (`market.ts:243` —
`0.5*technical + 0.25*momentum + 0.25*strength`, rendered as the "Signal"
column in rankings and the bare confidence chip elsewhere)
- `src/routes/rankings.tsx` — the "Signal" sortable column header
  (`sortKey === "confidence"`, around line 213-220) and its cell
  (`{a.confidence}`, around line 299). Add the short disclosure as a
  `title` on the header.
- `src/routes/index.tsx:515` — the small `{a.confidence}/100` chip in the
  asset card list. Add a `title` attribute to its containing `<span>` or
  `<Link>` with the short disclosure.

**3. `asset.score`** ("Market Pulse Score",
`market.ts:244` — `0.3*momentum + 0.25*strength + 0.25*technical +
0.2*volumeScore`)
- `src/routes/rankings.tsx` — the "Score" sortable column header (around
  line 148-155) and its cell (`{a.score}`, around line 259). Add the short
  disclosure as a `title` on the header, and mention in the tooltip that
  this is a *different* blend than "Signal"/"Technical" (independently
  weighted — not meant to be read as agreeing confirmation of the same
  thing).
- `src/routes/index.tsx:639` — the "Top Assets" table's Score column cell
  and its header. Same treatment.

**4. Two lower-traffic sites for the same underlying `evaluation.confidence`**
(in `src/routes/token.$symbol.tsx`, inside the AI Analyst drawer —
verify current line numbers before editing):
- The `ContextPill label="Signal" value={\`${evaluation.confidence}/100\`}`
  in the drawer's context-pill grid (around line 3674). Add a `title` to
  the pill's wrapping `<div>` (check `ContextPill`'s props around line
  4092 — if it doesn't already forward a `title`/`className` prop, add a
  `title` prop to `ContextPillProps` and pass it through to the outer
  `<div>`, since it's a small, self-contained component used only here).
- The markdown export template literal `` `- **Signal strength:**
  ${e.confidence}/100` `` (around line 3834, inside the function that
  builds the copy/export text). Append a short parenthetical to the line
  itself, e.g. `` `- **Signal strength:** ${e.confidence}/100 (heuristic
  checklist score, not a win probability)` ``.

Verify every line number above against current source before editing —
this brief was written from a point-in-time read and lines may have moved.

## Definition of Done

- Every render site listed above (except the two already-compliant ones,
  which must be left untouched) shows the disclosure copy on hover/in the
  export text.
- No bare, undisclosed `/100` or raw confidence number remains at these
  specific sites.
- `docs/score-inventory.md`'s four rows for these scores (Signal/"Overall"
  confidence, Asset-list confidence, Market Pulse Score, "Technical Data"
  score) get their Decision cell's status noted as resolved (append " —
  resolved M0-T5a" to the Justification cell, don't rewrite the row).
- `bunx vitest run` green, `bunx tsc --noEmit` clean, `bun run lint` 0 errors.
- No changes to `src/lib/engine/` computation logic — this task only adds
  disclosure text/tooltips around existing numbers. The numbers themselves,
  their formulas, and `ENGINE_VERSION` are untouched.

## Constraints (always include; copy, don't reference)

- Do NOT modify src/lib/engine decision/trigger semantics or ENGINE_VERSION.
- Do NOT read 1.0.0 shadow-record outcomes (record:report --integrity only).
- SSE only, no WebSocket server endpoints. No src/server imports in client code.
- Migrations: hand-written SQL, next number in src/server/db/migrations/.
- New tables user-scoped (user_id FK). No plaintext secrets in DB or logs.
- R metrics only where a stop order is evidenced; else % / MAE-MFE.
- Match existing code style; tests colocated *.test.ts; do not touch
  routeTree.gen.ts; do not add packages without flagging (24h supply guard).
- Do not commit. Leave changes in the working tree for review.
- Do not touch the two already-compliant sites (technical.tsx gauge caption,
  token.$symbol.tsx "Read strength" InfoHint) — they already satisfy the
  rubric; changing them is scope creep.
- Do not touch anything in `src/lib/engine/` — display-layer copy/tooltip
  changes only.

## Review notes from previous attempt

*None — first attempt.*
