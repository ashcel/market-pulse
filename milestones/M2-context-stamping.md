# M2 — Context stamping (engine replay)

**Goal:** every imported trade carries the market context that existed when it
was opened and closed — engine state replayed as-of the trade's bar, plus
whatever external context (events, catalysts, breadth, funding) was ingested
at the time. This is the payoff of the engine's replay-safety discipline.

**Depends on:** M1 (trades exist).

## Success criteria (all measurable)

- [ ] ≥ 95% of historical positions stamped; every unstamped one carries an
      explicit reason (e.g. symbol lacks kline history at that date).
- [ ] Determinism: stamping the same position twice produces byte-identical
      context JSON (hash-asserted in a test **and** verified on 20 live
      positions re-stamped).
- [ ] Parity: the replay path reuses `assembleEvaluateInputs`/`evaluateSymbol`
      unchanged — proven by a test that diffing replay-at-latest-bar vs the
      live evaluate path yields identical output. Zero engine-semantics edits
      (`ENGINE_VERSION` untouched, `git diff` on engine decision files empty).
- [ ] External context joined where it exists; absence rendered as "not
      ingested at trade time", never interpolated or backfilled from later
      data.
- [ ] Trade detail shows a context card: regime, structure state, intent
      verdict at the time, premium/discount, session, distance-to-nearest-POI,
      spike/discovery state, active catalysts/events.

## Guardrails

- Replay must be bar-limited (closed bars up to the trade timestamp only) —
  reuse the engine's existing as-of-bar conventions; any lookahead is a
  correctness bug, not a nice-to-have.
- Context stamps are **descriptive**. The stamp includes the engine's verdict
  at the time as a fact about the past; the UI must not editorialize it as
  "you should have listened" (that analysis belongs to M5, with statistics).
- Stamps record `engine_version` + `config_hash` provenance like every other
  persisted engine artifact.

## Tasks

- [ ] **M2-T1 — Replay API.** `replayEvaluateAt(symbol, market, timestamp)`:
      fetch historical klines through the existing tiered fetcher, truncate
      to closed bars as-of timestamp, run `assembleEvaluateInputs` →
      `evaluateSymbol`. Pure orchestration; no engine edits.
      *DoD:* parity test (replay at latest bar ≡ live path); as-of test
      (replay at T ignores bars > T, fixture-proven).
- [ ] **M2-T2 — Context schema.** Migration `0007`: `trade_context` (position
      FK, at-open/at-close stamps, context JSON, provenance, stamp reason /
      absence reason). Repo functions + types.
      *DoD:* migration + repo tests.
- [ ] **M2-T3 — External-context join.** Pure module joining a timestamp to
      persisted `market_context_snapshot`, `token_event`, `catalyst_event`
      rows valid at that time; explicit `absent` markers before ingestion
      start dates.
      *DoD:* fixture tests incl. the absence case.
- [ ] **M2-T4 — Stamping worker pass.** New worker pass stamping unstamped
      positions (newest first), rate-limit-budgeted, resumable.
      *DoD:* idempotent (re-run stamps 0); progress visible in health view.
- [ ] **M2-T5 — Historical backfill run.** Stamp the owner's full history;
      produce `docs/stamping-report.md` (coverage %, absence reasons
      histogram, runtime).
      *DoD:* ≥95% coverage or every gap explained; determinism spot-check on
      20 re-stamps.
- [ ] **M2-T6 — Context card UI.** Trade-detail section rendering the stamp:
      chart-adjacent, glanceable, mobile-first; explicit "context not
      available" states.
      *DoD:* renders for a stamped and an unstamped position.
- [ ] **M2-T7 — Journal context filters.** Filter/group journal by stamped
      dimensions (regime, session, intent-verdict-at-open, market).
      *DoD:* filters compose with M1 filters; counts shown per bucket.
- [ ] **M2-T8 — Stamp-at-open for live trades.** New fills detected by
      incremental sync get stamped within one worker cycle, using live
      context (no replay needed); replay reserved for backfill.
      *DoD:* open a paper-scale real position → stamped within 15 min;
      stamp equals what replay produces for the same bar (spot-checked).
