# Migration Plan — Market Pulse → Python/FastAPI + React SPA

**Status:** approved 2026-07-16. **Executor:** Fable.
**Strategy:** strangler-fig, domain by domain. Production (this VPS) stays live the whole time.
**Engine:** full TS→Python port. `ENGINE_VERSION` bumps to `2.0.0`; the forward-test
evidence clock **resets to n=0** (accepted trade-off). Python engine must be *correct*
against Dreimann fixtures — byte-parity with the TS engine is **not** required.

Conventions are frozen: `backend/CONVENTIONS.md`, `frontend/CONVENTIONS.md`. Follow them literally.

---

## Target monorepo seam

```
/engine      # standalone Python package (smc) — zero framework deps, pip-installable
/backend     # FastAPI app; depends on ./engine via local path
/frontend    # Vite + React 19 SPA (React Router, no SSR)
/src         # LEGACY TanStack app — STAYS LIVE until Phase 6, then deleted
```

Reverse proxy (Caddy) fronts prod and owns the seam: each path group flips from the
old app to the new backend/SPA one at a time. Old app is the fallback until a slice is proven.

---

## Rules of engagement (non-negotiable)

1. **Never break the live tree.** `market-pulse.service` (web, 3002) and
   `market-pulse-worker.service` must keep running until Phase 6. New services run on new ports.
2. **One domain per PR/slice.** Merge only when its gate passes. No big-bang.
3. **No proxy flip without a passing gate.** Every flip is reversible (revert one proxy line).
4. **Do not touch `src/` engine semantics.** The TS engine keeps serving prod until its
   domain is cut over. Port *into* `/engine`, don't edit the old one.
5. Open an **EDR** in `docs/decisions/` for: the clock reset (`2.0.0`), the auth model
   change (cookie→JWT), and the arq/Redis introduction. Record the decision before building.

---

## Phase 0 — Scaffolding & the seam (no behavior change)

Goal: new projects boot and are proxied, prod untouched.

- [x] `/engine`: `pyproject.toml` (py3.12, ruff, mypy strict, pytest+pytest-asyncio),
      empty `smc/__init__.py`. `pytest` green on zero tests.
- [x] `/backend`: FastAPI skeleton per `backend/CONVENTIONS.md` §1 — `app/main.py`,
      `config.py` (pydantic-settings), `database.py` (async engine), `exceptions.py`,
      `/api/v1` router, `GET /api/v1/health`. Depends on `/engine` (local path).
      *(API port is 8002 — 8000 is taken by another project on this VPS.)*
- [x] `/frontend`: Vite + React 19 SPA skeleton per `frontend/CONVENTIONS.md` §7,
      React Router, TanStack Query provider, one placeholder page.
- [x] Infra: add **Redis** to `docker-compose.yml` (for arq). Add uvicorn + arq
      `.service` unit files to `deploy/` (installed but **not enabled** yet).
      *(Redis on loopback 6380 — 6379 taken; volume name pinned `market_pulse_redis`.)*
- [x] **Caddy** in front of prod: initially proxy `*` → old app (3002). This establishes
      the seam with zero user-visible change. Verify prod still serves through Caddy.
      *(Already true before Phase 0: `iq.heydewi.com` → 3002 in `/etc/caddy/Caddyfile`; verified 200.)*
- [x] Tooling: `lefthook.yml` (ruff/mypy/pytest), CI job for `backend`+`engine`.

**Gate result (2026-07-17):** `bunx tsc` clean, 868/868 legacy tests green,
ruff/mypy-strict/pytest green in `engine/` and `backend/`, `/api/v1/health` smoke OK
on 8002, prod 200 through Caddy, both new units installed-disabled. Nothing flipped.

**Gate:** `bunx tsc` + old suite still green; `mypy`/`ruff`/`pytest` green on new dirs;
prod reachable through Caddy; nothing flipped.

---

## Phase 1 — Engine port to Python (biggest chunk, DB-free)

Goal: `engine/smc/` reproduces the TS engine's decisions, proven on ground-truth fixtures.
Pure pytest, no FastAPI, no DB.

