# R2 — Skip Check v1

Live plan. Parent: `ROADMAP-2026-07-23.md` §4 R2.

## Objective

Before risking capital, the user gets a deterministic answer: supportive read / stated cautions / "no opinion — insufficient evidence", plus what-would-change-it.

## Dependencies

- M9 Phase A (done)
- R1 (done)

## Status: DONE (back-end scaffold + front-end UI panel)

Backend fully built: `skip_check_schemas.py`, `skip_check_service.py`, `skip_check_router.py` — mounted in `main.py`.
Frontend: `SkipCheckPanel` component (modal with answer blocks), wired into token page below VerdictHeader/CatalystLine. Also `useSkipCheck` hook, API proxy route.

Remaining: full homepage entry point (token page Skip Check is accessible via live-setup links).

## Standing constraints

- No engine semantics touched
- `bunx tsc --noEmit`, `bunx vitest run` all green
