# R4-T8 review findings

Reviewed against `docs/forensics-definitions.md` v1.0.0 and EDR 0023.

## Findings

### Critical

1. **Stamp-at-open is reconstructed from closed trades, so the context is neither live-only nor never-backfilled.** `backend/app/worker/context_stamper.py:97-110` queries `BinanceTrade` rows, although that sync contains closed trades only, and selects rows whose stored interval happens to contain the observation time. `backend/app/worker/context_stamper.py:125-137` then constructs `TradeContext` directly from that `BinanceTrade`. This violates the explicit prohibitions on constructing context from a trade row and backfilling/reconstructing context. It also cannot correctly stamp an open position before its closed-trade row exists.

### High

2. **Unavailable-state evaluation is incomplete and writes rows that the definitions require withholding.** `backend/app/review/forensics_service.py:61-65` checks only estimated open time and an empty filtered candle list. It does not apply the fixed reason order for `not_enriched`, `testnet_source`, `undefined_for_partial_close`, `symbol_unresolvable`, `resolution_too_coarse`, `pending_bar_close`, or `insufficient_candles`. In particular, 1-2 candle windows are computed as available, and a still-forming final bar can be persisted despite the write-once rule.

3. **Persisted forensics are not `MetricValue`-shaped and contain silent nulls.** `backend/app/review/models.py:47-71` flattens metrics into nullable numbers plus a block-level availability/reason, omitting units, flags, and per-representation availability/reasons. `backend/app/review/forensics_service.py:76-87` consequently stores `mae_r`/`mfe_r` as null without their required `no_stop_on_record` or `zero_risk_distance` reason while MAE/MFE remain marked available. The API schema and `frontend/src/hooks/useForensics.ts` preserve these silent nulls. This violates R1/R3 even though the pure functions gate R correctly.

4. **Context episode handling writes repeated observations instead of one immutable first-observation stamp.** `backend/app/worker/context_stamper.py:112-119` deduplicates only within the previous five minutes. Each later tick can insert another context row for the same trade/episode. The required identity is one row per `(user_id, symbol, side, first_seen_at)` episode, with corrections only through `supersedes_id`.

### Medium

5. **Boundary inflation is not the defined price-range error bound.** `backend/app/review/forensics_service.py:58-59` derives it from `2 * interval / holding span` and clamps it to 100. Version 1.0.0 requires `max(first candle range, last candle range) / entry_price * 100`, plus a `boundary_inflated` disclosure flag when material.

6. **Stop discipline is applied whenever `stop_loss` is non-null, without requiring stop-hit evidence.** `backend/app/review/forensics_service.py:73-87` does not branch on `close_trigger` or persist `stop_evidence`/`discipline_breach`. The definitions limit numeric stop-discipline fields to `stop_evidence == "hit"`, define liquidation separately, and require absent evidence to report `no_stop_on_record`.

7. **Sizing variance is not integrated.** `backend/app/review/forensics_service.py:102` stores only per-row notional. The persistence/API/UI have no cohort mode, N, exclusion count, CV, median, hinges/IQR, size ratio, or explicit `insufficient_sample` versus `degenerate_cohort` state. The pure `sizing_variance` function distinguishes the reasons correctly, but no reviewed runtime path calls it.

8. **Frontend still renders unavailable/missing values as prohibited glyphs or zero fallbacks.** `frontend/src/components/features/review-panel.tsx:841-847` renders null R and latency as `—`; lines 884-902 and 920-925 use `?? 0` for available metrics; lines 783-786 omit the structured unavailable reason when no row exists. R3 requires an explicit reason, never `0`, `—`, `N/A`, or omission for unsupported measurements.

9. **Context fields do not match the frozen stamp record.** `backend/app/worker/context_stamper.py:26-32` uses a different session grid and labels (`asia`, `london`, `new_york`) instead of engine `asia`, `eu`, `us`, `off_hours`. Lines 35-67 omit required verdict fields/provenance/version metadata. Lines 70-77 fetch 30 days rather than the defined windows and store IDs plus mutable scores rather than serialized event facts and impact fields. `backend/app/binance_review/context_models.py` also omits observation source/lag, episode bounds, eval provenance/staleness, engine/config/git versions, impact version, and catalyst top.

10. **Re-entry prerequisite states are not enforced in integration.** The pure function correctly distinguishes overlap before no-prior (`backend/app/review/forensics.py:177-195`), but neither it nor its caller applies `not_enriched`, `estimated_open_time`, or `undefined_for_partial_close` to the current or predecessor trade. Estimated/partial rows can therefore receive a latency.

## Formula checklist

