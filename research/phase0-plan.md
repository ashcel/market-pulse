# Phase 0 implementation plan — instrumentation (G2 strength typing + G4 equilibrium)

> **Status: executed 2026-07-10** — commits `b34ccb9..0c22d66` on `feat/market-structure-model` (unpushed). All commits landed, 207 tests green, tsc/lint/build clean. Two findings forced documented deviations from this plan's sketches:
>
> 1. **Strength rule (commit 2):** the plan's "first-break-decides across all later swings" was rejected on fixture evidence — it over-grants strength. Shipped rule is **leg-scoped** (a swing is judged by its own counter-leg only), which is what reproduced the trader's annotations. `resolvedBy` became `judgedBy`. See EDR 0004.
> 2. **Dealing range (commit 3):** `[lastStrongLow, lastStrongHigh]` inverts in trends (zec-sl). Shipped rule anchors at the most recent strong swing and spans to the extreme opposite swing after it. See EDR 0005.
>
> Also: an extra two-line commit (`4fa44d5`) fixed a `tsc` regression from commit 0's `bun:test` import; HYPE was dropped from fixtures (MEXC venue + no absolute levels in trades.txt); commit 5 was implemented as a header-line annotation rather than a badge, verified against live Binance data in the running app. **Open item for review: `labels.json` is the ground truth and was transcribed by Claude — check it against the PNGs** (commit 1's acceptance gate).

Source: `research/analysis.md` §9 (Phase 0), constrained by risks R1, R2, R5.

Scope contract for the whole phase:

- **No verdict impact.** No decision, score, veto, target, `SetupType`, or intent
  verdict changes. The backtest/hysteresis/shadow keyspace is untouched (R2).
- **No `SwingPoint` schema change.** Strength is a _derived view_ computed at
  read time, never a stored field (R1). `structure.ts` is not edited.
- **Validation bar = annotation fidelity on the 7 Dreimann charts** (logic
  correctness: do we label the same pivots?), explicitly _not_ expectancy and
  _not_ threshold tuning (R5 firewall).

Baseline before commit 1 (record in the PR description):

- `bun test`: **133 pass / 3 fail** — the 3 failures are pre-existing
  `vi.doUnmock` bun-runner incompatibilities in `quant.test.ts`, unrelated to
  this work. Every commit below must keep 133 + (new tests) passing and add
  zero new failures.
- `bun run lint` and `bun run build` clean.

Repo conventions each commit follows: discretionary rule choices get an EDR in
`docs/decisions/` (next number: 0004); new engine modules mirror the
`liquidity.ts` pattern — pure derivation over `MarketStructure`, no state of
its own, replay-safe by construction; doc comments explain the trading read,
not the code.

---

## Commit 0 (optional, recommended) — restore the replay-safety test baseline

**Responsibility:** make `quant.test.ts`'s 3 "runBacktest replay pivot safety"
tests run under `bun test` (replace `vi.doUnmock`/module-mock usage with a
bun-compatible pattern, e.g. dependency injection or `mock.restore`).

Phase 0's whole validation story leans on replay-safety discipline; shipping it
on top of a broken replay-safety test file undermines the claim. This commit
touches **only** `src/lib/engine/quant.test.ts` (no production code).

- **Backward compat:** trivially yes — test-only.
- **Validation:** `bun test` → 136/136 pass. Diff confirms the three tests still
  assert the same three properties (replay oracle, confirmation window,
  determinism) — the fix must not weaken assertions to make them pass.
- **Expected output:** `bun test` summary with 0 fail.

If skipped, every later commit's criteria read "133 + new pass, same 3
pre-existing fails".

---

## Commit 1 — Dreimann ground-truth fixtures (data + labels, no engine code)

**Responsibility:** freeze the 7 example trades as reviewable test fixtures.
Nothing in `src/lib/engine/` production code changes; this commit is pure test
infrastructure, so it can land and be reviewed independently of any algorithm.

**Files added:**

- `src/lib/engine/__fixtures__/dreimann/<trade>.json` — one per trade
  (zec-tp, trx-tp3, zec-sl, ethfi-sl, jup-tp, fet-tp, hype-tp): Binance klines
  for the context TF (4H) and execution TF (15M) covering the chart window,
  fetched once by the script below and committed frozen (never re-fetched in
  tests).
- `src/lib/engine/__fixtures__/dreimann/labels.json` — the hand annotations
  per trade, transcribed from the screenshots + `research/dreimann/trades.txt`:
  which swing highs/lows the chart marks (by approximate time + price), which
  are drawn as **weak** (objective) vs **strong** (protected), the SL/TP
  prices from trades.txt, and whether the entry sat in **discount** of the
  drawn range.
- `src/lib/engine/__fixtures__/dreimann/README.md` — one table row per PNG:
  chart file → symbol/TFs/window → labels, so a reviewer can check the
  transcription against the images without running anything.
