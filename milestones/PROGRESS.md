# Progress log

Append one entry per completed task. Newest at the top. Format:

```
## YYYY-MM-DD — <task id> <task title>
- Implemented by: <tool> (attempt N; switches/failures if any, with reasons)
- Verdict trail: <e.g. HOLD (tests failed) → ACCEPT, or REJECT + reverted>
- Changed: <files/behavior, one or two lines>
- Verified: <the DoD checks actually run and their results>
- Needs restart: yes/no
- Flags for user: <anything blocked, decided, or worth reviewing — or "none">
```

User notes to the agent go anywhere in this file prefixed `@agent` and
override task order.

---

## 2026-07-16 — M0-T5c Liquidity confidence relabel + Fear & Greed fallback disclosure
- Implemented by: claude-code (rank 1; single attempt)
- Verdict trail: ACCEPT (single attempt)
- Changed: `src/lib/engine/liquidity.ts` (+additive `tier: "Strong"|"Moderate"|"Weak"` on `LiquidityPool`, derived from existing `confidence`), `src/routes/token.$symbol.tsx` (chart price-line title shows tier instead of the bare number; legend hint text updated to describe the tier), `src/lib/types.ts` (+`source: "api"|"proxy"` on `SentimentData`), `src/lib/engine/market.ts` (sets `source` based on whether the real Fear & Greed API succeeded), `src/routes/index.tsx` (Sentiment card shows "Fear & Greed (est.)" + disclosure tooltip only when the fallback proxy is active), `src/lib/engine/objectives.test.ts` (test fixture updated for the new required `tier` field). `docs/score-inventory.md`'s two rows (Liquidity pool confidence, Homepage Sentiment) marked "— resolved M0-T5c".
- Verified: reviewer independently re-ran `bunx vitest run` (53/53, 868/868), `bunx tsc --noEmit` (clean), `bun run lint` (0 errors, same 11 pre-existing warnings). Read every hunk. Confirmed via `git diff --stat` that no decision/trigger file (`quant.ts`, `intent.ts`, `objectives.ts`, `hysteresis.ts`, `tracker.ts`, `shadow.ts`, `anticipatory.ts`, `version.ts`, `server/worker/`) was touched, and specifically confirmed `LiquidityPool.confidence` (as opposed to the new `tier`) is not read by `objectives.ts`/`intent.ts` decision logic before accepting the additive field.
- Needs restart: done — `bun run build` succeeded, `market-pulse.service` restarted, verified the new tier/disclosure strings are present in the served bundle and the service responds 200.
- Flags for user: M0-T5d (remove in-sample backtest card) is the last open M0-T5 sub-task.

## 2026-07-16 — M0-T5b Regime & rotation gauges
- Implemented by: claude-code (rank 1; single attempt)
- Verdict trail: ACCEPT (single attempt)
- Changed: `src/lib/types.ts` (+`displayValue?: string` on regime pillars, +`rankAgreement: number` on `RotationData`), `src/lib/engine/market.ts` (Trend pillar → `displayValue: titleCase(btcRegime)`, Volatility pillar → `displayValue: ATR%`, rotation object → `rankAgreement: round(rho, 2)`, all additive), `src/routes/regime.tsx` (disclosure caption under the regime gauge; pillar headline renders `p.displayValue ?? p.score`), `src/routes/rotation.tsx` (Rotation Confidence label disclosure + footer now shows real ρ instead of the placeholder "RotationModel v1"), `src/routes/index.tsx` (Market Regime confidence footer disclosure), `src/components/iq/metric-card.tsx` (widened `label` prop from `string` to `ReactNode` to carry the disclosure). `docs/score-inventory.md`'s four rows (Market Regime confidence, Trend pillar, Volatility pillar, Rotation confidence) marked "— resolved M0-T5b".
- Verified: reviewer independently re-ran `bunx vitest run` (53/53, 868/868), `bunx tsc --noEmit` (clean), `bun run lint` (0 errors, same 11 pre-existing warnings). Read every hunk — confirmed pillar status/progress-bar-width logic still keys off `p.score` unchanged, the three unaffected pillars (Breadth/Momentum/Participation) still render `p.score` untouched, and no engine decision/trigger file (`quant.ts`, `intent.ts`, `hysteresis.ts`, `tracker.ts`, `shadow.ts`, `anticipatory.ts`, `version.ts`, `server/worker/`) was touched — confirmed via `git diff --stat` against that file list returning empty.
- Needs restart: done — `bun run build` succeeded, `market-pulse.service` restarted, verified the new disclosure/ρ strings are present in the served bundle and the service responds 200.
- Flags for user: M0-T5c (liquidity confidence + Fear & Greed fallback) and M0-T5d (remove in-sample backtest card) remain open.

## 2026-07-16 — M0-T5a Core engine confidence disclosure
- Implemented by: claude-code (rank 1; single attempt)
- Verdict trail: ACCEPT (single attempt)
- Changed: `src/routes/rankings.tsx` (Score/Technical/Signal column header tooltips), `src/routes/index.tsx` ("Avg Signal Score" stat card, confidence chip, Top Assets Score header), `src/routes/token.$symbol.tsx` (AI Analyst drawer Signal pill + markdown export line) — added a "heuristic checklist score, not a proven-edge probability" disclosure at every previously-undisclosed render site for the four scores derived from `evaluateSignal`'s `rawConfidence`. Left two already-compliant sites untouched (`technical.tsx`'s gauge caption, token page's "Read strength" `InfoHint`). `docs/score-inventory.md`'s four corresponding rows marked "— resolved M0-T5a".
- Verified: reviewer independently re-ran `bunx vitest run` (53/53 files, 868/868 tests), `bunx tsc --noEmit` (clean), `bun run lint` (0 errors, same 11 pre-existing warnings). Read every hunk of the diff — confirmed no `src/lib/engine/` changes, no scope creep beyond the brief's listed sites, and that the two already-compliant sites were genuinely left alone.
- Needs restart: done — user asked for it interactively same day; `bun run build` succeeded, `market-pulse.service` restarted at 19:17 CST, verified the new tooltip strings are present in the served bundle (`rankings-CjfVm-Od.js` etc.) and the service responds 200.
- Flags for user: M0-T5b (regime/rotation gauges), M0-T5c (liquidity confidence + Fear & Greed fallback), M0-T5d (remove in-sample backtest card) remain open — the score-inventory doc's other demote/remove rows aren't executed yet.