- MAE/MFE long/short formulas: pass in pure functions; asymmetric short test passes.
- Exit efficiency upper clamp and disclosure flag: pass in pure function. Negligible-MFE guard: pass.
- Stop adverse-slippage sign: pass for long and short in pure function.
- Re-entry `overlapping_positions` versus `no_prior_trade_in_window`: pass in pure function for otherwise valid rows; prerequisite-state integration fails.
- Sizing `insufficient_sample` versus `degenerate_cohort`: pass in pure function; runtime persistence/UI absent.
- R only with evidenced stop: pass in pure functions; persisted/API shape loses unavailable reasons. No silent nulls: fail. No backfill: fail.

## Verification

`python3 -m pytest tests/test_forensics.py -v` → **7 passed in 0.03s**.

The test suite covers core arithmetic but does not cover the persistence, unavailable-reason ordering, context-stamper, sizing integration, or frontend honesty failures above.

**Conclusion: R4 is not compliant with definitions doc v1.0.0.**

---

## Resolution — 2026-07-27

Every finding above was fixed. What changed, per finding:

1. **Stamp-at-open reconstructed from closed trades (critical).**
   `backend/app/worker/context_stamper.py` was rewritten. It no longer imports
   or queries `BinanceTrade` at all; it polls `BinanceExecClient.get_positions()`
   and stamps live positions with `positionAmt != 0`. The module docstring
   states the prohibition so the next editor sees it before the code.
2. **Unavailable-state evaluation incomplete.** `excursion_unavailable_reason`
   (`app/review/forensics.py`) implements the §3 table top-to-bottom, including
   `not_enriched`, `testnet_source`, `undefined_for_partial_close`,
   `symbol_unresolvable`, `resolution_too_coarse`, `pending_bar_close` and the
   `insufficient_candles` / `klines_unavailable` split at
   `MIN_WINDOW_CANDLES = 3`. `pending_bar_close` now writes **no row**
   (`build_forensics` returns `None`), honoring write-once. Ordering is
   test-asserted.
3. **Persisted forensics not `MetricValue`-shaped.** `TradeForensics.metrics` is
   now a single JSONB column holding the §2 shape per metric —
   `available / value / unit / reason / flags / forensics_version` — and
   `MetricValue.as_dict()` is its one serializer. `TradeForensicsResponse` and
   `useForensics.ts` carry the same shape end to end. A test asserts no metric
   is ever value-null-while-available or reason-null-while-unavailable.
4. **Repeated context observations.** `TradeContext` is now episode-scoped:
   `(user_id, symbol, side, first_seen_at)` unique, written on first observation
   only. A later sighting inside `EPISODE_GAP` advances `last_seen_at` (episode
   bookkeeping) and writes nothing; corrections go through `supersedes_id`.
5. **Boundary inflation.** `boundary_inflation_bound_pct(first, last, entry)`
   implements §4.4 exactly, and `disclose_boundary_inflation` sets the
   `boundary_inflated` flag when the bound exceeds 25 % of the measured value.
6. **Stop discipline without stop-hit evidence.** `stop_discipline` now takes
   `close_trigger`, returns `stop_evidence ∈ {hit, liquidated, absent}` plus
   `discipline_breach`, and emits numeric sub-fields only in the `hit` branch.
   `violation_depth_r` is separately gated on kline availability.
7. **Sizing variance not integrated.** `sizing_variance` is computed once per
   user cohort and persisted per row as `sizing_cv_percent`, `sizing_median`,
   `sizing_q1/q3/iqr/mean`, `sizing_notional`, `sizing_size_ratio` plus
   `sizing_mode / n / excluded / partial_close_rows`. `insufficient_sample` and
   `degenerate_cohort` survive to the API and the UI.
8. **Frontend rendered prohibited glyphs.** `review-panel.tsx` routes every
   measurement through `shown()` / `why()`; an unavailable metric renders an
   `<Unavailable>` reason badge. No `?? 0`, no `—`, no omission. Bar widths and
   the exit marker only render when the underlying metric is available.
9. **Context fields did not match the frozen record.** `TradeContext` now stores
   `observation_source`, `observation_lag_bound_seconds`, episode bounds,
   `verdicts_at_open` (all intents, with `setup_type`/`timeframe`/
   `no_trade_reasons`), `eval_log_id`, `eval_evaluated_at`,
   `eval_staleness_seconds`, `verdict_source ∈ {live, stale, not_in_universe}`,
   `engine_version`/`config_hash`/`git_sha`, serialized catalyst facts with
   their impact **as scored at `stamped_at`**, `catalyst_top`, and
   `impact_score_version`. The session grid is the engine's
   (`asia / eu / us / off_hours`), test-asserted.
10. **Re-entry prerequisites.** `reentry_latency` gates on `not_enriched`,
    `estimated_open_time` and `undefined_for_partial_close` for both the trade
    and its selected predecessor before subtracting.

Both migrations were rewritten to match and remain **unapplied** (DB is at
`f1a2b3c4d5e6`; head is `e3f4a5b6c7d8`).
