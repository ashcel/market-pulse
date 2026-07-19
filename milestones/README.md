# Market Pulse revamp — milestone plan

Direction (agreed 2026-07-14, see the audit conversation and the EDR M0 produces):

> **Market Pulse becomes a capital-at-risk decision journal wrapped in a
> market-intelligence brief, with the deterministic engine as the context
> instrument and AI as the complement layer.** It helps the user make better
> decisions (including the decision to skip), and reviews the user's actual
> behavior with honest metrics. It is read-only: it never executes or manages
> trades.

**Amended 2026-07-19 (EDR 0020):** the read-only clause is superseded. IQ
supports **user-confirmed live execution via Binance** through M9's
Trade-Permit path — never auto-trading; a deterministic server-side
constitution binds every IQ-placed order and no AI output can override a
hard-limit rejection. Everything else above stands.

## Milestone map

| #  | Milestone                                   | File                          | Tasks | Target window    |
| -- | ------------------------------------------- | ----------------------------- | ----- | ---------------- |
| M0 | Honesty pass & direction commit             | `M0-honesty-and-direction.md` | 6     | Jul 15 – Jul 18  |
| M1 | Read-only Binance trade ingestion           | `M1-trade-ingestion.md`       | 12    | Jul 19 – Jul 26  |
| M2 | Context stamping (engine replay)            | `M2-context-stamping.md`      | 8     | Jul 27 – Aug 01  |
| M3 | Per-trade behavior forensics                | `M3-per-trade-forensics.md`   | 9     | Aug 02 – Aug 08  |
| M4 | AI complement layer                         | `M4-ai-complement-layer.md`   | 6     | Aug 09 – Aug 12  |
| M5 | Cohort analytics (pre-registered)           | `M5-cohort-analytics.md`      | 8     | Aug 13 – Aug 18  |
| M6 | Pre-trade skip check                        | `M6-pre-trade-skip-check.md`  | 6     | Aug 19 – Aug 23  |
| M7 | TradFi mode (Binance TradFi tickers)        | `M7-tradfi-mode.md`           | 10    | Aug 24 – Aug 31  |
| M8 | Productization                              | `M8-productization.md`        | 10    | Sep 01 – Sep 08  |
| M9 | Execution plane — risk desk & trade permits | `M9-execution-plane.md`       | 14    | owner-scheduled  |

Dates assume the agent runs daily and completes 1–2 tasks/day. They are
targets, not commitments: **a task is done when its Definition of Done is
verified, never when the calendar says so.** Milestones are strictly ordered
(M2 needs M1's data, M5 needs M3's metrics, M6 needs M5's protocol). Within a
milestone, tasks are ordered unless marked `[parallel-ok]`.

## Daily agent protocol

**HARD RULE — the agent is a reviewer/orchestrator, not a coder.** All
implementation is delegated to the installed coding tools (Claude Code →
Codex → Antigravity, ranked by quality then usage) per
[`DELEGATION.md`](DELEGATION.md). The agent writes briefs, reviews diffs,
runs verification, and issues ACCEPT / HOLD-for-revise verdicts. It only
touches plan bookkeeping, review notes, git, and verification commands
itself. If the whole roster fails a task, flag the user and stop — never
self-implement.

Each day:

1. Read `PROGRESS.md` (last entry), the current milestone file, and
   `DELEGATION.md`.
2. Pick the **first unchecked task**. A HOLD-carryover from yesterday resumes
   first (re-delegate with the saved review notes).
3. Run the per-task loop from `DELEGATION.md`: snapshot → brief → delegate →
   review → verdict.
4. On ACCEPT: verify `bunx vitest run` green, `bunx tsc --noEmit` clean,
   `bun run lint` clean, plus the task's own DoD checks — then commit with
   the implementing tool credited in the commit body.
5. Check the task's box in the milestone file and append a `PROGRESS.md`
   entry (format in that file, incl. tool + verdict trail).
6. **Never leave the tree dirty or broken overnight — this working directory
   is production.** An unresolved HOLD is reverted to the snapshot, not left
   in the tree.

Do at most 2 tasks per day. If a task turns out to be >1 day of work, split it
in the milestone file (add sub-tasks) rather than rushing it. Before M0-T1,
run the one-time D-T0 tool-availability check in `DELEGATION.md`.

## Hard guardrails (apply to every task)

- **Engine discipline:** never change decision/trigger semantics or
  `ENGINE_VERSION` in this plan. Everything here is journal, context, display,
  and analytics. If a task appears to require an engine-semantics change, STOP
  and flag the user — that path goes through a pre-registered spike, not this
  plan.
- **No outcome peeking** at the 1.0.0 shadow record beyond
  `bun run record:report --integrity` (per `research/verdict-protocol-1.0.0.md`).
  User-trade analytics are a different record and are unrestricted.
- **Execution only through the permit path (amended by EDR 0020):** order
  placement exists solely inside M9's permit-gated, user-confirmed,
  kill-switched path. Outside M9 tasks, no task may place or manage orders.
  **Withdrawal scopes are rejected at intake, always.** Sync keys remain
  read-only-validated (M1-T3); the designated execution key is its own class
  (M9-T6).
- **No fake precision:** every user-facing number needs a definition and an
  evidence basis. R is only computed where a stop is evidenced; cohort claims
  need the M5 protocol's minimum n; below it, render "insufficient evidence"
  as a first-class state.
- **Deploy reality:** the GH deploy workflow does not reach the VPS (until
  M0-T6 resolves it). Service restarts are user-run — end the day with a
  "needs restart: yes/no" line in `PROGRESS.md`, never run `systemctl` yourself.
- **Stack constraints:** SSE not WebSockets; `src/server/` never imported from
  client code; migrations are hand-written SQL in `src/server/db/migrations/`;
  `repo.ts`-style typed repos are the only SQL surface. New packages respect
  the 24h supply-chain guard; ask the user before touching
  `minimumReleaseAgeExcludes`.
- **Lovable:** never rewrite pushed history.

## Standing event-triggered interrupts (not scheduled tasks)

- **1.0.0 verdict gate:** when `record:report --integrity` shows n ≥ 150
  matured primary-cohort records, pause the current milestone and execute
  `research/verdict-protocol-1.0.0.md` §7–§9 exactly. The verdict decides
  whether engine-depth work re-enters the roadmap; it does not otherwise alter
  this plan.
- **User feedback** in `PROGRESS.md` marked `@agent` overrides task order.
- **Owner-only actions** (API keys, secrets, restarts, sign-offs) live in
  `USER-ACTIONS.md`; when blocked, cite the ID (e.g. "blocked on U7"), skip
  to the next unblocked task, and never work around a missing secret.

## Success of the whole plan (the product-level gate)

The revamp is done when a real user can: connect a read-only Binance key,
see their full trade history reconstructed and context-stamped, read honest
per-trade forensics and (where n allows) cohort claims about their own
behavior, get an AI-written daily brief grounded only in persisted data, run a
pre-trade skip check that is willing to say "no opinion", and do all of it for
TradFi instruments as well as crypto. When they choose to execute (M9), every
order first earns a Trade Permit from the deterministic risk desk, is
explicitly confirmed by the user, and lands with its stop attached — the
product never trades on its own.
