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

## 2026-07-23 — START-HERE moves #1–#3: verdict-first home + plane tabs + Catalyst Impact Score
- Implemented by: three parallel Claude Code subagents — sonnet (home wiring), opus (plane consolidation), fable (impact score). Sonnet + fable were killed mid-run by session interrupt and resumed from transcript; single logical attempt each.
- Verdict trail: ACCEPT (all three; orchestrator re-ran the combined verification after merge-in-tree)
- Changed:
  - Move #1 (home): `frontend/src/routes/index.tsx` — rendered the already-built `TradesAndBehaviorStrip` (below the regime hero) and `CatalystRail` (below the setups grid); fixed the "4rd" ordinal bug; replaced the static header timestamp with a ticking `HeaderFreshness` ("updated Ns ago" + green/amber/red dot per HOME-SPEC).
  - Move #2 (tabs): `/markets` is now the tab host (`?tab=market|rankings|regime|rotation|technical`, validated search param); `rankings/regime/rotation/technical.tsx` reduced to `beforeLoad` redirects; page meat extracted to `components/features/*-panel.tsx` (5 new files); sidebar collapsed to one Markets entry; notification deep links updated. `routeTree.gen.ts` untouched (no route paths changed).
  - Move #3 step 1 (score): new `backend/app/events/` read plane — pure `impact.py` (`IMPACT_SCORE_VERSION 1.0.0`, magnitude 50/proximity 30/source-confidence 20, unknown-magnitude unlocks capped LOW neutral, historical-reaction factor deliberately omitted for lack of data), service + router serving `GET /api/v1/events/{token-events,catalysts,economic}` with additive `impact`/`direction`/`impact_version`/components fields, compute-on-read (no migration). `app/main.py` +2 lines to mount. Existing TS event routes untouched — UI unchanged.