- `research/scripts/fetch-dreimann-fixtures.ts` — the one-off fetch script
  (kept for reproducibility; hits `api.binance.com/api/v3/klines` directly,
  not the app's `/api/klines`).
- `src/lib/engine/__fixtures__/dreimann/index.ts` — a typed loader
  (`loadDreimannFixture(name): { candles4h, candles15m, labels }`) for tests.

**Contingency:** if a symbol has no Binance USDT klines for the window (HYPE is
the likely one), the trade is dropped from the fixture set and the README says
so — do not substitute another venue's data silently.

- **Backward compat:** yes — no production imports change; fixtures are
  test-only.
- **Required tests:** a smoke test (`dreimann-fixtures.test.ts`) asserting each
  fixture loads, candle arrays are non-empty, chronological, and cover each
  label's timestamp, and every label references a price within the window's
  range. No engine assertions yet.
- **Validation criteria:** human review of `labels.json` against the PNGs is
  the acceptance gate for this commit — the labels are the ground truth every
  later commit is judged on, so they must be reviewed as data, not code.
  Reviewer spot-checks at least 2 charts end to end.
- **Expected output:** `bun test` passes with the new smoke test; `git diff
--stat` shows only fixture/script/test additions.
- **R5 firewall (recorded in the README):** these fixtures validate _logic
  correctness only_. No numeric threshold may ever be tuned against them.

---

## Commit 2 — `strength.ts`: strong/weak swing typing as a derived view (G2)

**Responsibility:** classify each swing in a `MarketStructure` as
`strong | weak | unresolved`, as a read-time derivation (R1 Alt A), plus its
EDR.

**Files added:** `src/lib/engine/strength.ts`,
`src/lib/engine/strength.test.ts`,
`docs/decisions/0004-swing-strength-derived-view.md`.
**Files touched:** none.

**API (consumes only `MarketStructure` — same dependency shape as
`computeLiquidityPools`):**

```ts
export type SwingStrength = "strong" | "weak" | "unresolved";

export interface SwingStrengthEntry {
  swing: SwingPoint; // same object as structure.swings[i]
  strength: SwingStrength;
  resolvedBy: SwingPoint | null; // the swing whose break settled it
}

export function deriveSwingStrength(structure: MarketStructure): SwingStrengthEntry[];
```

**Rule (first-break-decides, mirroring `liquidity.ts` `intact` semantics —
swing-level accounting, candle-level wicks out of scope):** for a swing high H
with preceding swing low L:

- **strong** when a later swing low breaks below L before H is taken — H is
  the origin of a downward break leg (it is "protected").
- **weak** when a later swing high breaks above H first — H was the target and
  got taken.
- **unresolved** until one of those breaks prints. Mirror for lows.

First-break-decides makes the view **append-only**: a resolved value can never
flip under later data, only `unresolved` entries can change. That property is
what keeps the derived view replay-safe when computed over bar-limited
structures. The EDR records this rule, the swing-vs-wick choice, and the
equal-level edge case (does an EQH within tolerance "take" the high? decision:
require a strict break, consistent with the HH label rule in `structure.ts`).

- **Backward compat:** yes — new module, zero existing imports change, no
  stored fields, no keyspace impact.
- **Required tests:**
  - Unit: uptrend sequence → prior lows resolve strong, taken highs resolve
    weak; downtrend mirror; flat range → unresolved tail; first swings with no
    prior opposite swing.
  - **Append-only property:** for every prefix `structure(pivots[0..k])`,
    entries resolved at k keep the identical strength and `resolvedBy` at k+1
    … n (drive with `computeMarketStructure` over growing pivot windows,
    the same style as `replay-safe-benchmark.test.ts`).
  - **Annotation fidelity (the Phase 0 bar):** for each fixture from commit 1,
    run pivots → structure → `deriveSwingStrength` on the 4H candles and
    assert the chart's marked weak highs/lows land weak and the protected
    swings land strong. A mismatch is a finding to resolve in the rule (or an
    explicitly documented divergence in the EDR) — never a fixture edit to
    make the test pass.
- **Validation criteria:** all of the above green; `git diff --stat` shows
  only the three new files; existing test counts unchanged.
- **Expected output:** e.g. for the TRX fixture, the H4 weak high named as the
  objective in trades.txt ("Objective hit weak structure") derives `weak`
  before the entry bar and `resolvedBy` its break after TP.

---

## Commit 3 — `equilibrium.ts`: dealing range + premium/discount (G4)

**Responsibility:** derive the active dealing range from strong swings and
classify a price as premium/discount, plus its EDR. Depends on commit 2's
exports only.

**Files added:** `src/lib/engine/equilibrium.ts`,
`src/lib/engine/equilibrium.test.ts`,
`docs/decisions/0005-dealing-range-equilibrium.md`.
**Files touched:** none.

**API:**

```ts
export interface DealingRange {
  low: SwingPoint; // most recent strong swing low
  high: SwingPoint; // most recent strong swing high
  equilibrium: number; // (high.price + low.price) / 2
}

export type PricePosition = "premium" | "discount" | "equilibrium";

export function computeDealingRange(structure: MarketStructure): DealingRange | null;
export function classifyPrice(range: DealingRange, price: number): PricePosition;
```

Returns `null` when no strong low _and_ strong high exist yet (early series,
pure one-way trend) — **absence is a first-class outcome** consumers must
handle; do not fabricate a range from unresolved swings.

The EDR must record the discretionary choices the analysis flags (§6
"needs-research"): range = most recent strong low + most recent strong high
even if price has since left the range; exact-midpoint comparison (`> eq` =
premium, `< eq` = discount, `=== eq` = equilibrium) with no band; behavior
when the strong high precedes the strong low. These are recorded as _initial_
choices revisable in later phases — Phase 0 only needs them deterministic and
documented.

- **Backward compat:** yes — new module only.
- **Required tests:**
  - Unit: known sequences → expected range endpoints and midpoint; null cases;
    inverted/degenerate ordering per the EDR choice; classification at, above,
    below eq.
  - **Replay safety:** the range as-of-bar changes only when a strength
    resolution changes it (prefix-window sweep, as in commit 2).
  - **Annotation fidelity:** for each fixture whose trade was a long from a
    POI (all 7 are bullish pullback longs), assert the entry price from
    trades.txt classifies as `discount` of the derived 4H dealing range —
    logic check only.
- **Validation criteria:** green suite; only new files in the diff.
- **Expected output:** e.g. ZEC-TP fixture → a `DealingRange` whose midpoint
  sits above the 454.73 SL region and whose classification of the entry is
  `discount`.

---

## Commit 4 — instrumentation surfacing in `SignalEvaluation` (additive, inert)

**Responsibility:** expose the two derived views on the engine's output so the
UI, tests, and later phases can read them — without any decision-path code
consuming them.

**Files touched:** `src/lib/engine/quant.ts` only (plus its test file).

`SignalEvaluation` already carries `structure: MarketStructure`
(`quant.ts:166`); this commit adds two sibling fields, computed in
`evaluateSignal` exactly where `liquidity`/`liquiditySweeps` are derived
today:

```ts
/** Derived strong/weak view over `structure.swings` (Phase 0 instrumentation; not read by any decision). */
swingStrength: SwingStrengthEntry[];
/** Active dealing range from strong swings, null until one exists; `pricePosition` classifies livePrice. */
dealingRange: DealingRange | null;
pricePosition: PricePosition | null;
```

- **Backward compat:** additive fields on an interface — every existing
  consumer type-checks unchanged. Nothing keys off the new fields, so
  backtest/hysteresis/shadow records are byte-identical (R2). The snapshot
  path (`market.ts`) inherits the fields for free through `evaluateSignal`
  and ignores them.
- **Required tests (in `quant.test.ts` or a new `instrumentation.test.ts`):**
  - **Inertness regression — the commit's core claim:** over deterministic
    mock candles (`generateMockCandles`) for several seeds/symbols, every
    decision-bearing field of `evaluateSignal` (`setupType`, `decision`,
    `direction`, `lean`, `regime`, `confidence`, `noTradeReasons`, `risk`,
    `backtest`) is deep-equal before/after this commit. Implement as: compute
    the evaluation, strip the three new fields, snapshot-compare against
    fixtures captured at the parent commit.
  - Coherence: `swingStrength[i].swing === structure.swings[i]`;
    `pricePosition` is null iff `dealingRange` is null.
- **Validation criteria:** inertness snapshots identical; `git diff --stat`
  touches only `quant.ts` + tests; `bun run build` clean; `strategyVersion`
  **unchanged** (nothing decision-relevant moved).
- **Expected output:** `evaluateSignal(...)` for any mock symbol returns the
  three new fields populated; all pre-existing fields bit-identical to the
  parent commit.

---

## Commit 5 (optional — only if Phase 0 should be visible in the product) — token-page read-only badge

**Responsibility:** display `pricePosition` + last strong/weak swing on the
token detail page as passive context. Touches only `src/components/iq/` and
`src/routes/token.$symbol.tsx`; must respect the existing plan-pinning and
read-strength invariants of the glance redesign. No store, hook-query, or
engine changes.

- **Backward compat:** yes — presentational only; renders nothing when
  `dealingRange` is null or the source is demo data (surface live vs. demo as
  the page already does).
- **Validation criteria:** `bun run build` + lint clean; manual check of one
  live and one demo token showing the badge/absence respectively.
- **Expected output:** e.g. "Discount · below EQ of 4H range" with the range
  endpoints on hover.

This can be deferred without blocking Phase 0.5 — the phase's exit criterion
is met at commit 4.

---

## Phase exit criteria (maps to §9's bar)

1. Commits 1–4 merged; suite green (136 target, or 133 + new with the 3
   pre-existing failures documented if commit 0 was skipped).
2. Annotation-fidelity tests reproduce the strength and discount labels on
   every fixture trade, with any divergence documented in the EDRs rather
   than papered over.
3. Inertness regression proves zero verdict drift — Phase 0 makes **no**
   shadow or expectancy claim.
4. EDRs 0004/0005 record the rule choices, unblocking Phase 0.5 (limit-fill
   harness) and the Phase 1 objective resolver, both of which consume
   `strength.ts` output.

Order of operations is fixed (1 → 2 → 3 → 4): fixtures before algorithms so
ground truth is reviewed before anything is judged against it; strength before
equilibrium because the dealing range is defined by strong swings.
