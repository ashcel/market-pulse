# Market Pulse Migration Plan

Stack: Vite+React19 SPA → FastAPI(Python) → Postgres+Redis
Old: TanStack Start monolith
Target: Clean separation, SOLID/DRY/KISS/YAGNI, precommit hooks

---

## Phase Order

### Phase 0 — Scaffold + Standards
Files: `backend/` `frontend/` `engine/` dirs, pyproject.toml, package.json, lefthook.yml, eslint, ruff, mypy, precommit
Verify: `ruff check`, `npx tsc --noEmit`, `pytest --collect-only`

### Phase 1 — Port Engine to Python
Core SMC logic. 42 TS modules → Python. Package `engine/smc/`. Zero framework dep.
Steps: types → analysis → structure → liquidity → fvg → orderblocks → equilibrium → strength → objectives → quant → market → discovery → rs_scan → macro
Verify: pytest green, fixtures match

### Phase 2 — FastAPI Backend
app/ scaffold, database.py, SQLAlchemy models, Alembic, auth (JWT), API endpoints, arq workers
Verify: uvicorn app.app:app starts, /docs loads, /api/v1/health returns 200

### Phase 3 — Vite + React Frontend
Vite scaffold, shadcn/ui, React Router, TanStack Query, pages (market, tokens, rankings, regime, trades, settings), charts
Verify: npm run build, pages render, API connected

### Phase 4 — Integration + Deploy
Wire frontend↔backend, Caddy config, systemd services, swap DNS
Verify: iq.heydewi.com loads new stack, old TanStack removed

---

## Execution

```bash
cd /home/ubuntu/code/personal/market-pulse
```

Each phase:
1. Read phase spec from this doc
2. Delegate to Claude Code Fable: `/goal continue next phase of migration_plan.md`
3. Use auto mode
4. Verify phase DoD
5. Commit, mark progress in PROGRESS.md
