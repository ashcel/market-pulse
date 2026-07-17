# Migration Progress

Tracks execution of `migration_plan.md` (condensed) / `docs/migration-plan.md`
(approved detail, 2026-07-16). One entry per phase; batches reference commits.

## Phase 0 — Scaffold + Standards ✅ (2026-07-17)

Commit `a024433`. Gate result recorded in `docs/migration-plan.md`: `bunx tsc`
clean, 868/868 legacy tests green, ruff/mypy-strict/pytest green in `engine/`
+ `backend/`, `/api/v1/health` smoke OK on 8002, prod 200 through Caddy, uvicorn
+ arq units installed-disabled. Nothing flipped.

## Phase 1 — Port Engine to Python ✅ (2026-07-17)

All 14 steps of the condensed plan ported to `engine/smc/`, each with its
`.test.ts` suite (or new pins where the TS module had none):

- Batch 1 (`7a2204f`): types, mock_candles, structure, analysis, zones,
  liquidity, strength, equilibrium
- Batch 2 (`145f6b5`): fvg, orderblocks, sessions, objectives, poi
- Batch 3 (`aa61933`): quant (`evaluate_signal` core)
- Batch 4 (this commit): market (snapshot read models + UNIVERSE /
  WORKER_UNIVERSE), discovery (opportunity scan), rs_scan, macro, plus deps
  relative, spike, trend_transition, crypto_config, location, perp

**Gate:** 230 pytest green (incl. Dreimann ground-truth fixture pins, ported
verbatim), `ruff check` clean, `mypy --strict` clean (46 files).

Port stance: fetchers/caches/server functions are backend concerns — the
engine computes over candles/payloads it is given (`build_snapshot`,
`score_opportunities`, `compute_rs_rows`, `scan_spikes` take injected data).
Ranked-candidates contract preserved (preferred = `[0]`).

**Deferred to the verdict-plane batch** (needed for the worker, Phase 4 of the
detailed plan, not for Phase 2/3 data+API work): intent, triggers, hysteresis,
setup_validity, shadow, anticipatory, tracker, evaluate (`evaluate_symbol`),
and version.py (`ENGINE_VERSION = "2.0.0"`) — version's `config_hash` reads
hysteresis' `INTENT_MAX_HOLD_BARS`, so it lands with that batch.

## Phase 2 — FastAPI Backend 🚧 (in progress, uncommitted)

WIP in the working tree from a prior session (not this commit): SQLAlchemy
`Base` + naming conventions in `database.py`, domain scaffolds
`app/auth|market|trades` (models/router/service/schemas), Alembic init
(`alembic.ini`, `migrations/`, no revision yet), `pagination.py`.
Known red as of 2026-07-17: backend pytest fails on missing `email-validator`
dep, 36 ruff errors (35 auto-fixable), 6 mypy errors, Alembic not yet
reconciled/stamped against the live schema (see detailed plan Phase 2 gate).

## Phase 3 — Vite + React Frontend ⏳

Scaffold only (Phase 0). Pages/queries not started.

## Phase 4 — Integration + Deploy ⏳

Not started. Caddy seam is live (everything still proxies to the old app).
