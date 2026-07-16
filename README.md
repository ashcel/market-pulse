# Market Pulse

A capital-at-risk decision journal wrapped in a market-intelligence brief.
Market Pulse helps you make better trading decisions — including the
decision to skip a trade — and reviews your actual behavior with honest,
evidence-backed metrics. A deterministic engine supplies market context, an
optional BYOK AI layer complements it, and the product never places or
manages a single trade.

See [`docs/decisions/0017-product-direction.md`](docs/decisions/0017-product-direction.md)
for the full product-direction record (scope, engine stance, R-multiple rule,
key custody, TradFi approach).

## Stack

- [TanStack Start](https://tanstack.com/start) (file-based routing, React 19,
  Vite) with the Nitro `node-server` preset for the build
- Postgres for the forward-test system of record and user data
- [Bun](https://bun.sh) as the package manager and script runner
- Tailwind v4, shadcn/ui primitives, `lightweight-charts` + `recharts` for
  visualization

## Getting started

```bash
bun install
cp .env.example .env   # fill in POSTGRES_PASSWORD / DATABASE_URL / MARKET_PULSE_SECRET_KEY
docker compose up -d   # starts Postgres on 127.0.0.1:5435
bun run db:migrate
bun run db:seed-admin  # creates the first invite-only admin account
bun run dev            # http://localhost:3000
```

The forward-test worker (evaluates and settles the engine's tracked calls
against live klines) runs as a separate process:

```bash
bun run worker         # continuous loop
bun run worker:once     # single pass, useful for local testing
```

## Commands

| Command                   | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `bun run dev`               | Start the dev server (Vite)                       |
| `bun run build`             | Production build (Nitro, `node-server` preset)    |
| `bun run lint`              | ESLint                                            |
| `bun run format`            | Prettier (writes)                                 |
| `bunx vitest run`           | Test suite (canonical runner; CI uses `bun test`) |
| `bunx tsc --noEmit`         | Typecheck                                         |
| `bun run db:migrate`        | Apply Postgres schema migrations                  |
| `bun run db:seed-admin`     | Create the first admin account                    |
| `bun run db:invite`         | Mint an invite-only signup link                   |
| `bun run worker` / `worker:once` | Forward-test eval+settle loop               |
| `bun run record:report`    | Forward-test stats/integrity report               |

DB-integration tests (`repo-invariants`, `idempotency`) need a reachable
`DATABASE_URL` and self-skip without one.

## Architecture

Three planes, detailed in [`CLAUDE.md`](CLAUDE.md):

1. **Client dashboard** — a single cached `MarketSnapshot` (18+ tracked
   Binance USDT pairs) drives every dashboard page; live prices overlay via
   Binance WebSocket.
2. **Signal engine** (`src/lib/engine/`) — framework-free, shared verbatim by
   the browser and the server worker. Produces per-objective assessments
   (scalp/intraday/swing), draw-on-liquidity plans, and hysteresis-gated
   verdicts. Engine behavior is version-pinned (`ENGINE_VERSION`) and changes
   go through pre-registered spikes — see `docs/decisions/` for the decision
   log.
3. **Server** (`src/server/`) — Postgres-backed system of record for the
   forward-test worker, invite-only auth, and read models. Server code is
   never imported from the client bundle.

## Project status

Market Pulse is under active daily development against a milestone plan in
[`milestones/`](milestones/README.md) (M0 honesty pass through M8
productization). Implementation work is delegated to coding tools per
[`milestones/DELEGATION.md`](milestones/DELEGATION.md); progress is logged in
[`milestones/PROGRESS.md`](milestones/PROGRESS.md).

## Deployment

This repo doubles as its own production deployment — see the "Deployment
reality" section of [`CLAUDE.md`](CLAUDE.md) for the live services, database,
and backup setup before making infrastructure changes.
