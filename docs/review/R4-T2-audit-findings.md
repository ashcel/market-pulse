# R4-T2 Audit Findings

## `backend/app/binance_review/service.py`

- **Critical — line 291:** Sync examines only the order that generated the matched closing fill. Because `classify_and_enrich` records a stop only when that closing order is a stop order, placed but untriggered protective stops remain `NULL` even though `/allOrders` contains them. Stop evidence therefore measures stop-outs, not stop usage.
- **High — line 192:** One `BinanceTrade` is persisted per non-zero `REALIZED_PNL` income event rather than per position. Partial and scaled exits become separate trades, overweighting those positions in trade counts, win rates, PnL rankings, time/session statistics, and style statistics.
- **High — line 283:** Entry reconstruction runs independently for every closing tranche and has no position/group state. Multiple exits can reuse the same opening fills, producing overlapping reconstructed positions and unreliable entry prices, R denominators, durations, and time/session attribution.
- **High — lines 258-263:** Enrichment fetches at most 1,000 fills and 500 orders without pagination. Higher-activity symbols can omit the closing fill/order match, leaving PnL rows with placeholder side, entry, quantity, duration, fee, ROI, and stop evidence.
- **High — line 254:** The enrichment window begins only two hours before the earliest close in a batch. Positions held longer than two hours can lack opening fills and receive the fixed five-minute fallback, corrupting duration, session, and style consumers.
- **High — lines 219, 299-301:** Leverage is initialized to `DEFAULT_LEVERAGE` and never enriched. ROI is then computed from this fabricated leverage, making ROI and downstream liquidation/severity/baseline/AI evidence wrong whenever actual leverage differs.
- **Medium — line 280:** `fees` captures only the matched closing fill's commission, omitting opening commissions and other fills. Downstream consumers present this as the trade's total fees.
- **Medium — lines 278-280:** `parse_float(...) or existing` treats valid zero values as missing, so zero-valued exchange evidence cannot replace placeholders.
- **Medium — line 186:** Income pagination advances to the last row timestamp plus 1 ms. If a full page ends within multiple events sharing that millisecond, remaining events at the same timestamp are skipped, silently losing trades and PnL.
- **Medium — lines 319-346:** Incremental sync starts at `last_sync_at` but records wall-clock completion time rather than the exchange query end/cursor. Late-arriving events timestamped before completion can be permanently missed.
- **Medium — lines 264-265:** Per-symbol enrichment failures are swallowed while sync can still report success and advance `last_sync_at`. Estimated rows may be retried, but consumers receive no partial-data status and can silently use degraded evidence.

## `backend/app/binance_review/enrichment.py`

- **Critical — lines 129-147:** Stop and take-profit evidence is derived solely from the order that closed the fill. Untriggered protective orders are ignored, so `stop_loss`/`take_profit` encode the close mechanism rather than whether protection was placed.
- **Medium — lines 62-68:** Entry detection equates `realizedPnl == 0` with opening exposure. Breakeven reductions, hedge-mode activity, and reversals can violate that heuristic, causing closing fills to be consumed as entries.
- **Medium — lines 71-117:** Each close reconstructs an entry by walking same-side zero-realized-PnL fills until the closing quantity is covered. It does not consume or allocate fills across closes, permitting reuse across scaled exits.

## `backend/app/binance_review/models.py`

- **High — lines 38-76:** The synced-trade schema has no MAE, MFE, excursion series, excursion availability reason, or forensics version. No evidenced excursion metric can reach any sync-path consumer.

## `backend/app/review/analytics.py`

