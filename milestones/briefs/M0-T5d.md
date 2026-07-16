# M0-T5d — Remove in-sample backtest evidence from user-facing surfaces

## Context

Milestone M0 (Honesty pass & direction commit). M0-T4's
`docs/score-inventory.md` flagged the per-setup "backtest" (`runBacktest` in
`src/lib/engine/quant.ts:915-1021` — a walk-forward replay of the setup type
over **the same chart's own candle history**, i.e. in-sample/curve-fit, not
real forward-tested evidence) for **removal**: its labels ("Win rate",
"Avg R"/"Expectancy") are near-identical to the genuine tracker/shadow-record
stats elsewhere on the page, risking the user conflating much weaker
in-sample evidence with real forward-tested performance.

**This task's scope is larger than "delete one card"** — a repo scan found
`runBacktest`'s output (`SignalEvaluation.backtest`) has **four** consumers,
not one. Read this whole Context section before touching anything; the fix
differs per consumer.

1. `src/routes/token.$symbol.tsx:3467` (`BacktestEvidence` component) +
   its render at `:2643` (inside the "Evidence" tab, wrapped in
   `<div data-tour="backtest">`) — the full stat card the doc flagged.
   **Remove this UI surface entirely.**
2. `src/routes/token.$symbol.tsx:3070` (`EdgeStats` component, rendered at
   `:2249` — the compact 3-column "Hist. edge / Win rate / Risk level" row
   on the **Overview tab**, the highest-visibility spot on the page). Two of
   its three columns ("Hist. edge", "Win rate") are backtest-derived; the
   third ("Risk level", from `gradeRisk`/ATR) is real and was rated `keep`
   in the audit — it must stay. **Replace the two backtest columns**, don't
   just delete them (a 1-column grid would look broken).
3. `src/lib/ai/analyst-context.ts:141` — the AI analyst's system-prompt
   context includes a `Backtest: N trades, X% win rate, expectancy YR`
   line, with a low-sample caveat appended *only* when `lowSample` is true.
   The audit's concern (in-sample, not forward-tested) applies regardless
   of sample size — **this line needs the caveat unconditionally**, not
   just for low samples. Don't remove the line entirely: the AI analyst is
   allowed to see more than the dashboard shows, as long as it's labeled
   honestly.
4. `src/lib/engine/notifications.ts:104` (`bt = signals?.backtest`) — used
   only as an **asymmetric suppression gate**: "if backtest win rate is
   reliably below 30%, don't send this notification." It never displays
   the number to the user, never uses it to *grant* an alert, only to
   withhold one. This is the same "insufficient/weak evidence loses"
   asymmetry already established elsewhere in this codebase's verdict
   philosophy — **leave this untouched**, it is not a fake-precision
   display problem.

Given (3) and (4) still legitimately consume `runBacktest`'s output, **do
not delete `runBacktest` or `market.ts`'s `AssetSignals.backtest`
extraction** (`src/lib/engine/market.ts:330-331`) — they are not dead code.
Note this explicitly as a resolved decision (the milestone task asked to
"decide" this; the decision is: keep the function, it has two remaining
legitimate internal consumers).

## Task

**1. Remove the `BacktestEvidence` card**
- Delete the `<div data-tour="backtest"><BacktestEvidence .../></div>`
  block at `token.$symbol.tsx:2642-2644` from the "Evidence" tab. The tab's
  other content (the engine's live record, `active.record && (...)`
  immediately below) stays — the tab remains meaningful with just that.
- Delete the `BacktestEvidence` function definition (`:3467` onward) and
  its now-unused `RiskMetric`/`InfoHint` usages *only if* `RiskMetric` and
  `InfoHint` aren't used elsewhere in the file (check before deleting
  anything beyond `BacktestEvidence` itself — likely both are reused
  elsewhere, so only remove `BacktestEvidence`).
- Delete the product-tour step with `target: "backtest"` (around line
  268-271) — its target element no longer exists.
