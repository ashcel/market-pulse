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

**Gate:** `alembic upgrade head` is a no-op on prod DB; model round-trip tests green
(testcontainers or ephemeral schema); zero row loss verified.

---

## Phase 3 — API domains via strangler (flip one path group at a time)

For each domain: build FastAPI `router/service/schemas/dependencies`, prove it, then flip
that path in Caddy old→new. Keep old app as fallback. Order = safest first:

- [ ] **auth** — PyJWT (not python-jose), `Annotated[..., Depends]`, `get_current_user`.
      Migrate invite-only session model → JWT; EDR the change. Flip `/api/v1/auth/*`.
- [ ] **market** (read-only, lowest risk) — snapshot/rankings/regime/rotation endpoints
      backed by the Python engine. Flip `/api/v1/market/*`, `/api/v1/tokens/*`, klines.
- [ ] **forward-test / trades** — stats + health read models, journal. Flip its paths.
- [ ] **notifications** — SSE (this stack has **no WebSocket** server; use SSE, per house rule).
- [ ] Standard response envelope + error codes per `backend/CONVENTIONS.md` §5.

**Gate per domain:** contract test old vs new returns equivalent payloads; SPA/legacy
client works against new endpoint; flip; smoke; keep revert-one-line rollback ready.

---

## Phase 4 — Worker (arq)

Goal: Python worker owns eval/settle over the universe, writing under `2.0.0`.

- [ ] Rewrite passes as arq jobs: `eval_pass`, `settle_pass`, `context_pass`, `event_pass`,
      `perp_pass` (`backend/CONVENTIONS.md` §8). Reuse `engine.evaluate_symbol`.
- [ ] Worker is the **sole writer** of shadow/anticipatory records; browser stays read-only.
- [ ] Run new arq worker in **shadow** (writing `2.0.0` rows) beside the live TS worker
      (still writing `1.0.0`) — versions segregate cleanly by `ENGINE_VERSION`.
- [ ] When `2.0.0` rows look sane, **stop `market-pulse-worker.service`**; enable arq unit.

**Gate:** idempotency + settlement-invariant tests green; `2.0.0` records accrue with
correct provenance; health-watch/staleness SSE alerts fire.

---

## Phase 5 — Frontend SPA

Goal: React 19 SPA reaches parity, talking only to `/api/v1`.

- [ ] Port TanStack routes → React Router pages; `src/hooks/queries` → `lib/api` client
      functions + TanStack Query hooks (`frontend/CONVENTIONS.md` §1). Keep dashboard pages
      as selectors over one snapshot query.
- [ ] Reuse shadcn/ui primitives; port `components/iq`. Direct icon imports, no barrels (§2).
- [ ] BYOK AI stays browser-side, keys never leave the client; calls go direct to provider.
- [ ] Build SPA as static assets; Caddy serves them at root once parity is confirmed.

**Gate:** every legacy page reproduced; visual + interaction smoke on mobile-first layout;
no calls to old server functions remain.

---

## Phase 6 — Cutover & decommission

- [ ] Flip Caddy root `*` → SPA + FastAPI. Old app receives no traffic.
- [ ] Disable/remove `market-pulse.service` (old web); confirm arq worker is the only worker.
- [ ] Update `.github/workflows/deploy.yml`: build backend+SPA, run `alembic upgrade head`,
      restart uvicorn + arq units.
- [ ] Backups: extend `deploy/pg-backup.sh` era coverage; add Redis persistence/health probe.
- [ ] Delete `/src` (legacy) and TS-only config once green for a full worker cycle.
- [ ] Rewrite `CLAUDE.md` for the new stack (commands, deployment reality, engine discipline
      now in Python). Refresh `README.md`.

**Gate:** full user flow green on new stack only; one clean deploy via the new workflow;
backups verified; no reference to `/src` remains.

---

## Sequencing summary

`0 seam → 1 engine → 2 data → 3 api (auth→market→ft→notif) → 4 worker → 5 spa → 6 cutover`

Engine (Phase 1) and SPA scaffolding (Phase 5 groundwork) can proceed in parallel with
data/api work since the engine is DB-free. Everything else is gated and reversible.
