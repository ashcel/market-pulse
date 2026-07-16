# M0-T5b — Regime & rotation gauges

## Context

Milestone M0 (Honesty pass & direction commit). M0-T4 produced
`docs/score-inventory.md`; M0-T5a already resolved the four scores derived
from the core engine `confidence` (Signal/Overall confidence, Asset-list
confidence, Market Pulse Score, "Technical Data" score) by adding a
disclosure tooltip. This task resolves the score-inventory doc's remaining
`demote-to-rank` rows in the "Regime & confidence gauges" table: **Market
Regime confidence**, **Regime pillar — Trend**, **Regime pillar —
Volatility**, and **Rotation confidence**.

Unlike M0-T5a, two of these four rows (Trend, Volatility) have a specific
prescribed fix in the doc's own Justification column — not just "add a
disclosure" but "show a different, more honest value instead of the
manufactured 0-100 score." Read each row's exact wording in
`docs/score-inventory.md`'s "Regime & confidence gauges" table before
starting.

Everything touched here lives in `src/lib/engine/market.ts`'s regime/rotation
builders and `src/lib/types.ts`. **This is not the forward-test signal
engine** — `pillars`/`RotationData` are dashboard-only fields, never
consumed by `evaluateSignal`, `intent.ts`, hysteresis, or anything the
worker persists as a tracked/settled record (confirmed: `pillars` is
referenced only in `src/lib/types.ts`'s type definition, its construction in
`market.ts`, and its render in `src/routes/regime.tsx`). Adding new
*additive* display fields here is not an engine decision/trigger semantics
change and does not require an `ENGINE_VERSION` bump — but do not touch
`evaluateSignal`, `intent.ts`, `hysteresis.ts`, `tracker.ts`, `shadow.ts`,
`anticipatory.ts`, or anything under `src/server/worker/`.

## Task

**1. Market Regime confidence** (`src/routes/index.tsx:255,260`,
`src/routes/regime.tsx:77`, via `ConfidenceGauge`)
Same pattern as M0-T5a: add a disclosure, don't remove the gauge. At
`regime.tsx:77` (`<ConfidenceGauge value={data.confidence} size={200}
label="Confidence" />`) and the `index.tsx` Market Regime `MetricCard`'s
`footerLeft="Confidence"` (around line 245), add a `title` attribute with:
"Rule-based blend of the five regime pillars below, not a calibrated
probability." Use the same `title`-on-wrapping-element approach as M0-T5a
(e.g. wrap `footerLeft="Confidence"` in a `<span title="...">`; for the
`regime.tsx` gauge, add the disclosure as a caption `<p>` beneath it,
matching the pattern already used at `technical.tsx:120-123` for the
signal-confidence gauge — reuse that exact wording style, adapted to regime
pillars instead of the checklist).

**2. Regime pillar — Trend** (`src/routes/regime.tsx:147-179`, pillar
built in `src/lib/engine/market.ts:398-402`)
The doc's fix: "show the regime label itself, which already exists and
needs no invented number" — replace the big numeric score display with the
categorical BTC regime label for this pillar only.
- In `src/lib/types.ts`'s `MarketRegimeData.pillars` array type (around line
  40), add an optional field: `displayValue?: string`.
- In `src/lib/engine/market.ts`'s Trend pillar object (around line 399-403),
  add `displayValue: titleCase(btcRegime)` (the `titleCase` helper already
  exists at `market.ts:174-176` and is already used for this same
  `btcRegime` value in the Trend pillar's `description` string one line
  below — reuse it, don't duplicate).
- In `src/routes/regime.tsx`'s pillar render (around line 147-152, the
  `<div className="num text-2xl font-semibold tracking-tight">{p.score}
  </div>`), change to render `{p.displayValue ?? p.score}`. Leave `p.score`
  driving the status badge and the progress-bar `width` exactly as before —
  only the big headline number's *text* changes for pillars that set
  `displayValue`; the other four pillars are unaffected (they don't set it,
  so they keep showing `p.score` as today).

