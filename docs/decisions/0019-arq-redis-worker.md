# EDR 0019: arq on Redis replaces the bespoke worker loop

- **Status:** Accepted (2026-07-16, migration plan approval); recorded 2026-07-17. Infra landed in Phase 0 (Redis container + disabled unit); jobs land in Phase 4.
- **Scope:** `docker-compose.yml` (`market-pulse-redis`, loopback `6380`, pinned volume `market_pulse_redis`); `deploy/market-pulse-arq.service`; `backend/app/worker/` (arq `WorkerSettings` + job functions).
- **Depends on:** `docs/migration-plan.md` Phase 4; `backend/CONVENTIONS.md` §8.

## Problem

The TS worker (`market-pulse-worker.service`) is a hand-rolled forever-loop: its own
scheduling, health probe via crontab, no retries, no job visibility. The Python
rewrite needs the same passes (eval, settle, context, events, perp) with retry,
cron scheduling, and inspectable job state — without building another bespoke loop.

## Decision

- **arq** (Redis-backed) runs the worker passes as cron jobs. Chosen over Celery per
  conventions §8: we need cron + retry + visibility, nothing Celery-exclusive; arq is
  async-native, matching the FastAPI/SQLAlchemy-async stack (KISS/YAGNI).
- **Redis is project-scoped**: `market-pulse-redis` container, loopback-only on host
  port 6380 (6379 is another project's shared Redis — never piggyback the record's
  infrastructure on someone else's container), AOF persistence, volume name pinned for
  the same reason as `market_pulse_pgdata` (the 2026-07-12 orphaned-volume incident).
- Redis is a **queue, not a system of record** — Postgres remains the only record.
  Losing Redis loses at most an in-flight job, which the next cron tick redoes; jobs
  must stay idempotent (settlement invariants already require this).
- The arq worker stays the **sole writer** of shadow/anticipatory records once cut
  over, preserving the single-writer invariant.

## What was intentionally rejected

- **Celery** — heavier operational surface (broker + backend concepts, sync-first) for
  features we don't use.
- **Reusing the shared Redis on 6379** — couples the record's job queue to an
  unrelated project's lifecycle.
- **BackgroundTasks in FastAPI** — dies with the web process; worker passes are exactly
  the thing you page on (conventions §8).
