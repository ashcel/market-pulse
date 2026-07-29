# R5 — Alternatives & guardrail surfaces

Live plan. Parent: `ROADMAP-2026-07-23.md` §5 R5.

## Objective

When the preferred setup is invalid, answer "then what?" without feeding FOMO.

## Deliverables

1. **Spike surfaces reframed** — don't-chase warnings with cooldown notes
2. **Discovery scan → verdict-gated alternatives** — max 3, verdict-filtered, shown as alternatives when no actionable setup exists
3. **AI CRO narration schema** — foundation for M9-T12 (R3-blocked runtime)

## Dependencies

- R3 (permits, detectors) — blocks CRO narration runtime only
- R2 (skip states) — blocks full "shown only from skip/invalid" gating; partial UI without it

## Tasks

| ID | Task | Agent | Depends on | Status |
|----|------|-------|------------|--------|
| R5-T1 | Spike don't-chase reframing (badge copy, cooldown display) | Bima | — | done |
| R5-T2 | Discovery scan → alternatives (3 max, verdict-gated, copy reframe) | Bima | — | done |
| R5-T3 | AI CRO narration types + schema | Bima | — | done (scaffold exists) |

## Standing constraints

- No git state operations (stash/reset/checkout/rebase)
- No engine semantics touched — `engine/smc/`, `frontend/src/lib/engine/` decision files stay untouched
- Never run `systemctl`
- `pytest`, `ruff`, `bunx vitest run`, `bunx tsc --noEmit`, `bun run lint` all green before commit
