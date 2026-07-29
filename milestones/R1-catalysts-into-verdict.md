# R1 — Catalysts into the verdict

Live plan. Parent: `ROADMAP-2026-07-23.md` §4 R1.

## Objective

Events stop being a feed; they modify the call. Users can't weigh an unlock or CPI print against a setup — now the product does it for them.

## Dependencies

- Impact Score plane (committed) ✅
- R0 restarts ✅

## Tasks

| ID | Task | Agent | Depends on | Status |
|----|------|-------|------------|--------|
| R1-T1 | Wire CatalystLine into token page (below VerdictHeader) | Bima | — | pending |
| R1-T2 | Impact-gated notifications (severity + impact threshold) | Bima | — | pending |

## Standing constraints

- No git state operations
- No engine semantics touched
- `bunx tsc --noEmit`, `bunx vitest run`, `bun run lint` all green before committing
