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

## Phase 2 — FastAPI Backend ✅ core slice (2026-07-17)

Domain scaffolds `app/auth|market|trades` (models/router/service/schemas),
`pagination.py`, dual auth in `get_current_user_id` (JWT Bearer **or**
X-Internal-Key + X-Internal-User-Id for server-to-server calls from the
TanStack proxy; constant-time key compare).

**Alembic reconciled against the live DB (zero row loss):** `52bfd16edb58`
rewritten from a destructive autogenerate (it would have dropped every legacy
forward-test table) to an explicit **no-op baseline** — the legacy schema
stays owned by the hand-written SQL migrations and was stamped, not migrated.
`b8dd766d556f` is purely additive (tokens/signals/trades tables +
`users.hashed_password/updated_at`, both nullable). Live DB verified at head;
`alembic upgrade head` is a no-op; legacy rows intact (1,165 shadow_signal).
`migrations/env.py` now falls back to app settings (.env) for the DB URL.

**Gate (2026-07-17):** ruff clean (migrations get scoped per-file ignores),
`mypy --strict` clean, 9 pytest green incl. a new `tests/test_trades.py`
round-trip suite (CRUD, auth, cross-user 403, validation) on ephemeral SQLite.

## Phase 3 — Vite + React Frontend 🚧 (trades slice done, 2026-07-17)

Strangler stance: the legacy TanStack app (now `frontend/`) proxies to
FastAPI instead of a separate SPA-first cutover. First slice shipped:

- `lib/api/client.ts` (typed envelope client), `hooks/useTrades.ts`
  (TanStack Query CRUD hooks), `routes/trades.tsx` (journal page),
  `routes/api/trades(.$id).ts` (session-cookie → internal-key proxy).
- Smoke-tested end-to-end 2026-07-17: session cookie → proxy (3010 dev) →
  FastAPI (8002, live systemd unit) → Postgres; CRUD + 401/403 paths green;
  smoke rows/session cleaned up after.
- Gate: `bunx tsc` clean, ESLint 0 errors, 868/868 vitest green.
- Not yet: nav entry for `/trades` (layout intentionally untouched), market/
  auth/notifications slices still on legacy server functions.

## Phase 4 — Python worker cutover ✅ (2026-07-17)

The detailed plan's Phase 4 (worker), executed in one move per the 2026-07-17
owner decision (1.0.0 record disposable — no dual-writer shadow period):

- **Engine verdict plane ported** (commit `91b16d6`): intent, hysteresis,
  tracker, shadow, anticipatory, setup_validity, evaluate, version —
  `ENGINE_VERSION = "2.0.0"`, forward-test clock reset to n=0. 323 engine
  tests green (incl. Dreimann zec-sl pins through the fill model).
- **Backend FT domain + reset migration** (commit `4ab7524`): models mirror
  the legacy table shapes so `/api/forward-test` keeps working; Alembic
  `e14f3eedc8b5` dropped + recreated the FT tables (1.0.0 record destroyed,
  authorized; tracked_signal truncated; users/sessions/trades/token_event
  untouched — verified). asyncpg timestamptz bind fix found by live smoke
  (`7975b9a`).
- **Cutover executed 2026-07-17 ~12:39 UTC**: `market-pulse-worker.service`
  stopped + disabled; `market-pulse-arq.service` enabled (cron tick every
  5min, run_at_startup). First pass: 50 spot + 50 perp evaluated in ~45s,
  15 shadow + 149 anticipatory opened, 400 eval_log rows — all stamped
  `2.0.0 / cfg 7048e1a5`. Idempotency proven through the app repo layer
  (double-open no-op, settle frees the slot). Legacy health view reads the
  new engine_run rows; the cron health probe stays valid.

**Gap closed same day (commit `16a4b50`):** event_pass + context_pass ported
(engine: news_rss/token_events/asset_ids/catalyst_events/external_context, 34
tests → 357 total; backend: ingest_repo + both passes on 15-min gates inside
the tick). Live smoke: all 3 RSS feeds ok, 51 events classified, 0 inserted —
every dedup key matched the TS worker's morning rows, a cross-language parity
proof for the classifier. Breadth/calendar report `unconfigured` (provider
keys still pending user action, same as before cutover).

## Phase 5/6 — Frontend + cutover ✅ as re-scoped (2026-07-17)

The monorepo refactor (`ed9009f`) made the existing Vite + React 19 TanStack
app *the* frontend — parity by identity, layout untouched per owner
instruction — retiring the from-scratch SPA checklist. `/src` is gone;
`iq.heydewi.com` serves the monorepo stack; deploy.yml rebuilt for
uv/alembic/api/arq (no longer touches the retired TS worker); CI covers
frontend+engine+backend; CLAUDE.md rewritten. Full reconciliation:
`docs/migration-plan.md`.

**MIGRATION COMPLETE (2026-07-17).** Record plane Python end-to-end (engine
2.0.0, FastAPI, arq worker incl. ingestion); web tier is the retained React
app. Post-migration roadmap (optional): market-read API flip, cookie→JWT EDR
if SPA-only is revived, provider API keys for breadth/calendar.
