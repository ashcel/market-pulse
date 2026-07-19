# M9 — Execution plane: risk desk & trade permits

**Goal:** IQ becomes a professional risk desk. Every order must earn a
persisted **Trade Permit** from the deterministic risk engine before it can be
sent to Binance; the user explicitly confirms every order; the AI CRO explains
and advises but never decides. Anchored on **EDR 0020** (which amends EDR 0017
— read that first; its decisions are this milestone's spec).

**Depends on:** EDR 0020 accepted + owner sign-off (U20). Independent of
M5–M8 and may be scheduled ahead of them at the owner's direction. Phase B
supersedes M1's Binance account-read scope for balances/positions/orders.
`ENGINE_VERSION` and all decision/trigger semantics are untouched throughout —
the risk engine is a **new plane**, not an engine change.

## Hard invariants (test-asserted in every phase, non-negotiable)

- No code path submits an order without an `APPROVED`, unexpired permit id.
- The permit decision function is **pure and deterministic**; no AI output is
  an input to any hard check, and no API/UI/AI path flips a `REJECTED` permit.
- Execution keys are their own key class; **withdrawal scope is rejected at
  intake, always**; exchange-side IP allowlisting verified at intake.
- `EXECUTION_ENABLED` kill switch, default **off**; off = read-only product.
- Stop-loss is part of the atomic submit path — an entry whose stop cannot be
  attached is immediately flattened/cancelled.
- No mainnet code path is enabled until the isolation decision (0020 open
  item) is recorded (U24).

## Success criteria (all measurable)

- [ ] A trade ticket for any supported symbol returns a permit — approved or
      rejected with enumerated reasons — in ≤ 2s.
- [ ] 100% of executed orders reference a persisted permit; a DB constraint +
      test proves no orphan orders can exist.
- [ ] Property test: computed position size never risks more than the
      configured % (within exchange step-size rounding tolerance, rounded
      **down**).
- [ ] Failure-injection test: SL placement rejected after entry fill →
      position auto-flattened, incident journaled.
- [ ] Full testnet round trip demonstrated (ticket → permit → confirm →
      filled order with SL/TP → journal entry linked to permit) before
      mainnet enable.
- [ ] Kill-switch off reverts the product to read-only while keeping open
      positions visible (view-only).
- [ ] Trade Quality Score has a published rubric with per-component display;
      no render site frames it as a win-probability; no "AI confidence"
      framing on any execution surface.
- [ ] Rejected permits are persisted and queryable — the refusal record
      feeds behavior analytics.

## Phase A — Deterministic core (pure; no keys, no network)

- [x] **M9-T1 — Trading Constitution schema + store.** Versioned per-account
      config: risk-per-trade band (0.5–3%), daily/weekly loss limits, max
      leverage, max concurrent positions, max correlated exposure, min R:R,
      allowed sessions/symbols, optional binding cooldowns. SQL migration +
      typed repo + settings UI; every constitution edit is itself journaled.
      *DoD:* config-validation tests (out-of-band values rejected); audit row
      per change; UI renders and edits.
- [x] **M9-T2 — Risk engine core.** `backend/app/execution/risk_engine.py`:
      pure function (trade proposal + account state + constitution) →
      `PermitDecision` with a result per hard check (every rule in 0020
      decision 2 enumerated). *DoD:* fixture matrix where each rule fails
      independently and in combination; purity enforced (no I/O in module);
      decision reasons are typed enums, not free text.
- [x] **M9-T3 — Position sizing.** balance + stop distance + risk% → qty,
      notional, margin, effective leverage, liquidation estimate — honoring
      Binance symbol filters (step size, min notional, tick size). The user
      never enters a quantity. *DoD:* property tests (risk ≤ configured %,
      rounding always down); filter fixtures for spot + perp.
- [x] **M9-T4 — Trade Quality Score.** Deterministic 0–100 with component
      breakdown (R:R, stop-placement validity vs structure, constitution
      headroom, volatility-vs-stop-distance, session/liquidity, behavior
      flags). Rubric published in `docs/trade-quality-score.md`; inventory
      existing "confidence" renders on execution-adjacent surfaces and
      replace per 0020 decision 5; `docs/score-inventory.md` updated.
      *DoD:* identical inputs → identical score (test); rubric doc exists;
      every render site carries the "evaluation, not prediction" label.
- [x] **M9-T5 — Trade Permit record.** Migration + repo: immutable permit
      rows (proposal snapshot, account-state snapshot, per-check results,
      TQS + components, decision + reasons, TTL, timestamps). Rejected
      permits persisted. Permit-card response schema fixed (the EDR's
      example shape: Quality / Constitution / Portfolio Risk / Daily Budget /
      Decision, or Decision + Reasons[]). *DoD:* no UPDATE path exists
      (repo + DB-level test); TTL-expiry test; schema test for both shapes.

## Phase B — Binance account read + execution-key intake

- [ ] **M9-T6 — Execution-key intake.** New key class, separate from
      read-only sync keys; intake checks via Binance API: trade scope OK,
      **withdrawal scope → hard reject**, IP allowlist present → else reject.
      Same AES-256-GCM at-rest model; repo never returns plaintext; logs
      redact. *DoD:* fixture rejection tests + live withdrawal-key rejection
      proof (U22); redaction test.
- [ ] **M9-T7 — Account state service.** Balances, positions, open orders,
      today/week realized PnL, portfolio exposure aggregation including
      correlated buckets (reuse the sector buckets). Cached with a staleness
      bound; **stale account state fails closed** — permit `REJECTED` with
      reason `STALE_ACCOUNT_STATE`. *DoD:* fail-closed test; exposure
      fixtures across mixed spot/perp positions.

## Phase C — Testnet execution path

- [ ] **M9-T8 — Order service (testnet only, behind kill switch).** Entry
      (market/limit) + mandatory SL + TP placement with idempotency keys;
      SL-attach failure → auto-flatten; every exchange call logged against
      the permit id. Adapter seam so Bybit can implement the same interface
      later. *DoD:* testnet round trip green; SL-failure injection flattens;
      duplicate submit with same idempotency key places one order.
- [ ] **M9-T9 — Trade ticket + permit UI.** Ticket (symbol, side, entry
      type, stop, target, risk%) → permit request → permit card (both
      shapes) → explicit confirm → execution → journal entry. Confirm control
      disabled unless permit is `APPROVED` and unexpired; countdown to
      expiry shown; nowhere a raw quantity input. Mobile-first. *DoD:* all
      states reachable on testnet with screenshots; disabled-confirm negative
      test; journal entry links to the permit.
- [ ] **M9-T10 — Trade lock (open-trade management).** Through IQ, open
      trades are reduce-only: trail stop, move to break-even, partial TP —
      per predefined rules; no stop removal, no stop widening beyond policy,
      no leverage increase, no averaging down. Management actions journaled.
      *DoD:* negative test per forbidden action; allowed actions round-trip
      on testnet.

## Phase D — Behavioral layer + AI CRO

- [ ] **M9-T11 — Deterministic behavior detectors.** Server-side rules over
      the journal: revenge (loss → re-entry within window with size-up),
      overtrading (frequency vs own baseline), tilt (risk escalation).
      Outputs feed the permit as flags — advisory by default; the
      constitution can opt selected detectors into **binding** cooldowns
      (then they reject like any hard rule). *DoD:* seeded-fixture detection
      tests; binding-vs-advisory config honored; flags appear on the permit.
- [ ] **M9-T12 — AI CRO narration.** BYOK, grounded only in the permit
      record + persisted journal/behavior data; explains approvals and
      rejections, may recommend wait/reduce-risk; response schema keeps all
      decision fields deterministic-sourced so the AI physically cannot
      alter an outcome. Labeled AI-generated. *DoD:* context-builder test
      proving only persisted fields enter the prompt; schema test that the
      decision field is copied from the permit, never model output.

## Phase E — Mainnet gate

- [ ] **M9-T13 — Isolation decision + mainnet checklist.** Owner records the
      infra-isolation decision (U24) in EDR 0020; mainnet-enable checklist
      committed: kill-switch drill performed, testnet evidence linked, key
      intake live tests green, permit invariants green. *DoD:* checklist doc
      committed; 0020 open item closed.
- [ ] **M9-T14 — Mainnet soft launch.** Minimum sizes, an N-trade
      observation window, and a daily reconciliation pass
      (permit ↔ journal ↔ exchange fills). *DoD:* reconciliation report
      zero-diff over the window; PROGRESS entry with the evidence.

## Owner actions

U20–U24 in `USER-ACTIONS.md` — EDR sign-off, testnet key, live rejection
test, kill-switch custody, isolation decision.