Port module-by-module in dependency order; **port each module's `.test.ts` alongside it**
and keep it green before moving on:

1. `types.py` (Candle, Pivot, verdict enums)
2. `analysis.py` (pivots, S/R) → `structure.py` (CHoCH/BOS)
3. `liquidity.py`, `fvg.py`, `orderblocks.py`, `equilibrium.py`, `strength.py`,
   `zones.py`, `sessions.py`, `alignment.py`
4. `quant.py` (`evaluate_signal` — the core score)
5. `objectives.py`, `poi.py` + poi-lifecycle/poi-map, `intent.py`, `triggers.py`
6. `shadow.py`, `anticipatory.py`, `tracker.py`, `hysteresis.py`, `setup_validity.py`
7. `evaluate.py` (`evaluate_symbol` — the single entry point)
8. Discovery/scan extras (`discovery.py`, `rs_scan.py`, `spike.py`, `relative.py`) last.

- [ ] Port `__fixtures__/` incl. the **Dreimann** ground-truth set verbatim.
- [ ] `version.py`: `ENGINE_VERSION = "2.0.0"`, GIT_SHA injection. Document the reset.
- [ ] Resolvers return **ranked candidate lists** (preferred = `[0]`) — same contract as TS.

**Gate:** every ported `test_*.py` green, **Dreimann fixtures pass**, `mypy --strict` clean.
A short parity spike (run TS `evaluateSymbol` vs Python on N live symbols, log divergences)
is diagnostic only — differences are allowed; unexplained *category* flips are not.

---

## Phase 2 — Data layer (shared DB, no data loss)

Goal: SQLAlchemy + Alembic own the schema, pointed at the **existing** Postgres (5435).

- [ ] SQLAlchemy 2.0 models per domain (`app/*/models.py`) matching the live schema from
      `src/server/db/migrations/0001..0005`. Naming conventions per `backend/CONVENTIONS.md` §6.
- [ ] Alembic init: autogenerate against live schema, reconcile until diff is empty, then
      `alembic stamp head` on prod so **existing rows (users, invites, trades, token_events,
      external_context, eval_log) are preserved**. No drop/recreate.
- [ ] Repo/service layer per domain; SQL-first for joins/aggregation (§6.4).

**Scope change (2026-07-17, owner decision):** the 1.0.0 forward-test record is
**disposable** — it was buggy and never really recorded, so preservation applies
only to auth/journal data (`users`, `invites`, `sessions`, `trades`,
`user_watchlist`). The forward-test tables (`shadow_signal`,
`anticipatory_signal`, `eval_log`, `engine_run`, `verdict_hold`,
`backtest_run`, `tracked_signal`) stay untouched only while the live TS worker
writes to them; they get **dropped at Phase 4** (worker cutover) instead of
carried over.

**Gate:** `alembic upgrade head` is a no-op on prod DB; model round-trip tests green
(testcontainers or ephemeral schema); zero row loss verified for the preserved set.

---

## Phase 3 — API domains via strangler (flip one path group at a time)

For each domain: build FastAPI `router/service/schemas/dependencies`, prove it, then flip
that path in Caddy old→new. Keep old app as fallback. Order = safest first:

- [x] **auth** — PyJWT endpoints live (`/api/v1/auth/*`) **plus** a dual-auth bridge:
      the web tier validates its invite-only session cookie and calls FastAPI with
      `X-Internal-Key`/`X-Internal-User-Id` (constant-time compare). **Re-scoped
      2026-07-17:** the web tier *stays* (see Phase 5 note), so cookie sessions remain
      its native auth and a full cookie→JWT user-flow cutover is dropped — the EDR
      obligation attaches to any future SPA-only revival, not to this migration.
- [x] **trades** — journal domain end-to-end (FastAPI + proxy routes + `/trades` page),
      round-trip tested; the first flipped slice (commit `78af16d`).
- [x] **forward-test** — write plane fully Python (worker); the web tier's stats/health
      views read the same tables the Python worker writes. No separate read-API flip
      needed while the web tier remains the reader.