**3. Regime pillar — Volatility** (same files, `market.ts:363,412-416`)
The doc's fix: "show the raw ATR% instead of a manufactured 0-100 figure."
- In the Volatility pillar object in `market.ts` (around line 412-416), add
  `displayValue: \`${round(atrPctDaily, 1)}%\`` (reuses the already-computed
  `atrPctDaily` and the existing `round` helper — same value already used
  in this pillar's `description` string one line below).
- No further `regime.tsx` change needed — the generic `p.displayValue ??
  p.score` render from step 2 handles this pillar too.

**4. Rotation confidence** (`src/routes/rotation.tsx`, "Rotation Confidence"
`MetricCard`, around line 87-93; computed in
`src/lib/engine/market.ts:475-491`)
The doc's fix: show the real rank-agreement statistic (`rho`) instead of
(or alongside) the opaque rescaled `confidence` percentage, since the
`rho` variable is already computed in `market.ts` but never exposed to the
client.
- In `src/lib/types.ts`'s `RotationData` interface (around line 55-64), add
  `rankAgreement: number`.
- In `market.ts`'s rotation builder (around line 483-491, where `rho` is
  computed and the `rotation: RotationData` object is built), add
  `rankAgreement: round(rho, 2)` to that object (reuse the already-computed
  `rho`; `round` is already imported/used throughout this file).
- In `rotation.tsx`'s "Rotation Confidence" card (around line 87-93),
  replace the static `footerRight="RotationModel v1"` with something that
  surfaces the real statistic, e.g. `` footerRight={`ρ ${data.rankAgreement
  >= 0 ? "+" : ""}${data.rankAgreement}`} `` (adjust variable name to match
  whatever the component destructures `rotation.data` as — check the
  current code). Also add a `title` to the card's `label="Rotation
  Confidence"` (wrap in a `<span title="...">` per the established pattern)
  explaining: "Rescaled from the real 24h-vs-7d sector rank correlation
  (shown as ρ below) — not an independently calibrated probability."

Verify every line number above against current source before editing — this
brief was written from a point-in-time read and lines may have moved.

## Definition of Done

- Market Regime confidence gauge (both render sites) carries a disclosure;
  the gauge itself is unchanged.
- The Trend pillar's headline number is the categorical regime label
  (e.g. "Trending Up"), not a numeric score.
- The Volatility pillar's headline number is the raw ATR% (e.g. "3.2%"),
  not the manufactured 0-100 score.
- The remaining three pillars (Breadth, Momentum, Participation) still
  render their numeric `score` exactly as before — unaffected.
- The pillar status badge and progress-bar width for every pillar (all
  five) are unchanged — only the Trend/Volatility headline *text* changes.
- Rotation Confidence card shows the real rank-agreement statistic (ρ) and
  carries a disclosure on its label.
- `docs/score-inventory.md`'s four rows (Market Regime confidence, Regime
  pillar — Trend, Regime pillar — Volatility, Rotation confidence) get
  " — resolved M0-T5b" appended to their Justification cells (don't rewrite
  the rows).
- `bunx vitest run` green, `bunx tsc --noEmit` clean, `bun run lint` 0 errors.
- No changes to `evaluateSignal`, `intent.ts`, `hysteresis.ts`,
  `tracker.ts`, `shadow.ts`, `anticipatory.ts`, `version.ts`, or anything
  under `src/server/worker/`. The only `src/lib/engine/` file touched is
  `market.ts`, and only via additive fields (`displayValue`,
  `rankAgreement`) — no existing field's value or type changes, no
  ENGINE_VERSION bump.

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
- Only additive changes to `market.ts`/`types.ts` (new optional/new fields);
  do not alter any existing field's computation or remove anything.

## Review notes from previous attempt

*None — first attempt.*
