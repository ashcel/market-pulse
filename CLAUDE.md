# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun is the package manager (`bun.lock`, `bunfig.toml`).

- `bun run dev` — start the dev server (Vite)
- `bun run build` — production build (Nitro, `node-server` preset)
- `bun run lint` — ESLint
- `bun run format` — Prettier (writes)
- `bunx vitest run` — the test suite (canonical runner; CI uses `bun test`)
- `bunx tsc --noEmit` — typecheck
- `bun run db:migrate` / `db:seed-admin` / `db:invite` — Postgres schema + auth CLIs
- `bun run worker` (`worker:once` for a single pass) — the forward-test eval+settle loop

DB-integration tests (`repo-invariants`, `idempotency`) need a reachable
`DATABASE_URL` and self-skip without one.

`bunfig.toml` enforces a 24h supply-chain guard: package versions published less than a day ago are skipped at install. Confirm with the user before adding any package to `minimumReleaseAgeExcludes`.

## Deployment reality

**The VPS this repo is developed on is production.** Live systemd units
running out of this working directory: `market-pulse.service` (legacy
TanStack web, port 3002), `market-pulse-api.service` (FastAPI, port 8002),
and `market-pulse-arq.service` (the **Python** forward-test worker — arq cron
tick every 5 min; logs: `journalctl -u market-pulse-arq`). The old TS
`market-pulse-worker.service` was stopped + disabled at the 2026-07-17 Phase
4 cutover — never re-enable it; it would write dead 1.0.0 records. Postgres
runs in docker (`market-pulse-db`, port 5435, see `docker-compose.yml`).
A push to `main` triggers `.github/workflows/deploy.yml`, which pulls,
rebuilds, runs migrations, and restarts services **in this directory**.
Never leave the tree broken or on an unmergeable branch. Daily `pg_dump` + a
worker health probe run from `ubuntu`'s crontab (`deploy/` has the scripts).

## Engine change discipline

**The live engine is Python**: `engine/smc/version.py` pins `ENGINE_VERSION`
(currently `2.0.0` — the forward-test clock restarted at the 2026-07-17
Python-worker cutover; the 1.0.0 TS record was destroyed as buggy). The TS
copy in `frontend/src/lib/engine/` still serves the legacy web UI's live
views but no longer writes any record. Every persisted forward-test record
is provenance-stamped and all stats segment by engine version, so:

- **Any change to decision or trigger semantics requires a version bump** and
  restarts the evidence clock. Do not make casual engine edits.
- Engine behavior changes go through **pre-registered spikes** (hypothesis,
  frozen gates, then a verdict) — see `research/phase2-spike.md` /
  `phase3-spike.md` for the pattern and `docs/decisions/` (EDRs) for the
  decision log.

## Lovable integration

This project is connected to [Lovable](https://lovable.dev). Never rewrite published git history (no force pushes, or rebasing/amending/squashing already-pushed commits) — it destroys the user's Lovable project history. Pushed commits sync back into the Lovable editor, so keep the branch in a working state.

`vite.config.ts` uses `@lovable.dev/vite-tanstack-config`, which already bundles tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro, the `@` path alias, and more. Do **not** add these plugins manually — duplicates break the app. Extra config goes through its `defineConfig({ vite: { ... } })` wrapper.

## Routing (TanStack Start)

File-based routing lives in `src/routes/` — do not create `src/pages/` or Next.js/Remix-style layouts. The only root layout is `src/routes/__root.tsx` (app shell: `Sidebar` / `TopBar` / `BottomNav` around `<Outlet />`; also provides the `QueryClient` via router context). Conventions:

- `index.tsx` → `/`, `token.$symbol.tsx` → `/token/:symbol` (bare `$`, no curly braces)
- `routes/api/*.ts` files are server routes using `createFileRoute` with `server.handlers` (see `src/routes/api/klines.ts`)
- `src/routeTree.gen.ts` is auto-generated — never edit by hand

## Architecture

Mobile-first crypto decision assistant. Product direction is pinned by
`docs/decisions/0017-product-direction.md` (2026-07-14 audit): decision
journal + intelligence brief + behavior review; the engine is a context
instrument pending its 1.0.0 verdict, AI is a BYOK complement, and R-multiples
are shown only where a stop order is evidenced (else % + MAE/MFE). Three planes:

### 1. Client dashboard (single market snapshot)

`src/lib/engine/market.ts` defines the tracked `UNIVERSE` (18 Binance USDT pairs bucketed into sectors) and a server function computing one `MarketSnapshot` from 1H klines (per-asset quant scores, regime, rotation, heatmap, volatility, Fear & Greed), cached ~45s server-side. `src/hooks/queries/index.ts` exposes `useMarketSnapshot`; every dashboard page (`index`, `markets`, `rankings`, `regime`, `rotation`, `technical`) is a selector over it. News (`news.ts`) is live Cointelegraph RSS with keyword sentiment (deterministic sample fallback). Live prices/klines overlay via Binance WS (`binance-live-feed.ts`, spot/perp dual-mode).

### 2. Signal engine (token page + worker, one shared pipeline)

`src/lib/engine/` is framework-free and shared verbatim by the browser and the server worker:

- `binance.ts` (fetch tiers + `/api/klines`), `mock-candles.ts` (deterministic demo fallback, `source: "demo"` surfaced in UI).
- `analysis.ts` (pivots, S/R), `structure.ts` (CHoCH/BOS market structure), `liquidity.ts` / `zones.ts` / `sessions.ts` / `strength.ts` / `equilibrium.ts` (SMC context), `quant.ts` (`evaluateSignal` scoring), `intent.ts` (per-objective assessments: scalp/intraday/swing — verdicts must always say not-yet / wrong-strategy / what-flips-it), `objectives.ts` + `poi.ts` (draw-on-liquidity + POI limit plans), `hysteresis.ts` (verdicts hold until their trigger breaks), `shadow.ts` / `anticipatory.ts` / `tracker.ts` (record building + pure settlement), `evaluate.ts` (`evaluateSymbol` — the one entry point the token page hook `useReconciledAssessments` and the worker both call).
- Engine resolvers return **ranked candidate lists** (preferred = `[0]`), never a single collapsed winner.

### 3. Server (system of record)

`src/server/` — **server-only; never import from client code** (reached via API routes, server functions, and the worker; the client bundle must stay free of `postgres`):

- `db/` — postgres.js client + hand-written SQL migrations + typed repo (`repo.ts` is the only SQL surface).
- `worker/` — the autonomous eval+settle loop over the whole universe (sole writer of shadow/anticipatory records; browser is a read-only view via `/api/forward-test` and `useForwardTestRecord`). Spot-only today; hysteresis holds live server-side.
- `auth/` — invite-only sessions (opaque httpOnly cookies, no passwords).
- `forward-test/service.ts` — stats/health read models; `health-watch.ts` pushes worker-staleness alerts into the SSE notification stream (`/api/notifications`).

Other structure:

- `src/components/ui/` — shadcn/ui primitives; `src/components/iq/` — app components.
- `src/stores/` — zustand `persist` stores; forward-test stores are offline caches, **not** systems of record.
- `src/lib/ai/` — BYOK AI analyst (OpenRouter/OpenAI/Anthropic/custom); keys stay in the browser, calls go direct to the provider.
- Styling is Tailwind v4 via `src/styles.css`; charts use `lightweight-charts` and `recharts`. Path alias: `@/` → `src/`.
- This stack cannot upgrade HTTP connections: **no WebSocket server endpoints** — use SSE for server push.
