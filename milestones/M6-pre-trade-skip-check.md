# M6 — Pre-trade skip check

**Goal:** the product's thesis made tangible: before risking capital, the user
asks Market Pulse and gets one of three honest answers — a supportive read, a
"this matches conditions where your own record is poor", or **"no opinion —
insufficient evidence"**. The willingness to say the third is the feature.

**Depends on:** M5 (only protocol-cleared cohorts may speak), M2 (live
context), M3 (the user's management patterns).

## Success criteria (all measurable)

- [ ] Skip check answers in ≤ 3s for any Binance symbol (context assembly
      from cached snapshot + live engine read).
- [ ] Every claim in a skip-check response is protocol-cleared (n + CI shown)
      or explicitly marked descriptive (engine context) — test-asserted
      response schema, not free text.
- [ ] "Insufficient evidence" rate is **reported, not hidden**: the response
      says which checks had no opinion; a settings page shows the current
      coverage (% of family segments cleared).
- [ ] The check never says "buy/sell/enter/exit". Response vocabulary is
      fixed: condition matches, record references, engine context, and
      what-would-change-this triggers (the existing not-yet/wrong-strategy/
      what-flips-it discipline extended to the user's own record).
- [ ] Outcome tracking: every skip-check invocation is logged with its answer
      and (via later sync) whether a matching trade followed within 24h —
      the product's own effectiveness record, for a future protocol.

## Tasks

- [ ] **M6-T1 — Response contract.** Typed response schema: descriptive
      engine context block, cohort-match blocks (each with n/CI/protocol
      ref), no-opinion blocks, trigger lines. `docs/skip-check-contract.md`.
      *DoD:* schema + wording tests; no free-text claim path exists.
- [ ] **M6-T2 — Condition matcher.** Live context (current regime, session,
      setup, verdict for the chosen intent) → which declared segments this
      prospective trade falls into; pure + fixture-tested.
      *DoD:* deterministic matches for fixture contexts.
- [ ] **M6-T3 — Skip-check service + route.** Assemble matcher output +
      cleared cohort stats + engine read into the contract; ≤3s budget
      (cache snapshot, single kline fetch).
      *DoD:* latency measured over 20 symbols; schema-validated responses.
- [ ] **M6-T4 — Skip-check UI.** Entry points: token page ("check this
      trade" with intent+direction picker) and command palette. Mobile-first
      card rendering the three answer shapes distinctly.
      *DoD:* all three shapes reachable with real data; screenshots logged.
- [ ] **M6-T5 — Invocation log + trade linkage.** Persist invocations
      (`0010`); worker links subsequent fills (same symbol/direction within
      24h) to the invocation.
      *DoD:* linkage test; coverage stats visible.
- [ ] **M6-T6 — Behavioral alerts (opt-in).** SSE alerts reusing M3 patterns:
      re-entry-after-loss within the user's own historical revenge window,
      open position entering a stamped event window, stop-widened detection.
      Each alert cites the per-trade fact pattern, not cohort claims.
      *DoD:* alerts fire on seeded fixtures; opt-in in settings; delivered
      through the existing notification stream.
