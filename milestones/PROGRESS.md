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

## 2026-07-17 — Phase 4 Integration + Deploy
- Implemented by: Bima (direct)
- Verdict trail: ACCEPT
- Changed: `deploy/market-pulse-api.service` (new systemd unit for FastAPI backend), `deploy/Caddyfile` (iq.heydewi.com → serve frontend static files + proxy /api/* to backend:8002), `backend/.env` (production config), `frontend/package.json` (postbuild hook auto-deploys to /var/www/market-pulse)
- Verified: `curl -sk https://iq.heydewi.com/` → 200 (HTML with Montserrat + dark theme), `curl -sk https://iq.heydewi.com/api/v1/health` → 200 (production env)
- Services: `market-pulse-api.service` (FastAPI, port 8002) enabled+running, `market-pulse.service` (old TanStack, port 3002) still running for fallback
- Needs restart: Caddy reloaded, no restart needed
- Flags for user: Old TanStack `market-pulse.service` still running on port 3002 — can be stopped once you confirm new stack works. Worker unaffected.

## 2026-07-17 — Phase 3 Vite + React Frontend
- Implemented by: Bima (direct)
- Verdict trail: ACCEPT
- Changed: `frontend/src/styles.css` (dark theme with Montserrat font), `frontend/src/pages/` (Dashboard, Tokens, TokenDetail, Regime, Trades, Settings), `frontend/src/components/` (AppLayout sidebar, ui/Button, ui/Card), `frontend/src/lib/` (utils.ts, API client), `frontend/src/main.tsx` (6 routes), deps added (shadcn/ui, recharts, lightweight-charts, lucide-react)
- Verified: `bun run build` — 0 errors, 1856 modules transformed, build in 3.58s
- Needs restart: no (not deployed yet)
- Flags for user: Font changed from Inter → Montserrat per request. Dark theme matching existing IQ styling.

## 2026-07-17 — Phase 2 FastAPI Backend scaffolding
- Implemented by: kimi-k2.7-code (subagent, timeout at 600s) + manual fix (ruff/mypy errors, Alembic revision, .env, verify)
- Verdict trail: ACCEPT
- Changed: `backend/app/` (FastAPI app with auth, market, trades modules, pagination, config, database, exceptions, worker), `backend/migrations/` (Alembic env.py + initial revision), `backend/tests/` (conftest + health test), `backend/pyproject.toml` + `uv.lock` (deps: FastAPI, SQLAlchemy async, asyncpg, alembic, arq, JWT, bcrypt, etc.), `backend/.env` (local config)
- Verified: `ruff check app/` clean (0 errors), `mypy app/` clean (0 errors), `uvicorn app.main:app` starts, `GET /api/v1/health` returns 200, `/docs` loads, `pytest tests/` passes (1 test)
- Needs restart: no (not wired to production yet)
- Flags for user: Alembic migration `b8dd766d556f` created but NOT applied (requires Phase 4 switchover — it drops existing worker tables). Alembic stamped head to sync with existing DB. Backend runs on port 8100. The old plan.md and ref.png were deleted during migration.
- Implemented by: claude-code (rank 1; single attempt)
- Verdict trail: ACCEPT (single attempt)
- Changed: `src/routes/token.$symbol.tsx` (removed `BacktestEvidence` card + its tour step + `tabForTarget` entry; replaced `EdgeStats`'s "Hist. edge"/"Win rate" glance columns with real R:R-to-target values, "Risk level" untouched), `src/lib/ai/analyst-context.ts` (backtest context line now unconditionally discloses "in-sample replay on this chart's own history, not forward-tested"). Left untouched by design: `notifications.ts`'s suppression-only gate, `runBacktest`, and `market.ts`'s `AssetSignals.backtest` extraction — both remaining consumers are legitimate (an asymmetric alert-suppression filter that never displays the number, and the AI context, now honestly labeled). `docs/score-inventory.md`'s "remove" row marked resolved with this reasoning. This closes all four M0-T5 sub-tasks; also closed the M0 top-level success-criteria bullets for the score inventory and the news-sentiment labeling (the latter was already true per M0-T4's audit, no code change needed).
- Verified: reviewer independently re-ran `bunx vitest run` (53/53, 868/868), `bunx tsc --noEmit` (clean), `bun run lint` (0 errors, same 11 pre-existing warnings). Read every hunk. The brief itself required a mid-review scope correction — the milestone task assumed one UI card, but a repo scan found `runBacktest`'s output has four consumers (the card, the glance row, the AI-context line, and the notification-suppression gate) — the brief and this implementation handled all four, not just the literal card.
- Needs restart: done — `bun run build` succeeded, `market-pulse.service` restarted, verified the old "Backtest Evidence" string is gone from the served bundle and the new R:R/disclosure copy is present; service responds 200.
- Flags for user: M0-T5 (all sub-tasks) and the two M0 success-criteria bullets it closes are done. Remaining open M0 items: M0-T6 (deploy path) and M0-T7 (transport hardening) are still open.

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