- Remove any now-unused imports this leaves behind (verify with
  `tsc`/`lint`, don't guess).

**2. Replace `EdgeStats`'s two backtest columns**
In `EdgeStats` (`token.$symbol.tsx:3070-3105`), replace the "Hist. edge"
and "Win rate" `GlanceStat`s with two real, already-computed values from
`assessment.execution.risk` (rated `keep` in the audit — objective
geometry, not a probability claim):
- "R:R to T1" — `value={`${risk.rewardRisk1}R`}`
- "R:R to T2" — `value={`${risk.rewardRisk2}R`}`
Keep the "Risk level" column exactly as-is (third position, unchanged).
Drop the now-unused `backtest`/`hasSample`/`trustworthy` local variables in
this function if nothing else in it needs them — check before removing
(the `hasSample`-gated tone logic was specific to backtest; the R:R
columns can be unconditional since risk plan values are always computed,
or use a `tone` based on `rewardRisk1 >= 1 ? "bullish" : undefined`, your
call — keep it simple and consistent with `GlanceStat`'s existing usage
style elsewhere on this page).

**3. Unconditional AI-context caveat**
In `src/lib/ai/analyst-context.ts:141`, change:
```
`- Backtest: ${e.backtest.totalTrades} trades, ${num(e.backtest.winRate)}% win rate, expectancy ${num(e.backtest.expectancy)}R${e.backtest.lowSample ? " (low sample — treat with caution)" : ""}`,
```
to always append a caveat that this is in-sample/same-chart, not a real
forward-test, e.g.:
```
`- Backtest: ${e.backtest.totalTrades} trades, ${num(e.backtest.winRate)}% win rate, expectancy ${num(e.backtest.expectancy)}R (in-sample replay on this chart's own history, not forward-tested${e.backtest.lowSample ? "; also low sample — treat with caution" : ""})`,
```
Adjust wording as needed to read naturally; keep both pieces of
information (in-sample caveat + low-sample caveat when applicable).

**4. Leave untouched**
- `src/lib/engine/notifications.ts` — no change (see Context §4).
- `src/lib/engine/quant.ts`'s `runBacktest` function and
  `SignalEvaluation.backtest` field — no change, still consumed by (3)/(4).
- `src/lib/engine/market.ts:330-331`'s `AssetSignals.backtest` extraction —
  no change (feeds `notifications.ts`'s gate).

Verify all line numbers above against current source before editing.

## Definition of Done

- The full `BacktestEvidence` card is gone from the token page; the
  "Evidence" tab still renders meaningfully (the live-record section).
- The Overview tab's glance row shows Risk level + two real R:R values
  instead of the in-sample win-rate/expectancy stats; layout still a
  balanced grid (not a broken 1-column remnant).
- The AI analyst's context line always discloses the backtest is an
  in-sample, same-chart replay, not a forward test — regardless of
  sample size.
- `notifications.ts`'s suppression gate, `runBacktest`, and
  `market.ts`'s `AssetSignals.backtest` extraction are unchanged.
- `docs/score-inventory.md`'s "Per-setup historical backtest" row gets
  " — resolved M0-T5d (UI card removed, glance row replaced, AI-context
  caveat added; runBacktest kept — still used by notifications.ts's
  suppression gate and the AI context)" appended to its Justification
  cell.
- `bunx vitest run` green, `bunx tsc --noEmit` clean, `bun run lint` 0
  errors. Update any test that asserts on `BacktestEvidence`,
  `EdgeStats`'s old columns, or the AI-context backtest line's exact
  string — don't leave a failing test.
- No changes to `evaluateSignal`'s decision/trigger output shape beyond
  what's already there (you are not changing `SignalEvaluation.backtest`'s
  type or computation, only which UI surfaces render it and how one prompt
  line is worded).

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
- Do not touch `notifications.ts`, `runBacktest`, or
  `market.ts`'s backtest extraction — see Context §4.

## Review notes from previous attempt

*None — first attempt.*
