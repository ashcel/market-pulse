# R4 — Trade review that changes behavior

Live plan. Parent: `ROADMAP-2026-07-23.md` §4 R4 (adopted, EDR 0022).
Started 2026-07-26. R1–R3 shipped 2026-07-24; R5 waits on this, R6 waits
on owner U24.

## Objective

Every closed trade tells the user what they did, in facts, and the review
names the habit. Trade → facts → named habit → the next skip-check
remembers it (R3 detectors read the same rows).

## Honesty rules (non-negotiable, test-asserted)

1. **R-multiples only where a stop is evidenced** (EDR 0017; already
   modelled as `RRMetrics.mode = r_multiple | payoff_ratio` + `coverage`).
   No stop on the trade row → percent + MAE/MFE, never R.
2. **No edge claims.** Distributions are counts and histograms. No win
   rate presented as a predicted probability, no expectancy sold as edge.
3. **Stamp-at-open is live-only.** Context is recorded while the position
   is open, never reconstructed after the fact. A trade opened before the
   stamper existed has `context: null` — it does not get a backfilled
   guess (EDR 0011 record-semantics boundary).
4. **Forensics are deterministic**, computed from exchange rows + klines.
   The AI memo may only restate rows that exist; unsupported claims are
   dropped by the groundedness check, not softened.
5. Post-hoc MAE/MFE from klines is *measurement*, not replay — permitted.
   Re-running the engine over history is replay — still deferred.

## Existing ground (verified 2026-07-26)

- `backend/app/binance_review/` — `BinanceTrade` rows already carry
  `stop_loss`, `take_profit`, `close_trigger`, `sl_slippage`,
  `tp_slippage`, `opened_at` + `open_time_source`.
- `backend/app/review/analytics.py` — 5 analytics (RR, best/worst,
  best-hour, sessions, style-fit) with a coverage-aware RR mode.
- `backend/app/worker/binance.py:179 fetch_klines` — the kline source to
  reuse for excursions. Worker syncs trades hourly at :03.
- Frontend: `routes/review.tsx` + `components/features/review-panel.tsx`
  (821 lines), `lib/review/` BYOK memo path (`prompt.ts`, `generate.ts`,
  `severity.ts`, `candles.ts`), `hooks/useReview.ts`.

## Tasks

| ID | Task | Agent | Depends on | Status |
|---|---|---|---|---|
| R4-T1 | `docs/forensics-definitions.md` + EDR 0023 (spec only, no code) | Opus | — | done |
| R4-T2 | Read-only audit: every PnL/R/excursion/win-rate consumer + stop-evidence coverage in the sync path | Haiku | — | done (`docs/review/R4-T2-audit-findings.md`) |
| R4-T3 | `app/review/forensics.py` pure compute + tests | Sonnet | T1 | done |
| R4-T4 | Forensics persistence, kline enrichment, endpoint, worker pass | Sonnet | T3 | done |
| R4-T5 | Stamp-at-open context: model + migration + worker stamper | Sonnet | T1 | done |
| R4-T6 | Frontend: per-trade forensics rows + distributions view | Sonnet | T4, T5 | done |
| R4-T7 | Grounded per-trade AI memo + groundedness check | Opus | T4 | done |
| R4-T8 | Whole-diff review against the definitions doc + honesty rules | Opus | all | done — 10 findings, all remediated 2026-07-27 (`docs/review/R4-T8-review-findings.md` §Resolution) |

Forensics set (T1 fixes the exact formulas): MAE/MFE, exit efficiency,
stop discipline, re-entry latency, sizing variance.

## Standing constraints for every agent

- No git state operations — never `stash`, `reset`, `checkout`, `rebase`,
  or commit. Leave work in the tree.
- Never run `systemctl`; never run `alembic upgrade` — migrations are
  hand-written and applied by the owner.
- Never point tests at the production DB. Pure tests only unless
  `TEST_DATABASE_URL` is set and differs from `DATABASE_URL`.
- No engine semantics touched — `engine/smc/` and
  `frontend/src/lib/engine/` decision/trigger files stay untouched. R4
  reads outcomes; it never changes what the engine decides.

## Definition of done

- Definitions doc merged before any forensics code.
- Forensics computed for every synced trade with sufficient data; missing
  data yields an explicit "insufficient data" state, never a zero.
- R appears only on stop-evidenced trades — asserted by a test that fails
  if a non-stopped trade renders an R value.
- Distributions view ships with counts/histograms only.
- AI memo cites forensics rows; the groundedness check has a failing-case
  test.
- `pytest`, `ruff`, `bunx vitest run`, `bunx tsc --noEmit`, `bun run lint`
  all green; migrations written but unapplied and flagged in PROGRESS.md.