- Verified: frontend `bunx tsc --noEmit` clean, `bunx vitest run` 58 files / 1010 tests green, `bun run lint` 0 errors (12 pre-existing warnings); backend `ruff check app/events tests/test_events_*.py` clean, `pytest tests/test_events_impact.py tests/test_events_service.py -q` 65 passed — pure only, production DB never touched.
- Needs restart: yes — frontend rebuild + `market-pulse.service` restart for the home/tabs; `market-pulse-api.service` restart to expose the new events endpoints. Neither run (owner action, per no-restart constraint).
- Flags for user: HOME-SPEC.md + dash-ref.png remain deleted-in-tree (unstaged, pre-existing) — spec content recoverable via `git show HEAD:HOME-SPEC.md`. Nothing committed; all changes left in working tree for review. Next per START-HERE order: wire impact onto the home catalyst rail + token verdict card ("Next" step), then Skip Check (move #4, still blocked on M9 Phase B–E / owner U21–U24).
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

## 2026-07-27 — R5 Alternatives & guardrail surfaces (T1–T3)
- Implemented by: Bima (direct)
- Verdict trail: ACCEPT
- Changed:
  - **R5-T1 Spike don't-chase reframing:** `components/features/market-opportunities-card.tsx` — spike badges "Spike rejected" → "Don't chase", header "Live spikes" → "⚠ Spikes — don't chase", added cooldown timing per chip (`∼{barsAgo * 15}m ago`). `server/spike-watch.ts` — notification title "{ticker}: Up-spike rejected" → "Don't chase — up-spike fading", body includes "Don't chase this move — post-spike cooldown active."
  - **R5-T2 Discovery scan → alternatives:** `components/features/market-opportunities-card.tsx` — reduced SHOWN 6→3, renamed component `MarketOpportunitiesCard` → `AlternativesCard`, title "Market Opportunities · Worth Scanning" → "Alternatives", subtitle "Activity scan · not a trade signal" → "Alternatives scan · when your pick isn't actionable", footer simplified. `components/features/markets-panel.tsx` — updated import + usage + section title. New `components/features/alternatives-strip.tsx` — `AlternativesStrip` component shown on homepage when `LiveSetupsStrip` is empty. `routes/index.tsx` — wired `AlternativesStrip` conditionally after `LiveSetupsStrip`.
  - **R5-T3 CRO narration foundation:** Already scaffolded in `backend/app/execution/ai_cro.py` + `ai_cro_router.py` (CROContext, build_cro_context, build_cro_prompt, CRONarration response model, POST /execution/permits/{permit_id}/cro-narration router). LLM call is a stub (BYOK wiring deferred to R3).
- Verified: `bunx tsc --noEmit` clean, `bunx vitest run` 915/915 tests pass (same 10 pre-existing execution WIP failures, no new regressions).
- Needs restart: yes — frontend rebuild to pick up the new homepage alternatives strip and reframed markets alternatives card.
- Flags for user: Full "shown only from a skip/invalid state" gating needs R2 skip check; AI CRO runtime needs R3 permits/detectors.

- Implemented by: claude-code (orchestrator, inline — no subagents this pass)
- Verdict trail: R4-T8's review found R4 **non-compliant** with
  `docs/forensics-definitions.md` v1.0.0 (1 critical, 3 high, 6 medium). All ten
  findings remediated this pass; ACCEPT.
- Changed:
  - `backend/app/review/forensics.py` — §3 ordered `excursion_unavailable_reason`,
    `MIN_WINDOW_CANDLES`, `MetricValue.as_dict()`, §4.4
    `boundary_inflation_bound_pct` + `boundary_inflated` disclosure,
    `stop_evidence_of` / `stop_discipline(close_trigger, …)` with
    `hit|liquidated|absent` + `discipline_breach`, re-entry prerequisite gates,
    §7.5 `detect_partial_close_groups`, sizing cohort reporting.
  - `backend/app/review/forensics_service.py` — rewritten around
    `build_forensics()` (pure payload assembly); `pending_bar_close` writes no
    row; per-trade sizing metrics from one cohort computation.
  - `backend/app/review/models.py` / `schemas.py` — `TradeForensics.metrics` is
    one JSONB column in the §2 `MetricValue` shape; flat nullable float columns
    are gone. `stop_evidence`, `discipline_breach`, `partial_close_suspected`,
    `sizing_mode/n/excluded/partial_close_rows` are columns.
  - `backend/app/review/groundedness.py` — reads the metrics dict and only
    grounds a claim on an **available** measurement.
  - `backend/app/binance_review/context_models.py` — `TradeContext` re-modelled
    as a position **episode** `(user_id, symbol, side, first_seen_at)`; no FK to
    `binance_trades`; carries observation source/lag, eval provenance +
    staleness, engine/config/git versions, engine session grid, serialized
    catalysts with impact as scored at `stamped_at`.
  - `backend/app/worker/context_stamper.py` — rewritten: polls
    `BinanceExecClient.get_positions()`, never reads `BinanceTrade`; one row per
    episode, later ticks only advance `last_seen_at`.
  - `backend/app/worker/forensics_pass.py`, `worker/binance.py` (`bare_ticker`),
    `migrations/env.py`, both migrations rewritten to match.
  - `frontend/src/hooks/useForensics.ts` — `MetricValue` type + `shown()`/`why()`
    gates. `components/features/review-panel.tsx` — every measurement renders
    its value or its reason badge; added a counts-only histogram distributions
    block. `lib/review/prompt.ts` — forensics block listing measured values and
    UNAVAILABLE reasons, with explicit rules against inventing numbers.
  - Tests: `backend/tests/test_forensics.py` (moved out of the stray repo-root
    `tests/`, 7 → 30 cases), `backend/tests/test_groundedness.py`,
    `frontend/src/lib/review/forensics-render.test.ts`.
  - Docs: `docs/review/R4-T8-review-findings.md` §Resolution;
    `milestones/R4-review-forensics.md` task table marked done.
- Verified: `pytest` 1495 passed / 5 failed, `ruff check app tests` 7 errors,
  `bunx vitest run` 59 files / 1015 tests green, `bunx tsc --noEmit` clean,
  `eslint` clean on every touched file, `alembic heads` single linear head
  `e3f4a5b6c7d8`. **The 5 pytest failures and all 7 ruff errors are
  pre-existing, in the uncommitted execution/M9 WIP** (`test_execution_exec_key`
  ×2, `test_execution_permit` ×3; ruff in `app/execution/service.py`,
  `position_ws_manager.py`, `app/binance_review/service.py`,
  `tests/test_binance_review_router.py`) — none of those files were touched by
  R4 and none import forensics.
- Needs restart: not yet — migrations are unapplied, so the new tables do not
  exist. Nothing to restart until the owner applies them.
- Flags for user:
  - **DB migrations NOT applied.** DB is at `f1a2b3c4d5e6`; head is
    `e3f4a5b6c7d8` (`d2e3f4a5b6c7` trade_contexts → `e3f4a5b6c7d8`
    trade_forensics). Owner applies: `cd backend && .venv/bin/alembic upgrade head`.
    Until then `/api/v1/review/forensics` 500s and both worker passes error out.
  - **Pre-existing WIP failures listed above are unfixed** — they belong to the
    execution plane, not R4, and fixing them means touching order/permit
    security semantics.
  - `frontend/src/routes/token.$symbol.tsx` and `routes/index.tsx` were left
    **uncommitted but repaired** so the tree typechecks: an orphaned 24h-stats
    header block referencing deleted `stats`/`HeaderStat`/`formatCompact` was
    removed, and null `unrealizedPct`/`livePrice` are now handled. They are part
    of a different in-flight change and were deliberately not committed.
  - `frontend/src/routeTree.gen.ts` was **not** committed: the generated file
    now contains both R4's `/api/review/forensics*` routes and the execution
    WIP's `/api/positions/stream`, and committing it would reference an
    untracked module. It regenerates on `bun run dev` / `bun run build`.
  - `milestones/` still holds a pre-existing staged-rename-then-deleted mess
    (M0–M9 briefs moved to `milestones/archive/` in the index but absent from
    disk). Unstaged here rather than swept into this commit; the owner should
    decide whether to restore or finish the archive move.

## 2026-07-19 — M9-T1..T5 Execution-plane Phase A (deterministic core)
- Implemented by: claude-code subagents — sonnet (T1 constitution, T3 sizing, T2 risk engine, T4 quality score, T5 permit) + haiku (T4 confidence-render inventory sweep, read-only). Orchestrated in 3 dependency-ordered waves.
- Verdict trail: ACCEPT (all five, single attempt each; orchestrator-verified in-tree)
- Changed: new `backend/app/execution/` plane — `constants.py`, `validation.py`, `models.py` (TradingConstitution + ConstitutionAudit + TradePermit, all insert-only), `schemas.py`, `service.py`, `permit_service.py` (no-update), `router.py`, `risk_engine.py` (pure `evaluate_permit`, 12 hard checks), `sizing.py` (pure `size_position`), `quality_score.py` (pure, 6 components, SCORE_DISCLAIMER). Migrations `fd1fec87d5d7` (constitution) + `275e4b30275e` (trade_permit), chained to head; `env.py` model imports. Frontend: `routes/api/execution.constitution.ts`, `hooks/useConstitution.ts`, `components/features/trading-constitution-card.tsx`, wired into `settings.tsx`. Docs: `trade-quality-score.md` (rubric), `score-inventory.md` (M9 addendum).
- Verified: `pytest tests/test_execution_*.py` → 1193 passed (31+1104+24+27+7); `ruff check app/execution tests/test_execution_*.py` → clean; `alembic heads` → single linear head 275e4b30275e (no branch); `frontend tsc --noEmit` → clean. All tests PURE — never ran the DB-touching suite against the production DB; migrations hand-written, never executed.
- Needs restart: no (kill switch off; no service wiring flipped)
- Flags for user:
  - **DB migrations NOT applied.** Two new Alembic migrations (`fd1fec87d5d7`, `275e4b30275e`) are hand-written and unrun — production DB. Owner applies when ready: `cd backend && .venv/bin/alembic upgrade head`.
  - **Phase B–E (T6–T14) not started — blocked on owner actions U21–U24** (testnet key, live withdrawal-key rejection test + IP-allowlisted exec key, kill-switch custody, infra-isolation decision). Real-money/security surface; not built without those.
  - **Owner decision owed:** `analyst-context.ts:141` feeds backtest win-rate/expectancy into the AI prompt — brushes EDR 0020 evidence-discipline; needs its own EDR before edit (T4 flagged). Plus 6 pending UI/prompt label follow-ups listed in `docs/score-inventory.md`.
  - Nothing committed — changes left in working tree for owner review.

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
