# M0-T5c — Liquidity confidence relabel + Fear & Greed fallback exposure

## Context

Milestone M0 (Honesty pass & direction commit). M0-T4 produced
`docs/score-inventory.md`; M0-T5a/b already resolved the core-engine-
confidence and regime/rotation rows. This task resolves the doc's two
remaining independent `demote-to-rank` rows: **Liquidity pool confidence**
and **Homepage "Sentiment" (Fear & Greed)**. They are unrelated to each
other — treat them as two separate patches in one task.

## Task — Part 1: Liquidity pool confidence

`src/lib/engine/liquidity.ts` computes a 0-100 `confidence` field per
`LiquidityPool` (`LIQUIDITY_WEIGHTS`-blended touches/tightness/recency, see
`docs/decisions/0002-liquidity-pool-confidence.md`). That EDR **already
names this exact risk** in its own "Risks" section: "Confidence numbers may
be read as probabilities. They are ordinal rankings; the UI shows them as
bare scores deliberately." The doc's fix: a qualitative tier, or an explicit
ordinal disclosure.

It's rendered in two places in `src/routes/token.$symbol.tsx`:
- **~line 1618-1621**: a `lightweight-charts` price-line `title`:
  `` `${pool.side === "bsl" ? "BSL" : "SSL"} ${pool.confidence}` ``. This is
  drawn by the charting library onto a `<canvas>` — **it is not a DOM
  element**, so a `title` hover-tooltip attribute (the M0-T5a/b pattern)
  cannot be attached to it. The fix here must change what text is drawn,
  not add a tooltip.
- **~line 1887**: the chart-legend `hint` text for the "Liquidity" overlay
  toggle (a `ProductTour`-style legend item with a `label`/`hint` field,
  already rendered as a hover/tap-accessible tooltip elsewhere on the page
  — find how the existing `hint` field is displayed to confirm the
  mechanism before editing).

**Fix:**
1. In `src/lib/engine/liquidity.ts`, add a derived, additive field to the
   `LiquidityPool` interface (after `confidence`): `tier: "Strong" |
   "Moderate" | "Weak"`. Compute it wherever `confidence` is assigned (the
   `computeLiquidityPools`-style function that builds the returned pool
   object), using thresholds consistent with this codebase's existing
   confidence-banding convention (see `ConfidenceGauge`'s tone bands in
   `src/components/iq/confidence-gauge.tsx`): `confidence >= 70 ?
   "Strong" : confidence >= 45 ? "Moderate" : "Weak"`. This is a pure,
   additive derivation of an already-computed field — **verify first** (by
   reading `src/lib/engine/objectives.ts`, `intent.ts`, `poi.ts`) that no
   decision/trigger logic reads `LiquidityPool.confidence` today (a repo
   scan for this task found none — `pool.confidence` is referenced only by
   the chart render and tests, never by `resolveObjectives` or any intent
   verdict), so adding `tier` cannot affect any decision output. Do not
   change the existing `confidence` field itself.
2. In `token.$symbol.tsx`'s price-line `title` (~line 1618-1621), change to
   `` `${pool.side === "bsl" ? "BSL" : "SSL"} ${pool.tier}` `` — e.g. "BSL
   Strong" instead of "BSL 72". Drop the raw number from the chart
   entirely; the tier is now the on-chart read.
3. In the "Liquidity" legend item's `hint` text (~line 1887, currently
   "...The number is the pool's confidence (touches, tightness,
   freshness)..."), update to describe the tier instead: "...The label is
   the pool's strength tier — Strong/Moderate/Weak, from touches,
   tightness, and freshness — an ordinal ranking, not a probability...".
   Keep the rest of the hint's content (BSL/SSL explanation, sweep-circle
   explanation) intact; only the confidence-number sentence changes.

Verify current line numbers before editing.

## Task — Part 2: Fear & Greed silent fallback

`src/lib/engine/market.ts`'s `buildSnapshot` (around line 563-568) computes
`const fg = fearGreed ?? round(0.5 * breadth + 0.5 * avgMomentum);` — when
the real `fetchFearGreed()` API call (lines ~527-539) fails or times out,
`fg` silently becomes an internal breadth/momentum proxy with **no
relation to sentiment**, but is shown under the same "Sentiment"/"Fear &
Greed" label with no indication anything changed. Rendered in
`src/routes/index.tsx` around line 310-325 (`MetricCard label="Sentiment"`,
`footerLeft="Fear & Greed"`, `footerRight={... sentiment.data.score ...}`,
plus a `<FearGreed value={sentiment.data.fearGreed} />` gauge).

**Fix:**
1. In `src/lib/types.ts`'s `SentimentData` interface (around line 93-97),
   add: `source: "api" | "proxy"`.
2. In `market.ts`'s `buildSnapshot`, where `fg`/`sentiment` are built
   (around line 563-568), set `source: fearGreed !== null ? "api" :
   "proxy"` on the returned `SentimentData` object. Purely additive — no
   existing field's computation changes.
3. In `src/routes/index.tsx`'s Sentiment `MetricCard` (around line 310-325),
   when `sentiment.data.source === "proxy"`, visibly mark it — e.g. append
   an inline `"(est.)"` next to the `footerLeft="Fear & Greed"` text (match
   the M0-T5a/b pattern: wrap in a `<span title="...">`) with a `title`
   disclosure: "The Fear & Greed API was unreachable — this is an internal
   breadth/momentum estimate, not the real index." When `source === "api"`,
   render exactly as today (no visible change, no disclosure needed since
   it's genuinely the real index).

Verify current line numbers before editing.

## Definition of Done

- Liquidity pool chart price-lines show a qualitative tier (Strong/
  Moderate/Weak), not a bare confidence number.
- The Liquidity legend hint text describes the tier, not "the number."
- `LiquidityPool.confidence` itself is unchanged; `tier` is a new additive
  field derived from it, confirmed unread by any decision/trigger logic.
- `SentimentData` carries a `source: "api" | "proxy"` field; the homepage
  visibly discloses when the proxy fallback is active, and shows exactly
  as before when the real API succeeded.
- `docs/score-inventory.md`'s two rows (Liquidity pool confidence,
  Homepage "Sentiment") get " — resolved M0-T5c" appended to their
  Justification cells (don't rewrite the rows).
- `bunx vitest run` green, `bunx tsc --noEmit` clean, `bun run lint` 0 errors.
- If any existing test asserts on the liquidity price-line title format or
  the exact `SentimentData` shape, update it to match — don't leave a
  failing test.
- No changes to `evaluateSignal`, `intent.ts`'s decision/verdict logic,
  `objectives.ts`'s POI selection logic, `hysteresis.ts`, `tracker.ts`,
  `shadow.ts`, `anticipatory.ts`, `version.ts`, or `src/server/worker/`.

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
- Only additive changes to `liquidity.ts`/`market.ts`/`types.ts` (new
  fields); do not alter any existing field's computation or remove it.

## Review notes from previous attempt

*None — first attempt.*