- **High — lines 115-132:** Aggregate R consumes the stop-out-biased `stop_loss` subset. Winning and manually closed trades with valid untriggered stops are excluded, so average R systematically misrepresents the population.
- **High — line 118:** R mode activates with five evidenced rows and 30% coverage. An aggregate R can therefore represent a minority, stop-hit subset while 70% of trades lack stop evidence.
- **High — line 122:** Risk uses `abs(entry_price - stop_loss) * quantity` without validating stop direction relative to side. A long stop above entry or short stop below entry produces a plausible but invalid R.
- **High — lines 168, 270-271:** Hour and session metrics consume `opened_at` without checking `open_time_source`. Estimated rows use close time minus five minutes, turning exit-time-derived data into purported entry-time behavior.
- **High — lines 196-200:** Best/worst hour is selected post hoc as the observed maximum/minimum win rate without holdout or multiple-comparison control. Consumers present descriptive extrema as edge evidence.
- **High — lines 309-315:** The quality filter requires `open_time_source == "order_history"`, while Binance enrichment emits `"user_trades"`. The high-quality branch is unreachable, so style analytics always include estimated timestamps.
- **High — lines 317-326:** Five-minute fallback rows enter the scalp bucket, contaminating scalp win rate/PnL/expectancy. The maximum in-sample expectancy with only five observations becomes a high-confidence style recommendation.
- **Medium — lines 160-161:** Best/worst trade uses gross `realized_pnl`; fees and funding are not deducted, but the consumer does not qualify PnL as gross.
- **Medium — lines 135-140:** Payoff mode classifies zero-PnL rows as losses, distorting average loss and expectancy. The same classification appears in style statistics at lines 294-299.
- **Medium — line 148:** Fallback label `% payoff (no stop on record)` can be false when stop evidence exists but misses the five-trade or 30% gate.
- **Medium — lines 253-257:** Session win rates have no minimum sample gate. A one-trade session can be selected and presented as the strongest session.

## `backend/app/binance_review/router.py`

- **Medium — line 111:** The trades endpoint defaults to 20 rows. The frontend does not request additional pages, so per-trade and AI consumers use only the newest 20 while server analytics use the full dataset.

## `frontend/src/hooks/useReview.ts`

- **Medium — lines 152-165:** Trade fetching omits `page` and `per_page` and performs no pagination. Trade rows, AI baseline, and previous-trade context are limited to the newest 20, creating inconsistent win-rate/duration/leverage evidence versus server analytics.

## `frontend/src/components/features/review-panel.tsx`

- **High — lines 416-442:** The UI presents stop-out-subset average R as generic `RR` / `R-multiple (stop-based)` without displaying coverage or sample size, hiding that the metric may represent only 30% of trades.
- **High — lines 469-480:** Post hoc best-hour results are framed as `Best hour` and, in fallback, the highest observed session as `strongest`, overstating descriptive win-rate splits as evidence of edge.
- **High — lines 600-607:** A style selected from in-sample expectancy with as few as five observations is marked `Recommended`.
- **Medium — lines 508-512:** Frontend expects confidence `"ok"`, but backend emits `"high"`. Every actual recommendation is displayed as `Low confidence`; the badge typing is likewise incompatible.
- **Medium — lines 425-428, 476-480:** The best-session fallback has no sample threshold, allowing a one-trade session to be labeled strongest.
- **Medium — lines 610-617:** Style win rate and expectancy render for any non-empty bucket, including one-observation buckets, without an insufficient-evidence state.
- **Medium — lines 670-684:** Placeholder/estimated rows render like enriched rows with no `open_time_source` or data-quality warning, despite potentially zero entry/exit/quantity and absent stop evidence.
- **Low — lines 443-448:** A missing `avg_r_multiple` is coerced to zero for tone selection, assigning bullish tone logic to unavailable R.

## `frontend/src/lib/review/prompt.ts`

- **High — lines 49-67:** AI instructions explicitly solicit `max adverse excursion`, but the prompt supplies no measured MAE/MFE. The model can infer or fabricate excursion from coarse candle summaries instead of consuming evidenced data.
- **Medium — lines 160-163, 199-202:** Non-null `stop_loss` becomes `Stop Loss Set: Yes`, while null becomes `No`. Sync data actually means the closing fill was or was not generated by a stop, creating a direct false behavioral claim.
- **Medium — lines 174-176:** A manual-market loss is framed as possible deviation from a planned stop even though sync cannot observe an untriggered protective stop. Combined with `Stop Loss Set: No`, this primes unsupported discipline judgments.
- **Medium — line 199:** The prompt labels closing-fill commission as `Fees`, implying complete trade costs although entry and other fill fees are absent.