## 2026-07-16 — M0-T4 Score inventory
- Implemented by: claude-code (rank 1; single attempt)
- Verdict trail: ACCEPT (single attempt)
- Changed: `docs/score-inventory.md` (new) — every user-facing numeric/gauge/grade catalogued with definition, evidence basis, and a keep/demote-to-rank/remove/n-a decision. Notable calls: the engine's central `confidence` score and the Trend/Volatility regime pillars → demote-to-rank (rule-based heuristics overclaiming as calibrated percentages, pending the 1.0.0 verdict); per-setup in-sample "backtest" (Win rate/Avg R on the token page) → remove (duplicates the genuine tracker/shadow-record labels with much weaker in-sample evidence); Fear & Greed's silent fallback to an internal proxy → demote-to-rank. Confirmed the news keyword classifier is never labeled "sentiment" anywhere in the UI, closing that M0 success-criterion bullet independently of this doc.
- Verified: reviewer independently re-ran `bunx vitest run` (53 files/868 tests green), `bunx tsc --noEmit` (clean), `bun run lint` (0 errors, 11 pre-existing warnings) — did not just trust the implementer's self-report. Spot-checked ~5 of the doc's formula/line-number claims (market.ts confidence/regime pillars, quant.ts rawConfidence, liquidity.ts weights) directly against source — all exact matches. Verified the "not outcome-peeking" claim for describing the Live Record card against `research/verdict-protocol-1.0.0.md` §8, which explicitly carves out normal-UI exposure.
- Needs restart: no (docs only, no UI/engine changes)
- Flags for user: M0-T5 (execute the remove/demote rows) is next and will require actual UI changes — until then this success criterion is only half-met (doc exists, but "remove" rows are still live in the UI).

## 2026-07-15 — M0-T3 Homepage reframe
- Implemented by: claude-code (rank 1; single attempt)
- Verdict trail: ACCEPT (single attempt)
- Changed: `src/routes/index.tsx` — "Today's Edge" → "Tape Overview"; "Actionable Setups" → "Engine Reads" with "Forward test in progress" sublabel; tour steps, data-tour attributes, empty-state copy, and comments updated. Display-text only, no data-layer changes.
- Verified: `bun run lint` → 0 errors (11 pre-existing warnings), `bunx tsc --noEmit` → clean, `bunx vitest run` → 53 files / 868 tests green
- Needs restart: yes (the live service serves the homepage; a restart picks up the new route bundle)
- Flags for user: Screenshots cannot be captured headlessly in cron context — please verify visually that homepage no longer implies proven edge. Tour seen-key NOT bumped (v2) — users who dismissed the tour won't see reworded steps unless they reopen via the help button; bump to v3 if desired.

## 2026-07-15 — M0-T2 Write EDR 0017 (product direction)
- Implemented by: claude-code (rank 1; single attempt)
- Verdict trail: ACCEPT (single attempt)
- Changed: `docs/decisions/0017-product-direction.md` (new EDR), `CLAUDE.md` (linked from Architecture section)
- Verified: `bun run lint` → 0 errors (11 pre-existing warnings), `bunx tsc --noEmit` → clean, `bunx vitest run` → 53 files / 868 tests green
- Needs restart: no
- Flags for user: none

## 2026-07-15 — M0-T1 Land the in-flight work
- Implemented by: codex (rank 2; rank 1 claude-code timed out after 180s)
- Verdict trail: ACCEPT (single attempt)
- Changed: `src/server/db/eval-log.ts`, `src/server/db/eval-log.test.ts`, `src/server/worker/eval-pass.ts`, `src/server/worker/eval-pass.test.ts` — replaced `any` types with `Record<string, unknown> | null` for componentScores, added eslint-disable directive for test placeholders, fixed prettier formatting (trailing commas, whitespace, trailing newlines)
- Verified: `npm run lint` → 0 errors (11 pre-existing warnings in unrelated files), `npx tsc --noEmit` → clean, `npx vitest run` → 53 files / 868 tests green
- Needs restart: no
- Flags for user: none

## 2026-07-15 — D-T0 Tool availability check
- Implemented by: agent-orchestrated (no delegated code)
- Verdict trail: ACCEPT (dry-run via Claude Code → HOLD/restore → ACCEPT commit)
- Changed: `milestones/DELEGATION.md` — tool roster table updated with verified invocations
- Verified: Claude Code v2.1.209, Codex v0.139.0, Antigravity v1.1.2 all installed and working. Full delegation loop exercised: SNAPSHOT→BRIEF→DELEGATE→REVIEW→VERDICT→RESTORE. Dry-run brief written to `milestones/briefs/D-T0-dry-run.md`, comment added by claude-code, restored.
- Needs restart: no
- Flags for user: none

(no entries yet — plan created 2026-07-14)
