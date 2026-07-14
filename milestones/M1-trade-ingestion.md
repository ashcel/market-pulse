# M1 — Read-only Binance trade ingestion

**Goal:** the user connects a read-only Binance API key and Market Pulse
reconstructs their complete trading history — fills, positions, fees, funding,
realized PnL — as durable, idempotent, per-user data. Facts only: no scoring,
no judgment, no context yet.

**Depends on:** M0 (EDR 0017 fixes the custody + R rules this implements).

## Success criteria (all measurable)

- [ ] A read-only key can be added in Settings; a key with trade or withdrawal
      permission is **rejected** with a clear message (verified against a real
      key of each kind).
- [ ] Full-history backfill completes on the owner's real account; fill count
      and realized futures PnL reconcile against Binance's own income history
      within fee-rounding (|Δ| ≤ 0.1% of gross PnL, discrepancies itemized).
- [ ] Idempotency: re-running a full sync inserts **0** new rows (asserted by
      an integration test and verified live).
- [ ] No plaintext secret anywhere: `pg_dump | grep <key fragment>` finds
      nothing; keys absent from logs and error traces.
- [ ] Incremental sync keeps the journal ≤ 5 minutes behind the exchange
      (measured over one worker day).
- [ ] `/journal` lists reconstructed positions with entry/exit, size, fees,
      funding, realized PnL, hold time; filterable by symbol/market/date.

## Guardrails

- Never request or store keys with trade/withdraw scopes. Validate via
  Binance's API-key permissions endpoint **and** verify claims against current
  official docs at build time (training-data endpoint names may be stale).
- All new tables get a `user_id` FK from day one — multi-user comes in M8, the
  schema shouldn't need re-plumbing.
- Respect Binance rate limits through the existing `rate-limit.ts` budget
  pattern; sync must coexist with the eval worker without starving it.

## Tasks

- [ ] **M1-T1 — Design doc + schema.** `docs/trade-ingestion-design.md`:
      endpoints to use (verify against live Binance docs — spot fills,
      futures fills, futures income, order history for stop evidence),
      symbol-discovery strategy (futures: income history reveals traded
      symbols without per-symbol queries; spot: candidate set from balances +
      deposit history + order history, per-symbol cursors), rate-limit
      budget, and the fills→positions reconstruction algorithm. Migration
      `0006`: `exchange_account`, `exchange_fill`, `exchange_income`,
      `trade_position` (+ per-symbol sync cursors), all user-scoped, unique
      natural keys for idempotency.
      *DoD:* doc committed; migration applies + rolls forward clean.
- [ ] **M1-T2 — Secret custody.** AES-256-GCM encrypt/decrypt for API
      credentials, key from `MARKET_PULSE_SECRET_KEY` env; repo functions
      never return plaintext outside the sync path; redaction in logging.
      *DoD:* unit tests incl. tamper detection; grep-based no-plaintext test.
- [ ] **M1-T3 — Key intake + permission gate.** Settings UI (add/remove key,
      per-market toggle) + server route; on save, call the permissions
      endpoint and reject keys with trading/withdrawal enabled.
      *DoD:* live test with a trade-enabled key → rejected; read-only key →
      accepted; flag user to mint the real key.
- [ ] **M1-T4 — Futures sync pass.** Worker pass: income history → symbol
      discovery → userTrades per symbol with cursors; persist fills + income.
      *DoD:* integration test on `__fixtures__`-style fake Binance; live run
      captures owner history; re-run inserts 0 rows.
- [ ] **M1-T5 — Spot sync pass.** Candidate-symbol enumeration + myTrades
      with per-symbol cursors; persist.
      *DoD:* same bar as T4.
- [ ] **M1-T6 — Order-history sync (stop evidence).** Persist orders enough
      to answer "was there a stop order covering this position?" — this is
      the M3/R-normalization input.
      *DoD:* for a known position with a stop, the stop is retrievable; for
      one without, the absence is explicit.
- [ ] **M1-T7 — Position reconstruction.** Pure, fixture-tested module:
      fills → positions (side, avg entry/exit, size curve, fees, funding
      attribution, realized PnL, open remainder). Handle partial fills,
      adds, flips.
      *DoD:* fixture suite incl. a flip and a partial-close; deterministic.
- [ ] **M1-T8 — Reconciliation harness.** Script comparing reconstructed
      realized PnL vs exchange income per symbol/period; itemized diff.
      *DoD:* owner account reconciles within 0.1%; report committed
      (numbers may be redacted to percentages for privacy).
- [ ] **M1-T9 — Full-history backfill + progress.** Backfill job with
      resumable cursors and a progress row the UI can poll.
      *DoD:* owner's full history imported; interrupt/resume tested.
- [ ] **M1-T10 — `/journal` route.** Positions list (virtualized), filters
      (symbol/market/open-closed/date), summary header (totals only — counts,
      fees, net PnL; no behavioral judgments yet).
      *DoD:* renders owner's real history; mobile-first like the rest.
- [ ] **M1-T11 — Position detail view.** One position: fills timeline,
      fees/funding breakdown, linked orders (incl. stop evidence), raw facts.
      *DoD:* every number traceable to a persisted row.
- [ ] **M1-T12 — Incremental sync + health.** Schedule incremental sync in
      the worker loop; surface staleness in the existing health-watch SSE.
      *DoD:* measured sync lag ≤ 5 min over a day; staleness alert fires
      when sync is stopped manually.