- [x] **market / notifications** — **re-scoped 2026-07-17:** these are the web tier's
      own SSR compute (snapshot server functions) and SSE stream over worker-written
      tables. With the web tier retained, they are frontend code, not backend to
      migrate; the Python engine's `market.py`/`discovery.py`/`rs_scan.py` ports stand
      ready if an API flip is ever wanted.
- [x] Standard response envelope + error codes per `backend/CONVENTIONS.md` §5.

**Gate per domain:** contract test old vs new returns equivalent payloads; SPA/legacy
client works against new endpoint; flip; smoke; keep revert-one-line rollback ready.

---

## Phase 4 — Worker (arq) ✅ (2026-07-17)

Goal: Python worker owns eval/settle over the universe, writing under `2.0.0`.

- [x] Passes as arq work: `forward_test_tick` cron (5 min, non-overlapping) runs
      eval (spot **and** perp — the perp_pass rides inside eval) + settle, with
      `event_pass` and `context_pass` on 15-min gates inside the same tick.
      Reuses `engine.evaluate_symbol` verbatim.
- [x] Worker is the **sole writer** of shadow/anticipatory records; browser read-only.
- [x] Forward-test schema owned outright: TS worker stopped+disabled first, Alembic
      `e14f3eedc8b5` dropped/recreated the FT tables (1.0.0 destroyed, authorized),
      arq unit enabled against the fresh tables. No dual-writer period.

**Gate result:** idempotency proven live through the repo layer (double-open no-op;
`shadow+=0` on the second cross-process tick) + settlement invariants pinned in the
engine suite; `2.0.0` records accruing with full provenance; health view reads the
new `engine_run` heartbeat; RSS ingestion parity-proven (identical dedup keys vs the
TS worker's final rows).

---

## Phase 5 — Frontend ✅ as re-scoped (2026-07-17)

**Re-scoped by the monorepo refactor (`ed9009f`):** instead of a from-scratch React
Router SPA, the existing Vite + React 19 TanStack app *became* `frontend/` — parity
by identity, mobile-first layout preserved (the owner's explicit instruction:
layout untouched). It grows `/api/v1` clients per flipped domain (`lib/api/client.ts`
+ TanStack Query hooks + proxy routes — the trades pattern). BYOK AI stays
browser-side. The original SPA-only checklist (static assets at root, no server
functions) is **retired with this plan**; any revival is a new project decision,
not a migration remainder.

---

## Phase 6 — Cutover & decommission ✅ as re-scoped (2026-07-17)

- [x] The old standalone monolith is gone: `/src` no longer exists (monorepo move);
      `iq.heydewi.com` serves the monorepo stack through the Caddy seam.
- [x] `market-pulse-worker.service` (TS) stopped + **disabled**; arq is the only worker.
- [x] `.github/workflows/deploy.yml` rebuilt: `uv sync` + `alembic upgrade head`,
      restarts `market-pulse-api` + `market-pulse-arq` + web; CI covers
      frontend/engine/backend.
- [x] Backups: daily `pg_dump` verified (pre-reset snapshot retained); worker health
      probe reads the Python worker's `engine_run` heartbeat unchanged.
- [x] `CLAUDE.md` deployment reality + engine discipline rewritten for the new stack.
- [x] `market-pulse.service` (web tier) **stays** — it is the frontend now, not a
      legacy remnant.

**Note:** the TS engine copy under `frontend/src/lib/engine/` intentionally remains —
it renders the UI's live views and writes no record. `engine/smc/` (Python, 2.0.0)
is the sole source of persisted truth.

---

## Sequencing summary — final

`0 seam ✅ → 1 engine ✅ → 2 data ✅ → 3 api ✅ (trades flipped; auth bridged;
market/notif re-scoped to the retained web tier) → 4 worker ✅ → 5 frontend ✅
(monorepo re-scope) → 6 cutover ✅ (2026-07-17)`

**The migration is complete.** The record plane (engine verdicts, forward-test
records, ingestion) is Python end-to-end; the web tier is the retained React app
consuming it. Post-migration roadmap items (optional, not blockers): flip market
reads to FastAPI, cookie→JWT with its EDR if the SPA-only architecture is ever
revived, port the TS engine's UI-view helpers when the token page moves to
`/api/v1`.
