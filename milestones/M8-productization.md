# M8 — Productization

**Goal:** turn a single-owner instrument into a product a second (and tenth)
real user can adopt: onboarding, multi-user hardening, operational maturity,
and positioning. "REAL product" ends here — measured by a stranger completing
the loop without the author present.

**Depends on:** M1–M6 (the loop), ideally M7 (both modes) — M8 tasks marked
`[parallel-ok]` may interleave with M7 if it stalls on external factors.

## Success criteria (all measurable)

- [ ] A second real user goes invite → login → connect read-only key →
      backfill → first daily brief in **≤ 10 minutes** of active effort,
      with no shell access and no author intervention (timed, observed).
- [ ] Per-user isolation proven: a test user can never read another user's
      trades, stamps, forensics, cohorts, or notifications (integration test
      suite over every user-scoped route).
- [ ] Sync scheduler keeps N users inside Binance rate limits with the eval
      worker still healthy (load test with ≥ 5 simulated accounts; documented
      per-user API budget and the max-user bound it implies).
- [ ] Push-to-main deploys to the VPS via CI (green run observed end-to-end)
      **or** the manual path is scripted to a single command with a
      preflight check.
- [ ] Backup/restore drill executed and documented: restore yesterday's
      `pg_dump` to a scratch database, run integrity checks, measure RTO.
- [ ] Landing/docs pages state the positioning ("better capital-at-risk
      decisions; sometimes the best trade is a skip"), the read-only
      guarantee, key handling, and a not-financial-advice notice.
- [ ] Uptime/health: worker staleness, sync staleness, and brief-generation
      failures all alert; one week with zero silent failures.

## Tasks

- [ ] **M8-T1 — Multi-user data audit.** Sweep every table/route/store for
      user-scoping; fix gaps; write the cross-user isolation test suite.
      *DoD:* isolation suite green; audit notes committed.
- [ ] **M8-T2 — Sync scheduler + budgets.** Per-user sync scheduling under a
      global Binance budget (extend `rate-limit.ts`); starvation-safe with
      the eval worker; document the max-user bound.
      *DoD:* 5-account simulation stays inside limits; budget doc committed.
- [ ] **M8-T3 — Onboarding flow.** Invite → guided key creation (with
      screenshots of Binance's read-only settings) → permission-gate check →
      backfill progress screen → "your first brief". Reuse product-tour
      plumbing.
      *DoD:* dry-run by the author from a fresh account in <10 min.
- [ ] **M8-T4 — Second-user trial.** Onboard a real second user; observe;
      log friction; fix the top 3 frictions.
      *DoD:* timed run recorded in PROGRESS; fixes shipped.
- [ ] **M8-T5 — Deploy pipeline.** [parallel-ok] Finish what M0-T6 chose:
      working CI deploy with migration step + health check + rollback note,
      or the scripted single-command manual path.
      *DoD:* one observed green end-to-end deploy of a trivial change.
- [ ] **M8-T6 — Backup/restore drill.** [parallel-ok] Script the restore;
      run it against a scratch DB; document RTO/RPO and the runbook in
      `deploy/`.
      *DoD:* drill executed; runbook committed.
- [ ] **M8-T7 — Alerting completeness.** [parallel-ok] Sync staleness, brief
      failures, stamping backlog → health-watch SSE + the existing cron
      probe; kill any remaining silent failure path found in a log sweep.
      *DoD:* each alert fired once via induced failure.
- [ ] **M8-T8 — Landing + docs.** Positioning page, read-only/custody
      explainer, metric definitions surfaced from the M3/M5 docs,
      not-financial-advice notice reviewed by the user.
      *DoD:* pages live; user sign-off recorded.
- [ ] **M8-T9 — Performance pass.** [parallel-ok] Journal virtualization at
      10k+ fills, snapshot cache behavior under multi-user load, mobile
      LCP budget on the brief page (measure, fix worst offenders).
      *DoD:* measured before/after numbers in PROGRESS.
- [ ] **M8-T10 — Plan retrospective.** Write `milestones/RETROSPECTIVE.md`:
      what each milestone's success criteria measured vs reality, which
      guardrails fired, what the 1.0.0 verdict said (if reached), and the
      proposed next roadmap (engine's future role included).
      *DoD:* committed; open questions handed to the user as decisions, not
      chores.
