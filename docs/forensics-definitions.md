# Trade Forensics — frozen formula specification

**Status:** Frozen (2026-07-26, R4-T1). Every downstream R4 task keys off this
document: R4-T3 implements `backend/app/review/forensics.py` against these
formulas and seeds its fixtures from the worked examples below; R4-T4
persists exactly these fields; R4-T5 implements the stamp-at-open record in
§8; R4-T6/T7 render and narrate only what is defined here; R4-T8 reviews the
whole diff against it.

**Companion decision record:** `docs/decisions/0023-forensics-measurement-boundary.md`
(why these rules, what was rejected). This document holds the arithmetic; the
EDR holds the boundary.

```
FORENSICS_DEFINITIONS_VERSION = "1.0.0"
```

**Version rule.** The constant lives in `backend/app/review/forensics.py`
(R4-T3) and is stamped on every persisted forensics row and every
stamp-at-open context row. **Changing any formula, sign convention, window
rule, threshold, unavailable-reason, or unit in this document is a version
bump.** On a bump, previously computed rows are *not* silently reinterpreted:
they keep their old version stamp and are recomputed from source (exchange
rows + klines) into new rows, or they are marked stale. Two rows with
different `forensics_version` are never pooled into one distribution. This
mirrors the `ENGINE_VERSION` discipline (`engine/smc/version.py`) and the
`IMPACT_SCORE_VERSION` discipline (`backend/app/events/impact.py:63`) — but it
is a *separate* clock: forensics measure outcomes, they never change what the
engine decides, so a forensics bump never touches `ENGINE_VERSION`.

---

## 1. Scope and the four standing rules

Forensics are **deterministic measurements of what already happened**,
computed from two sources only:

1. the user's own exchange rows — `BinanceTrade`
   (`backend/app/binance_review/models.py:38`), and
2. public klines for the same instrument and interval, fetched from Binance.

Four rules bind every metric below (they are the R4 honesty rules, restated
in measurement terms):

- **R1 — R only where a stop is evidenced.** An R-denominated value may be
  produced *only* when `BinanceTrade.stop_loss IS NOT NULL` **and**
  `|entry_price − stop_loss| > 0` on that row. Everywhere else the display is
  percent of entry, plus MAE/MFE. No synthetic stop, no "assume 1%", no
  account-risk-derived stop. (EDR 0017 decision 3.)
- **R2 — no edge claims.** Every aggregate here is a count, a ratio, a
  dispersion, or a histogram bin. Nothing in this document is a probability,
  a forecast, or an expectancy sold as edge.
- **R3 — never a zero, never a silent null.** Every metric returns a
  `MetricValue` (§2). When the inputs do not support it, the value is
  `available: false` with one of the enumerated reasons in §3. A missing
  measurement is never rendered as `0`, `—`, `N/A`, or an omitted field.
- **R4 — measurement, not replay.** Reading a public kline series over an
  interval the user was demonstrably in a position is measurement. Re-running
  the engine over history to ask "what would it have said" is replay and stays
  deferred (EDR 0022 decision 3). Nothing in this document reconstructs an
  engine verdict for a past moment.

## 2. The `MetricValue` shape

Every metric — per-trade and cohort — is serialized in this shape. R4-T3
defines it once; R4-T4/T6 never invent a second one.

```
MetricValue {
  available: bool
  value:     float | null      # null iff available == false
  unit:      "percent_of_entry" | "quote_currency" | "r_multiple"
           | "ratio_percent" | "seconds" | "count" | "unitless"
  reason:    UnavailableReason | null   # non-null iff available == false
  flags:     list[str]         # never load-bearing; disclosure only
  forensics_version: str
}
```

`flags` carries disclosures that do **not** invalidate the value:
`adverse_excursion_none`, `exit_outside_kline_range`, `immediate_reversal`,
`entry_basis_weighted_average`, `boundary_inflated`, `partial_close_suspected`.

Companions stored alongside a per-trade forensics row, used by every metric
and by the reader to judge the measurement's own precision:

```
kline_interval:                 "1m" | "5m" | "15m" | "1h" | "4h" | "1d"
kline_candles_in_window:        int
boundary_inflation_bound_pct:   float   # §4.4
```

## 3. Unavailable reasons — the closed enumeration

Exactly these strings. R4-T3 defines them as a `StrEnum`; nothing else may be
written into `MetricValue.reason`. Evaluation order is fixed (top to bottom):
the **first** matching condition wins, so a given input always produces the
same reason string.

| # | Reason | Condition | Applies to |
|---|---|---|---|
| 1 | `not_enriched` | `entry_price <= 0` or `exit_price <= 0` or `quantity <= 0` — a placeholder row from `_upsert_trade_from_income` whose closing fill has not been matched yet | all |
| 2 | `testnet_source` | the trade was synced with `BINANCE_REVIEW_TESTNET=true`; testnet fills do not lie on the mainnet kline series | all excursion metrics |
| 3 | `estimated_open_time` | `open_time_source == "estimated"` — `opened_at` is the literal constant `closed_at − 5 min` (`ESTIMATED_OPEN_OFFSET_MS`), not an observation | MAE, MFE, exit efficiency, stop discipline (depth), re-entry latency |
| 4 | `undefined_for_partial_close` | the row is a member of a suspected scale-out group (§7.5) | MAE, MFE, exit efficiency, re-entry latency |
| 5 | `symbol_unresolvable` | `BinanceTrade.symbol` cannot be mapped to a kline feed (§4.2) | all excursion metrics |
| 6 | `resolution_too_coarse` | holding span < 3 × the finest supported interval (i.e. held under 3 minutes at the 1m floor) | MAE, MFE, exit efficiency, stop-violation depth |
| 7 | `pending_bar_close` | the last in-window candle has not closed yet (§4.5) — recompute on the next tick | MAE, MFE, exit efficiency, stop-violation depth |
| 8 | `klines_unavailable` | `fetch_klines` returned an empty list (upstream error, delisted symbol, rate limit) | MAE, MFE, exit efficiency, stop-violation depth |
| 9 | `insufficient_candles` | fewer than `MIN_WINDOW_CANDLES = 3` candles inside the window despite an adequate span (feed gap) | MAE, MFE, exit efficiency, stop-violation depth |
| 10 | `no_stop_on_record` | `stop_loss IS NULL` | every R-denominated value; stop discipline |
| 11 | `zero_risk_distance` | `stop_loss` present but `|entry_price − stop_loss| == 0` | every R-denominated value; stop discipline |
| 12 | `negligible_favorable_excursion` | `MFE_pct < EFFICIENCY_MIN_MFE_PCT = 0.10` | exit efficiency only |
| 13 | `no_prior_trade_in_window` | no earlier closed trade for this `(user_id, symbol)` inside the synced window | re-entry latency only |
| 14 | `overlapping_positions` | the candidate predecessor's `closed_at` is strictly after this trade's `opened_at` | re-entry latency only |
| 15 | `insufficient_sample` | cohort `N < MIN_SIZING_SAMPLE = 5` | sizing variance only |
| 16 | `degenerate_cohort` | cohort mean ≤ 0, or every member has the identical value and the dispersion question is vacuous | sizing variance only |

Note the ordering consequence: a not-yet-enriched row always reports
`not_enriched`, never `klines_unavailable`, even if both are true. Tests
assert the ordering.

---

## 4. Kline resolution and window rules (excursion metrics)

These rules govern MAE, MFE, exit efficiency and the stop-violation depth
component of stop discipline. They are the single most bug-prone part of the
spec, so they are normative in full.

### 4.1 Interval ladder — 1-minute default

The interval is chosen per trade as **the finest interval on this ladder that
covers the trade's holding span in ≤ 900 candles**:

```
1m → 5m → 15m → 1h → 4h → 1d
```

| Interval | Max span it covers at 900 candles |
|---|---|
| 1m | 15 h |
| 5m | 3 d 3 h |
| 15m | 9 d 9 h |
| 1h | 37 d 12 h |
| 4h | 150 d |
| 1d | 900 d |

The chosen interval is **stamped on the row** (`kline_interval`), so every
value is self-describing and two trades measured at different resolutions are
never silently compared as equally precise.

**Why 1m as the floor, and why a ladder.** `SCALP_MAX_MS` in
`backend/app/review/constants.py` is 30 minutes — a large share of the
population is scalps. At a 15-minute interval a 6-minute scalp resolves to a
single candle whose high/low spans 15 minutes of tape the user was mostly not
in; MAE/MFE would be dominated by measurement error. 1m is the finest
interval Binance USDT-M futures publishes, so it is the precision floor
available at all. The ladder exists because 900 × 1m is only 15 hours: a swing
trade held nine days cannot be measured at 1m within the request budget, and
paging 13,000 candles for one review row is not a proportionate use of the
shared rate limiter (`_WeightLimiter`, `backend/app/worker/binance.py:84`).
900 rather than 1000 leaves headroom for the boundary candles and the fetcher's
own `limit` clamp.

**Rejected alternatives.** A single fixed interval for all trades (simple, but
either uselessly coarse for scalps or unaffordable for swings). Interpolating a
synthetic intrabar path to recover sub-interval precision — that fabricates
price action and is replay-flavored (rule R4); we report a bound instead
(§4.4).

**Implementation note (a real constraint, not a detail).**
`fetch_klines` (`backend/app/worker/binance.py:179`) takes a `TokenTimeframe`
and looks it up in `BINANCE_INTERVALS` (`binance.py:22`), which contains only
`15M / 30M / 1H / 4H / 1D / 1W`. **It cannot express 1m or 5m today.** R4-T4
must add a raw-interval sibling in the same backend module — something like
`fetch_klines_raw(exchange_symbol: str, interval: str, limit: int, end_time: int, market: MarketType)`
that skips `resolve_exchange_symbol` and the `TokenTimeframe` map. This is a
**backend fetch-plane change only**; it does not touch `engine/smc/` and is
therefore not an engine-semantics change and not an `ENGINE_VERSION` bump. If
that sibling is not built, the degraded mode is the existing `15M` path plus
`resolution_too_coarse` for every trade held under 45 minutes — which would
silence the majority of the population, and is why the sibling is specified
as required work rather than optional.

### 4.2 Symbol and market resolution

- **Market is always `perp`.** `BinanceTrade` rows are USDT-M futures
  round-trips reconstructed from `/fapi/v1/income`; klines must come from
  `https://fapi.binance.com/fapi/v1/klines`.
- **`BinanceTrade.symbol` is already the exchange symbol** — the income row's
  `symbol` field, e.g. `BTCUSDT`, `1000PEPEUSDT`. It must be passed to the
  kline fetch **verbatim, with `price_scale = 1`**.
  `resolve_exchange_symbol` (`backend/app/worker/binance.py:62`) expects a bare
  ticker and appends `USDT`; feeding it `BTCUSDT` yields `BTCUSDTUSDT` and an
  empty list. It also *divides* prices by the 1000× override scale for symbols
  like `1000PEPE` — but the trade row's `entry_price`/`exit_price` are quoted
  in exchange units (per 1000 PEPE), so descaling the klines would compare two
  different price scales. Hence: raw symbol, no scaling. Failure to resolve →
  `symbol_unresolvable`.

### 4.3 Timestamp normalization — mandatory

`binance_trades.opened_at` and `closed_at` are
`TIMESTAMP WITHOUT TIME ZONE` (migration
`backend/migrations/versions/f1a2b3c4d5e6_binance_review_models.py:90,92`),
written by `datetime.fromtimestamp(ms / 1000)` in
`backend/app/binance_review/service.py`. That constructor is **local-time,
naive** and the production VPS runs at **UTC+8**. So these columns hold naive
UTC+8 wall-clock instants, while `Candle.time`
(`backend/app/worker/binance.py:148`) is epoch **seconds, UTC**, and the
forward-test tables use `DateTime(timezone=True)`.

**Rule:** forensics must convert with an explicit, tested helper —
`epoch_ms(dt) = dt.replace(tzinfo=LOCAL_TZ).timestamp() * 1000` where
`LOCAL_TZ` is the writer's zone — and must never call `.timestamp()` on the
raw column value under an assumption that it is UTC, and never compare it to a
`datetime.now(UTC)`. A single round-trip unit test (naive column → epoch ms →
back) is required by R4-T3. The correct long-term fix is to migrate the two
columns to `timestamptz` and write `datetime.now(UTC)`; that is a data
migration with a backfill and is explicitly **out of R4-T1's scope** — it is
recorded as a finding in §9.

### 4.4 Window boundaries

Let `S_ms` be the chosen interval in milliseconds, `t_open` and `t_close` the
normalized epoch-ms instants of `opened_at` and `closed_at`.

```
first_open_ms = floor(t_open / S_ms) * S_ms
last_open_ms  = floor((t_close - 1) / S_ms) * S_ms
window        = { candles c : first_open_ms <= c.open_time_ms <= last_open_ms }
```

The `− 1 ms` matters: an exit landing exactly on a candle boundary
(`t_close = 12:05:00.000`) belongs to the candle that *ended* there, not to
the one that starts there. Without it, every boundary-aligned exit imports a
whole extra candle of post-exit tape into MFE.

Both boundary candles are included **whole**. The entry fill happened somewhere
inside the first candle and the exit fill somewhere inside the last, so part of
each candle's range is outside the position's life. This **inflates** MAE and
MFE by at most one candle's range at each end. The row therefore stamps its own
error bar:

```
boundary_inflation_bound_pct
  = max(range(first_candle), range(last_candle)) / entry_price * 100
  where range(c) = c.high - c.low
```

and sets the `boundary_inflated` flag when that bound exceeds 25 % of the
measured MFE or MAE. **Inclusive is the normative default** because MAE/MFE are
risk-facing numbers: over-stating how far a trade went against the user is the
conservative error, understating it is the dangerous one. The strict
alternative (fully-contained candles only, with `entry_price`/`exit_price` as
the endpoints) is biased the other way and is not used.

`MIN_WINDOW_CANDLES = 3`. Fewer than three candles in the window → reason 6 or
9 per §3.

### 4.5 The still-forming final candle

Binance returns the in-progress bar as the last kline row;
`drop_unclosed_candle` (`backend/app/worker/binance.py:72`) already encodes the
project's convention that nothing may react to an unclosed bar. Forensics
apply it and then go one step further:

**If `last_open_ms + S_ms > now`, the trade closed inside a bar that has not
finished forming. No forensics row is written.** The metric returns
`pending_bar_close` and the worker recomputes on a later tick.

Rationale: a forming bar's high/low can only widen, so a value computed on it
is provisional and would have to be *mutated* later. Forensics rows are
write-once per `forensics_version`; a value that changes after publication is
indistinguishable from a bug, and the AI memo in R4-T7 would cite a number that
later moved. Waiting one bar costs at most 60 seconds at the 1m floor.

### 4.6 `open_time_source == "estimated"`

`resolve_real_open_time` (`backend/app/binance_review/enrichment.py:71`) falls
back to `close_ms − ESTIMATED_OPEN_OFFSET_MS` (a hard-coded 5 minutes) and
returns **no entry price** when the opening fills on record do not add up to
the closed size. For such rows:

- `opened_at` is a constant, not an observation — the window is fictitious.
- `entry_price` was never overwritten, so it is either `0.0` (fresh
  placeholder) or a stale value.

Therefore **every excursion metric and re-entry latency is unavailable with
reason `estimated_open_time`** (or `not_enriched`, which sorts first when the
price is also missing). No fallback window, no "approximate" badge on a
computed number. The honest output is the absence.

---

## 5. Per-trade metrics

Notation, fixed for the whole document:

```
E      = trade.entry_price
X      = trade.exit_price
Q      = trade.quantity
SL     = trade.stop_loss                       (may be null)
Hmax   = max(c.high for c in window)
Lmin   = min(c.low  for c in window)
risk   = |E - SL|                              (per unit; defined only when SL is not null)
```

### 5.1 MAE — Maximum Adverse Excursion

**Plain language.** The worst the position was ever losing, on a closing- or
intrabar basis, between the moment it opened and the moment it closed. It
answers *"how much heat did I actually take?"* and it is the number that tells
a user whether their stop was where their pain was — a trade that wins after
an MAE of 0.9 R was not a good trade, it was a survived one.

**Formula.**

```
LONG :  MAE_price = max(0, E - Lmin)
SHORT:  MAE_price = max(0, Hmax - E)

MAE_pct = MAE_price / E * 100
MAE_r   = MAE_price / risk          # only when SL is not null and risk > 0
```

The `max(0, …)` floor is definitional, not defensive: an excursion that never
went adverse is an adverse excursion of zero. See §7.3 for why that zero is
*available*, not unavailable.

**Inputs.** `side`, `entry_price`, `opened_at`, `closed_at`,
`open_time_source`, `symbol` from `BinanceTrade`; `stop_loss` for the R
variant; kline lows/highs over the §4 window.

**Units.** Primary `percent_of_entry`. Secondary `quote_currency`
(`MAE_price × Q`, the dollar heat). **R permitted** as a third
representation, gated by R1.

**Unavailable reasons.** 1, 2, 3, 4, 5, 6, 7, 8, 9 for the metric itself; 10
and 11 additionally suppress `MAE_r` while leaving `MAE_pct` available.

### 5.2 MFE — Maximum Favorable Excursion

**Plain language.** The best the position was ever winning before it closed.
Paired with the realized result it answers *"how much of what was there did I
take?"* — the raw material for exit efficiency and for the "you exit early"
habit.

**Formula.**

```
LONG :  MFE_price = max(0, Hmax - E)
SHORT:  MFE_price = max(0, E - Lmin)

MFE_pct = MFE_price / E * 100
MFE_r   = MFE_price / risk          # only when SL is not null and risk > 0
```

Note the exact mirror of §5.1: MAE reads the *low* for a long and the *high*
for a short; MFE reads the *high* for a long and the *low* for a short. Getting
this pair backwards is the classic bug; R4-T3 must include a short fixture
whose MAE and MFE differ in magnitude (Example B) so a swapped implementation
cannot pass.

**Inputs / units.** As §5.1. **R permitted**, gated by R1.

**Unavailable reasons.** Identical set to §5.1.

**No look-forward.** MFE is measured over `[opened_at, closed_at]` only.
"What the trade did after you exited" is a different question, is not defined
in version 1.0.0, and must not be computed and shown next to these numbers —
it invites the counterfactual framing the product does not make.

### 5.3 Exit efficiency

**Plain language.** What share of the favorable move that was available while
the position was open did the exit actually capture. It informs the single
most common named habit: cutting winners early (high MFE, low efficiency)
versus round-tripping them (positive MFE, negative efficiency).

**Formula.**

```
LONG :  realized_move = X - E
SHORT:  realized_move = E - X

exit_efficiency = realized_move / MFE_price * 100          # ratio_percent
```

**Range and sign.** Upper-bounded by 100 % by construction, because the exit
fill occurred inside the window and therefore inside `[Lmin, Hmax]`. If a fill
prints outside the kline range (possible at the boundary, or on an
off-book/liquidation fill), clamp to 100 % and set the
`exit_outside_kline_range` flag — the clamp is disclosed, never silent. The
value is **not** lower-bounded: a loser has negative efficiency and that is the
honest reading. No clamping at the bottom.

**The negligible-MFE guard.** When `MFE_pct < EFFICIENCY_MIN_MFE_PCT = 0.10`,
the ratio's denominator is at the scale of tick noise and the result is an
arbitrarily large number carrying no information (Example D would report
−1625 %). In that case the metric is **unavailable** with reason
`negligible_favorable_excursion`. This is a stated threshold, not a hidden
clamp: the row still shows MAE and MFE, and the reason string tells the reader
exactly why efficiency is absent. Above the threshold the raw ratio is reported
unclamped, however ugly.

**Units.** `ratio_percent`. **R is NOT permitted** — exit efficiency is already
a dimensionless ratio; expressing it "in R" is meaningless and any render that
does so is a bug (R4-T8 checks for this).

**Unavailable reasons.** 1–9 (inherited from MFE), plus 12.

### 5.4 Stop discipline

**Plain language.** Did the stop that was on the book get honored, and what did
it cost when it fired. It informs the habits "you move your stop" and "you let
it go to liquidation" — but see the coverage caveat immediately below, which is
the most important sentence in this section.

**Coverage caveat (structural).** `classify_and_enrich`
(`backend/app/binance_review/enrichment.py:129`) populates `stop_loss`
**only when the order that produced the closing fill was of type `STOP` or
`STOP_MARKET`** — that is, only when the stop was *hit*. A user who placed a
protective stop and then exited manually, or took profit, leaves `stop_loss`
NULL. **The data model therefore cannot distinguish "had no stop" from "had a
stop and did not need it" from "had a stop, widened it, and survived".** Stop
discipline in version 1.0.0 is consequently a narrow measurement of *stop-hit
quality*, not of *stop-honoring behavior*. It is defined honestly as such
rather than approximated. See finding F1 in §9.

**Sub-fields.**

```
stop_evidence ∈ { "hit", "liquidated", "absent" }
  "hit"        : SL is not null                      (close_trigger == "sl_hit")
  "liquidated" : close_trigger == "liquidation"      (SL is null by construction)
  "absent"     : otherwise
```

When `stop_evidence == "absent"`, every numeric sub-field below is unavailable
with reason `no_stop_on_record`. When `"liquidated"`, the numeric sub-fields are
likewise unavailable (Binance reports no stop price on a liquidation order),
but the boolean `discipline_breach = true` is set: a liquidation is, by
definition, a position that had no effective stop. This boolean is a fact about
an exchange row, not an inference.

When `stop_evidence == "hit"`:

```
# 1. Adverse fill slippage — the side-normalized correction of the stored column.
#    BinanceTrade.sl_slippage is written as (exit_price - stop_price) with NO
#    side normalization (enrichment.py:142), so its sign means opposite things
#    for LONG and SHORT.
LONG :  slippage_adverse = SL - X            # == -sl_slippage
SHORT:  slippage_adverse = X - SL            # == +sl_slippage

slippage_adverse_pct = slippage_adverse / E * 100
slippage_adverse_r   = slippage_adverse / risk

# Positive = filled worse than the trigger. Negative = filled better
# (positive slippage on a gap through); reported as-is, never floored.

# 2. Stop violation depth — how far past the stop price traded, in R.
LONG :  violation_depth_r = max(0, SL - Lmin) / risk
SHORT:  violation_depth_r = max(0, Hmax - SL) / risk

# 3. Realized loss vs. the one-R the stop promised.
realized_r = (LONG ? X - E : E - X) / risk
```

The identity `realized_r ≈ −(1 + slippage_adverse_r)` holds for a clean
stop-out and is a useful invariant for R4-T3's fixtures (Example D
demonstrates it exactly).

**Inputs.** `side`, `entry_price`, `exit_price`, `stop_loss`, `close_trigger`,
`sl_slippage` from `BinanceTrade`; klines for `violation_depth_r` only.

**Units.** `slippage_adverse` in `quote_currency` and `percent_of_entry`;
`slippage_adverse_r`, `violation_depth_r`, `realized_r` in `r_multiple`.
**R permitted** — and note that here it is permitted *by construction*: every
R-denominated sub-field exists only in the `"hit"` branch, which requires
`stop_loss` non-null. There is no code path in which stop discipline emits an R
value without an evidenced stop.

**Unavailable reasons.** 1, 3, 10, 11 for the whole block; 2, 4–9 additionally
for `violation_depth_r`, which is the only kline-dependent sub-field.

**Explicitly not defined in 1.0.0.** Stop movement over the life of the trade
(requires an order-amendment history the sync does not fetch); "stop too tight
for volatility" (that is a pre-trade judgement and already lives in the Trade
Quality Score, `docs/trade-quality-score.md`); and any stop taken from
`execution_records.stop_price`. That last one is tempting — an IQ-placed trade
has a genuinely evidenced intended stop — but there is no join between
`execution_records` and `binance_trades` today (finding F2, §9), and R1 as
written gates R on `stop_loss` on the trade row. Adopting an execution-record
stop as evidence is a **definitions version bump**, not a quiet improvement.

### 5.5 Re-entry latency

**Plain language.** How long the user waited after closing a position in a
symbol before opening the next one in that same symbol. It informs
revenge-trading and overtrading habits, and it is the metric the R3 skip-check
detectors read back.

**Formula.** For a trade `t` belonging to user `u` and symbol `s`, let

```
prev(t) = the trade p with p.user_id == u, p.symbol == s,
          p.closed_at maximal among those with p.closed_at <= t.opened_at
```

then

```
re_entry_latency_seconds = (t.opened_at - prev(t).closed_at).total_seconds()
```

Both timestamps are normalized per §4.3 before subtracting; because both come
from the same column family the offset cancels, but the helper is still used so
the code has one conversion path.

Companion booleans, computed only when the latency is available:

```
re_entry_same_direction = (t.side == prev(t).side)
re_entry_after_loss     = (prev(t).realized_pnl < 0)
```

The habit-relevant cut is `re_entry_after_loss AND latency < 300 s` — but the
*threshold lives in the habit detector, not here*. This document defines the
measurement only; naming a latency "revenge trading" is R4-T6/T7's job and
must be stated as a count ("4 of your 11 losses were re-entered within 5
minutes"), never as a probability.

**Sign and ordering.**

- `latency == 0` is **available and legitimate** — a flat-and-reverse in the
  same second. It sets the `immediate_reversal` flag.
- `latency < 0` is impossible under the `prev(t)` definition, which already
  requires `p.closed_at <= t.opened_at`. If a candidate predecessor exists whose
  `closed_at > t.opened_at`, the two positions overlapped: reason
  `overlapping_positions`. Never emit a negative latency.
- If no predecessor exists inside the synced window, reason
  `no_prior_trade_in_window` — **not** a large latency. The window boundary is
  `BINANCE_REVIEW_SYNC_LOOKBACK_DAYS` (default 30) on first sync, so the
  earliest trade for every symbol structurally has no evidenced predecessor.
  Reporting "31 days since your last SOL trade" from a window edge would be an
  artifact of the sync, not a fact about the user.

**Inputs.** `user_id`, `symbol`, `side`, `opened_at`, `closed_at`,
`open_time_source`, `realized_pnl`. **No klines.**

**Units.** `seconds` stored; humanized for display. **R is NOT permitted** —
it is a duration.

**Unavailable reasons.** 1, 3 (either trade estimated — a fabricated
`opened_at` makes the gap fiction), 4, 13, 14.

### 5.6 Sizing variance

**Plain language.** How consistent the user's position sizing is across a
cohort of trades, and which individual trades were outliers against their own
median. It informs "you size up after a win / on tilt" — stated as counts and
ratios, never as an effect on outcome.

**Two modes**, mirroring the coverage-aware pattern already used by
`compute_rr` (`backend/app/review/analytics.py:113`):

```
mode = "risk_based"      when every member of the cohort has SL non-null and risk > 0
        x_i = |E_i - SL_i| * Q_i          # quote currency actually at risk
mode = "notional_based"  otherwise
        x_i = E_i * Q_i                   # position notional
```

Both modes are reported with their mode label attached. A `risk_based` figure
may never be shown without its label, and a `notional_based` figure may never be
called "risk".

**Statistics.** Over the cohort `x_1 … x_N`:

```
mean          mu     = (1/N) * sum(x_i)
population sd sigma  = sqrt( (1/N) * sum((x_i - mu)^2) )
CV                   = sigma / mu                       # unitless
CV_percent           = CV * 100
median               = the usual order statistic (mean of the two middle values when N is even)
Q1, Q3               = Tukey hinges: median of the lower / upper half,
                       EXCLUDING the overall median when N is odd
IQR                  = Q3 - Q1
size_ratio_i         = x_i / median                     # the per-trade forensic
```

**Population σ (divide by N), not the sample σ (N−1).** This is a complete
enumeration of the trades the user actually took in the window; we are
describing that set, not estimating a parameter of a hypothetical population
from which it was drawn. Using N−1 would imply an inferential claim the
product does not make (rule R2). The choice is stated here so R4-T3's fixtures
and any future reviewer agree.

`size_ratio_i` is the number that goes on a trade row: *"this position was
2.5× your median size"* — plain, robust to one huge outlier, and free of
distributional assumptions. The z-score alternative was rejected for implying
normality.

**Leverage is not available.** `BinanceTrade.leverage` is always
`DEFAULT_LEVERAGE = 1.0`; Binance's read-only history endpoints expose no
historical leverage and the constant is never enriched away (documented at
`backend/app/binance_review/constants.py:34`). Therefore sizing variance
measures **notional or risk, never margin committed**. Every render must say
"notional" or "risk", never "size of your account you put up". Any future
margin-based sizing metric requires the leverage gap to be closed first, and a
version bump.

**Cohort definition.** Default cohort = all of the user's enriched trades in
the requested window, across symbols (notional is comparable in USDT). An
optional per-symbol cut uses the identical formulas. The cohort is always
reported with its `N`.

**Units.** `x_i` in `quote_currency`; `CV_percent` in `ratio_percent`;
`size_ratio_i` as `unitless`. **R is NOT permitted** for the dispersion
statistics — a CV is not an R-multiple. The `risk_based` mode's `x_i` is
denominated in quote currency and, being derived from an evidenced stop, may
additionally be expressed as "risk per trade in account-currency terms"; it is
still not an R value.

**Unavailable reasons.** 15 (`N < 5`), 16. Individual `not_enriched` rows are
excluded from the cohort before `N` is counted, and the exclusion count is
reported alongside `N`.

---

## 6. Worked examples — the R4-T3 fixture seeds

Every number below was computed by hand and cross-checked. R4-T3 must
reproduce them exactly. All times UTC; all candles 1m; the trade rows are
`BinanceTrade`-shaped.

### Example A — LONG, the happy path

Trade: `side=LONG, entry_price=100.00, exit_price=106.00, quantity=2.0,
stop_loss=96.00, opened_at=12:00:00, closed_at=12:05:00,
open_time_source=user_trades, close_trigger=manual_market`

| open_time | O | H | L | C |
|---|---|---|---|---|
| 12:00 | 100.0 | 101.0 | 98.5 | 99.0 |
| 12:01 | 99.0 | 100.5 | **97.0** | 100.2 |
| 12:02 | 100.2 | 104.0 | 100.0 | 103.5 |
| 12:03 | 103.5 | **108.0** | 103.0 | 107.0 |
| 12:04 | 107.0 | 107.5 | 105.5 | 106.2 |

Window: `first = floor(12:00:00) = 12:00`; `last = floor(12:05:00 − 1ms) =
12:04`. Five candles ≥ 3. ✔

```
Hmax = 108.0   Lmin = 97.0   risk = |100 - 96| = 4.00

MAE_price = 100 - 97  = 3.00        MAE_pct = 3.00 %     MAE_r = 3.00/4.00 = 0.75 R
MFE_price = 108 - 100 = 8.00        MFE_pct = 8.00 %     MFE_r = 8.00/4.00 = 2.00 R
realized_move = 106 - 100 = 6.00    return  = 6.00 %     realized_r = 1.50 R
exit_efficiency = 6.00 / 8.00 = 75.0 %
boundary_inflation_bound_pct = max(101.0-98.5, 107.5-105.5)/100 * 100 = 2.50 %
```

Consistency check: `MAE_r = 0.75 < 1`, and indeed `Lmin = 97.0 > SL = 96.0` —
the stop was never touched, as the trade's manual close implies.

### Example B — SHORT, the sign-flip fixture

Trade: `side=SHORT, entry_price=50.00, exit_price=47.50, quantity=10.0,
stop_loss=52.00, opened_at=08:00:00, closed_at=08:03:00,
open_time_source=user_trades, close_trigger=manual_limit`

| open_time | O | H | L | C |
|---|---|---|---|---|
| 08:00 | 50.0 | **51.2** | 49.6 | 49.8 |
| 08:01 | 49.8 | 50.4 | 46.9 | 47.2 |
| 08:02 | 47.2 | 48.0 | **46.0** | 47.6 |

Window: 08:00 … `floor(08:03:00 − 1ms) = 08:02`. Three candles. ✔

```
Hmax = 51.2   Lmin = 46.0   risk = |50 - 52| = 2.00

MAE_price = 51.2 - 50 = 1.20        MAE_pct = 2.40 %     MAE_r = 1.20/2.00 = 0.60 R
MFE_price = 50 - 46.0 = 4.00        MFE_pct = 8.00 %     MFE_r = 4.00/2.00 = 2.00 R
realized_move = 50 - 47.50 = 2.50   return  = 5.00 %     realized_r = 1.25 R
exit_efficiency = 2.50 / 4.00 = 62.5 %
```

An implementation that swapped the long/short branches would report
`MAE_price = 4.00` and `MFE_price = 1.20` here — the fixture's asymmetry
(2.40 % vs 8.00 %) makes the swap impossible to miss.

### Example C — MAE = 0 legitimately, and no stop on record

Trade: `side=LONG, entry_price=10.00, exit_price=10.40, quantity=100.0,
stop_loss=NULL, opened_at=01:00:00, closed_at=01:03:00,
open_time_source=user_trades, close_trigger=manual_market`

| open_time | O | H | L | C |
|---|---|---|---|---|
| 01:00 | 10.00 | 10.15 | **10.00** | 10.10 |
| 01:01 | 10.10 | **10.50** | 10.05 | 10.42 |
| 01:02 | 10.42 | 10.45 | 10.30 | 10.40 |

```
Hmax = 10.50   Lmin = 10.00   risk = undefined (SL is NULL)

MAE_price = max(0, 10.00 - 10.00) = 0.00   MAE_pct = 0.00 %
  -> available: true, value: 0.0, flags: ["adverse_excursion_none"]
MFE_price = 10.50 - 10.00 = 0.50           MFE_pct = 5.00 %
realized_move = 0.40                       return  = 4.00 %
exit_efficiency = 0.40 / 0.50 = 80.0 %

MAE_r, MFE_r, realized_r -> available: false, reason: "no_stop_on_record"
```

This row is the R1 regression test: the trade renders percent and MAE/MFE and
**no R value anywhere**. R4's DoD requires a test that fails if any R appears
on a row like this.

### Example D — exit beyond the stop, and the negligible-MFE guard

Trade: `side=LONG, entry_price=200.00, exit_price=193.50, quantity=1.0,
stop_loss=195.00, opened_at=22:00:00, closed_at=22:02:20,
open_time_source=user_trades, close_trigger=sl_hit, sl_slippage=-1.50`

| open_time | O | H | L | C |
|---|---|---|---|---|
| 22:00 | 200.00 | **200.10** | 198.00 | 198.60 |
| 22:01 | 198.60 | 199.00 | 196.20 | 196.40 |
| 22:02 | 196.40 | 196.50 | **193.20** | 193.50 |

Window: 22:00 … `floor(22:02:20 − 1ms) = 22:02`. Three candles. ✔

```
Hmax = 200.10   Lmin = 193.20   risk = |200 - 195| = 5.00

MAE_price = 200.00 - 193.20 = 6.80    MAE_pct = 3.40 %    MAE_r = 1.36 R
MFE_price = 200.10 - 200.00 = 0.10    MFE_pct = 0.05 %    MFE_r = 0.02 R

exit_efficiency: MFE_pct 0.05 < 0.10  ->  available: false,
                 reason: "negligible_favorable_excursion"
   (unguarded it would print -6.50 / 0.10 = -6500 %, an artifact of the
    denominator, not a fact about the exit)

stop discipline (stop_evidence = "hit"):
  slippage_adverse     = SL - X = 195.00 - 193.50 = 1.50   ( = -sl_slippage ✔ )
  slippage_adverse_pct = 1.50 / 200.00 * 100 = 0.75 %
  slippage_adverse_r   = 1.50 / 5.00 = 0.30 R
  violation_depth_r    = max(0, 195.00 - 193.20) / 5.00 = 1.80 / 5.00 = 0.36 R
  realized_move        = 193.50 - 200.00 = -6.50           return = -3.25 %
  realized_r           = -6.50 / 5.00 = -1.30 R

Invariant: realized_r = -(1 + slippage_adverse_r) = -(1 + 0.30) = -1.30 ✔
```

Variant branch for the fixture set: raise the 22:00 high to `200.40`
(`MFE_pct = 0.20 % ≥ 0.10 %`) and exit efficiency becomes **available** at
`-6.50 / 0.40 = -1625.0 %`. Ugly and reported unclamped — that is the intended
behavior above the threshold.

### Example E — re-entry latency

User `U`, symbol `SOLUSDT`, all rows `open_time_source = user_trades`:

| # | side | opened_at | closed_at | realized_pnl |
|---|---|---|---|---|
| T1 | LONG | 09:00:00 | 09:12:00 | −18.40 |
| T2 | LONG | 09:15:30 | 09:41:00 | +22.10 |
| T3 | SHORT | 09:41:00 | 10:05:00 | −5.00 |

```
T1: prev = none in window  -> available: false, reason: "no_prior_trade_in_window"
T2: prev = T1              -> 09:15:30 - 09:12:00 = 210 s
                              same_direction = true, after_loss = true
T3: prev = T2              -> 09:41:00 - 09:41:00 = 0 s
                              available: true, value 0.0,
                              flags: ["immediate_reversal"]
                              same_direction = false, after_loss = false
```

A fourth row `T4 LONG opened 10:00:00, closed 10:20:00` would take `prev = T2`
(the latest `closed_at ≤ 10:00:00` is T2's 09:41:00 — T3 closed at 10:05:00,
*after* T4 opened) and would therefore report `overlapping_positions` rather
than a latency, because T3's life strictly contains T4's open.

### Example F — sizing variance (notional mode)

Cohort of five enriched trades, none with a stop on record → `mode =
notional_based`, `x_i = E_i × Q_i`:

| # | E | Q | x_i |
|---|---|---|---|
| 1 | 100.00 | 2.0 | 200.00 |
| 2 | 50.00 | 10.0 | 500.00 |
| 3 | 10.00 | 22.0 | 220.00 |
| 4 | 200.00 | 1.0 | 200.00 |
| 5 | 25.00 | 8.0 | 200.00 |

```
N = 5    sum = 1320.00    mu = 264.00
deviations: -64, +236, -44, -64, -64
squares:    4096, 55696, 1936, 4096, 4096   sum = 69920
population variance = 69920 / 5 = 13984      sigma = sqrt(13984) = 118.254...
CV = 118.254 / 264.00 = 0.4479               CV_percent = 44.79 %

sorted: 200, 200, 200, 220, 500
median = 200.00
Tukey hinges (N odd, overall median excluded from both halves):
  lower half = [200, 200] -> Q1 = 200.00
  upper half = [220, 500] -> Q3 = 360.00
  IQR = 160.00

size_ratio:  T1 1.00   T2 2.50   T3 1.10   T4 1.00   T5 1.00
```

Rendered statement (the only permitted framing): *"5 trades. Median notional
200 USDT. One position at 2.5× your median."* Not permitted: any sentence
linking the 2.5× outlier to its outcome as an effect.

With `N = 4` the same cohort reports `available: false, reason:
"insufficient_sample"`.

### Example G — stamp-at-open context (see §8)

Position observed open in `ARBUSDT` at `stamped_at = 2026-07-20T10:00:00Z`.
Latest `eval_log` row for `(ARB, perp, intraday)` has `evaluated_at =
2026-07-20T09:55:00Z` (300 s stale, inside the 900 s bound), `verdict =
"caution"`, `regime = "high-volatility"`, `confidence = 41.0`.

One catalyst is in scope: a DeFiLlama unlock for ARB, `percent_of_supply =
0.018`, `occurs_at = 2026-07-21T16:00:00Z` → `hours_from_now = +30.0`, source
`defillama`. Running `score_event` (`backend/app/events/impact.py:338`):

```
magnitude          = clamp01(0.018 / 0.03) = 0.60   -> 50 * 0.60      = 30.00
proximity          = (168 - 30) / (168 - 24)
                   = 138 / 144 = 0.958333           -> 30 * 0.958333  = 28.75
source_confidence  = 0.90 (defillama)               -> 20 * 0.90      = 18.00
                                                       score          = 76.75
76.75 >= HIGH_THRESHOLD (75.0)  ->  impact = "high", direction = "bearish",
                                    capped = false, impact_version = "1.0.0"
```

The stamped row stores `76.75` and `"high"` **as computed at 10:00:00Z**. Two
days later the same event scores lower (proximity decays after it passes); the
stamp is not recomputed. That is the point of a stamp.

Session: `stamped_at.hour == 10` UTC → engine `SESSION_WINDOWS`
(`engine/smc/sessions.py:31`) puts 08:00–13:00 in `eu` → `session = "eu"`.

---

## 7. Edge cases

### 7.1 Zero-range candles

`high == low` (a frozen or ultra-illiquid minute) is legal and contributes
normally — no formula in §5 divides by a candle's range, so no guard is
needed. The degenerate extreme, every candle in the window with
`high == low == E`, yields `MAE = 0` and `MFE = 0`; MAE and MFE are available
at zero (flagged `adverse_excursion_none`) and exit efficiency is unavailable
with `negligible_favorable_excursion`.

### 7.2 Exit beyond the stop (slippage)

Fully specified in §5.4 and demonstrated in Example D. Two properties worth
restating: adverse slippage is **side-normalized here** because the stored
`sl_slippage` column is not; and negative adverse slippage (a *better* fill
than the trigger) is reported as a negative number, never floored to zero.

A related boundary case: an exit fill printing outside `[Lmin, Hmax]`. This can
happen at a window edge, on a liquidation, or on an off-book fill. Exit
efficiency clamps to 100 % with the `exit_outside_kline_range` flag; MAE and
MFE are *not* adjusted to include the exit price, because they are defined over
the kline series, and quietly widening them with a fill price would mix two
measurement sources under one number.

### 7.3 A trade that never moved against the entry

`MAE = 0` is **available**, value `0.0`, flag `adverse_excursion_none` — see
Example C. This is the sharpest place where rule R3 bites: `0` here means
"measured, and the answer is none", whereas `unavailable` means "we do not
know". Collapsing the two would make every unmeasurable trade look like a
perfectly-timed entry. The UI must render them differently (R4-T6): "never
traded against you" versus "no excursion data — estimated open time".

### 7.4 Scale-in (pyramiding into a position)

**Partially representable, lossily.** `resolve_real_open_time`
(`backend/app/binance_review/enrichment.py:71`) walks opening fills
newest-to-oldest until they cover the closed size and returns their
**quantity-weighted average price** plus the **earliest** contributing fill's
timestamp. So a scale-in is collapsed into one synthetic entry: MAE/MFE
measured from that average entry over a window starting at the first tranche
are defensible, but per-tranche excursions are lost and the average entry was
never a price at which the whole position existed.

**It is not detectable from the row** — no fill count is persisted. Therefore
scale-in produces **no unavailable state**; it produces a permanent disclosure:
every enriched row carries the flag `entry_basis_weighted_average`, and the
render must not claim the entry was a single fill. R4-T4 should persist
`entry_fill_count` (available for free in `_enrich_trades`, currently
discarded) so a future version can distinguish the cases; that is finding F4.

### 7.5 Scale-out (partial closes) — **not representable**

The sync writes **one `BinanceTrade` row per `REALIZED_PNL` income event**
(`_upsert_trade_from_income`, `backend/app/binance_review/service.py`). A
position closed in three tranches therefore becomes **three rows**, and there is
no grouping key linking them. Worse, `resolve_real_open_time` is called
independently per fragment against the same opening fills with no notion of
consumption, so equal-sized fragments receive the **identical** `entry_price`
and `opened_at`.

Consequences if left unhandled: the position is counted three times in trade
counts and sizing cohorts; its MAE is triple-counted; re-entry latency between
fragments is 0 or negative; and "the trade's" exit efficiency is not a
well-defined quantity at all (each fragment's own efficiency is real, the
position's is not).

**Detection heuristic** (and it is a heuristic — say so at every render):
two or more rows for the same `(user_id, symbol, side)` whose
`[opened_at, closed_at]` intervals overlap **and** whose `entry_price` values
agree to within `1e-9` relative **and** whose `opened_at` values are equal.
Group them and mark every member `partial_close_suspected`.

**Rule:** for every member of a suspected group, MAE, MFE, exit efficiency and
re-entry latency return `available: false, reason: "undefined_for_partial_close"`.
Sizing variance **keeps** them (each fragment's notional is real money that was
really deployed), but the cohort report states how many rows belong to
suspected groups.

The correct fix is a persisted `position_group_id` assigned at sync time by
matching each closing fill's opening fills via `raw_income.tradeId` and
`/fapi/v1/userTrades` (the data is already fetched and then thrown away). That
is finding F3 and a candidate for R4-T4; until it exists, the heuristic and the
unavailable state are the honest position.

### 7.6 Liquidation

`close_trigger == "liquidation"` sets `discipline_breach = true` (§5.4). MAE
and MFE are still computed — the excursion is a fact — but the exit price on a
liquidation is the exchange's, not the user's, and exit efficiency is
consequently a statement about the liquidation engine, not the user's exit. It
is still reported (it is arithmetically valid), with the
`exit_outside_kline_range` flag likely set. No special unavailable state.

### 7.7 Very short trades

Held under 3 minutes → fewer than three 1m candles → `resolution_too_coarse`.
This is a real coverage hole for sub-3-minute scalps and it is reported as one,
not papered over by falling back to a coarser interval (which would be strictly
worse). The count of trades excluded for this reason is reported alongside every
distribution so the reader sees the hole.

---

## 8. Stamp-at-open context record

This is a separate record from the forensics row, written by a different
mechanism, under a rule that has no exceptions.

### 8.1 The rule

> **Context is captured while the position is open, from the read models as
> they read at that instant, and is never backfilled, never recomputed, and
> never reconstructed from historical rows.** A trade opened before the
> stamper existed, or opened while the stamper was down, has `context = null`
> forever.

Reading the *current* value of a live read model at stamp time is capture.
Querying `eval_log` after the fact for `evaluated_at ≈ opened_at` is
**reconstruction** and is forbidden — even though the row exists and the query
is trivial. The distinction is the whole point: a stamp is evidence that the
system said this thing at that moment; a reconstruction is a claim about the
past assembled later, which is one short step from replay (EDR 0011's
record-semantics boundary; EDR 0022 decision 3).

Enforcement required of R4-T5:

- `stamped_at` is `NOT NULL`, `timestamptz`, written from the observing
  process's own clock.
- A test asserting `stamped_at ∈ [first_seen_at, first_seen_at + tick_period]`.
- The table is **append-only**: no `UPDATE` of any context field after insert.
  A correction is a new row carrying `supersedes_id`.
- No code path may construct a context row from a `BinanceTrade` row.

### 8.2 When it is captured, and by what

`binance_review` syncs **closed** trades only, so nothing in the current
pipeline observes an open position. The stamper is new work (R4-T5):

- **Trigger:** the existing arq 5-minute tick (`forward_test_tick`,
  `backend/app/worker/config.py`) gains a stamper pass, or the pass is
  registered as its own 5-minute cron. Not the hourly review-sync tick — a
  60-minute observation lag would make the stamp useless for scalps.
- **Observation:** for each user with an active `BinanceReviewKey`, call
  `BinanceExecClient.get_positions()` (`GET /fapi/v2/positionRisk`,
  `backend/app/execution/binance_client.py:75`) — the same call
  `account_service.get_account_state` already makes — and take every position
  with `positionAmt != 0`.
- **Episode identity:** `(user_id, symbol, sign(positionAmt), first_seen_at)`.
  One context row per episode, written on first observation only.
- **Precision disclosure:** the row stores
  `observation_lag_bound_seconds = 300`. The stamp is "within 5 minutes of the
  open", never "at the open", and must be labeled that way.

For IQ-placed trades a second, exact trigger exists and should be preferred
when available: `ExecutionRecord` transitions to a filled entry
(`backend/app/execution/models.py:146`), which is a server-side event with a
known instant and a known `stop_price`. Both triggers write the same table;
the row records which one fired via `observation_source ∈ {"position_poll",
"execution_record"}`.

### 8.3 Fields

| Field | Source | Rule |
|---|---|---|
| `stamped_at` | observing process clock, UTC | `NOT NULL`; the honesty anchor |
| `observation_source` | `"position_poll"` \| `"execution_record"` | — |
| `observation_lag_bound_seconds` | tick period (300) or 0 for `execution_record` | precision disclosure |
| `user_id`, `symbol`, `side` | the observed position | `symbol` stored as the exchange symbol, matching `BinanceTrade.symbol` |
| `regime` | `eval_log.regime` for the latest row matching `(bare_ticker(symbol), market='perp')` | one of the `MarketRegime` literals from `classify_regime` (`engine/smc/quant.py:357`): `trending-up`, `trending-down`, `high-volatility`, `breakout-compression`, `low-volatility`, `range-bound`, `choppy`, `mean-reversion`. Null if stale (below). |
| `verdicts_at_open` | `eval_log` rows for that symbol at the same `evaluated_at`, one per `intent` | JSONB array of `{intent, verdict, direction, setup_type, timeframe, confidence, no_trade_reasons}`. All intents, not just the favorable one — "the engine said no-trade on all three" is the answerable question. |
| `eval_log_id`, `eval_evaluated_at` | the same rows | provenance pointer |
| `eval_staleness_seconds` | `stamped_at − eval_evaluated_at` | **If > 900 s (3 worker ticks), `regime` and `verdicts_at_open` are stored as `null` with `verdict_source = "stale"`.** A stale engine read is never presented as the read at open. |
| `engine_version`, `config_hash`, `git_sha` | the same `eval_log` rows | segments every later cut, exactly as forward-test stats do |
| `session` | computed from `stamped_at` in UTC using `SESSION_WINDOWS` (`engine/smc/sessions.py:31`) | `asia` (00–08) \| `eu` (08–13) \| `us` (13–21) \| `off_hours` (21–24). See the collision note below. |
| `catalysts` | `events.service.list_upcoming_catalysts(db, symbol, until=stamped_at + 7d)`, `list_token_events(db, symbol)` filtered to `published_at >= stamped_at − 48h`, `list_economic_events(db, until=stamped_at + 24h, min_impact="high")` | JSONB array; per event store `{id, category, kind, title, occurs_at_or_published_at, source}` **plus the serialized impact fields** |
| `catalyst_impact` (per event) | `events.impact.score_event` via `events.schemas.impact_fields` | store `impact`, `direction`, `impact_score`, `impact_capped`, `impact_version` **as computed at `stamped_at`** |
| `catalyst_top` | max `impact_score` among the stored events, with its `direction` | convenience denormalization; must agree with the array |
| `forensics_version`, `impact_score_version` | constants | version stamps |

**Why impact is stored, not referenced.** `score_event` is a pure function of
event facts *and proximity* — `hours_from_now` is 30 % of the composite
(`WEIGHT_PROXIMITY`). Re-scoring the same event tomorrow returns a different
number. A reference would silently mutate the historical context; the stored
value is the only honest option. Note also that
`list_upcoming_catalysts`/`list_economic_events` filter on SQL `now()`, which is
correct for a live stamper and would be wrong for any backfill — a second
structural reason backfill is forbidden.

**Session-grid collision (name it, do not silently pick).** Two different
session grids exist in this codebase: the engine's
`SESSION_WINDOWS` (asia 0–8, eu 8–13, us 13–21, with 21–24 deliberately
excluded as the post-US lull) and `app/review/constants.py`'s
`SESSION_ASIA/LONDON/NEW_YORK` (0–8, 8–16, 16–24, exhaustive). **The stamp uses
the engine grid**, because the stamp's job is to record the market context the
engine plane saw, and `off_hours` is a real and useful category. The review
analytics keep their own grid for now; reconciling them is a separate change
(finding F6). Any UI showing both must not imply they are the same field.

**Symbol translation.** `eval_log.symbol` holds bare tickers (`BTC`, `ARB`) from
`WORKER_UNIVERSE`; the position and trade rows hold exchange symbols
(`BTCUSDT`, `1000PEPEUSDT`). The stamper needs the inverse of
`resolve_exchange_symbol` — strip the `USDT` quote suffix and reverse the
`_FUTURES_BASE_OVERRIDES` 1000×/1000000× renames
(`backend/app/worker/binance.py:38`). A symbol outside `WORKER_UNIVERSE`
(the user traded something the engine does not evaluate) yields
`regime = null, verdicts_at_open = null, verdict_source = "not_in_universe"` —
an explicit state, not an empty object.

### 8.4 Joining a context row to a trade row

There is no key. The join is `(user_id, symbol, side)` plus interval overlap
between the episode's `[first_seen_at, last_seen_at]` and the trade's
`[opened_at, closed_at]` — and it is only sound after the §4.3 timezone
normalization, because the two tables' timestamps are currently on different
clocks in the same database.

The join must be materialized once, at forensics-compute time, into a nullable
`binance_trades.context_id` (or a side table) rather than recomputed per read.
Ambiguous matches (two candidate episodes) resolve to **null**, not to a
best guess. This is finding F5.

---

## 9. Findings — where the current data model cannot support what was asked

These are stated as facts about the model, not as blockers. Each names the
precise gap and the smallest change that would close it.

**F1 — `stop_loss` is only recorded when the stop was HIT, so "stop
discipline" as a behavior cannot be measured.** `classify_and_enrich`
(`enrichment.py:141`) sets `stop_loss` from the closing order's `stopPrice`
only for `STOP`/`STOP_MARKET` closes. A stop that was placed and never hit —
the majority of stops on winning trades — leaves the column NULL and is
indistinguishable from no stop at all, from a widened stop, and from a
cancelled stop. Consequences: (a) §5.4 is narrowed to stop-hit quality; (b) R1
coverage is structurally biased toward *losing* trades, so any R distribution
built from `stop_loss`-evidenced rows is a distribution over stop-outs and must
be labeled as such — this is a live risk for `compute_rr`
(`analytics.py:113`), which already averages R over exactly this biased subset;
(c) the "you move your stop" habit is not implementable in R4. Closing it
requires syncing open/cancelled protective orders (`/fapi/v1/allOrders` already
returns them; the sync currently keeps only the order that produced the closing
fill) — a sync-scope change, not a schema change.

**F2 — no join between `execution_records` and `binance_trades`.**
`ExecutionRecord` carries the genuinely-evidenced intended stop
(`stop_price`, with a real `sl_order_id`) for IQ-placed trades, which would
close much of F1 for that subset. But `BinanceTrade` persists no order id — the
closing fill's `orderId` is read transiently in `_enrich_trades` and discarded
— so there is nothing to join on. Smallest fix: persist `close_order_id` (and
ideally `entry_order_id`) on `BinanceTrade` at sync time, then match. Adopting
an execution-record stop as R-evidence is additionally a **definitions version
bump**, because R1 as frozen here gates R on `stop_loss` on the trade row.

**F3 — scale-out is not representable; one position becomes N rows with no
grouping key.** Detailed in §7.5. The heuristic detector plus
`undefined_for_partial_close` is the 1.0.0 answer. The fix is a persisted
`position_group_id`.

**F4 — scale-in is invisible.** The weighted-average entry is computed and the
fill count discarded, so a 1-fill entry and a 6-fill pyramid are
indistinguishable on the row. Fix: persist `entry_fill_count` in
`_enrich_trades`.

**F5 — `binance_trades.opened_at` / `closed_at` are naive local (UTC+8)
timestamps in a database whose other planes use `timestamptz`.** Written by
`datetime.fromtimestamp(ms/1000)` on a UTC+8 host; declared
`TIMESTAMP WITHOUT TIME ZONE` in migration `f1a2b3c4d5e6`. Every kline window,
every context join, and every hour-of-day bucket is exposed to an 8-hour error.
§4.3 specifies the mandatory conversion helper as the R4 mitigation; the real
fix is a `timestamptz` migration with a backfill, which is owner-applied work
outside R4-T1.

**F6 — hour-of-day and session analytics are currently computed on those naive
UTC+8 timestamps as if they were UTC.** `compute_hour_range` returns fields
named `start_hour_utc`/`end_hour_utc` (`analytics.py:57`) from
`t.opened_at.hour` (`analytics.py:168`), and `_session_for_hour`
(`analytics.py:260`) buckets the same value (`analytics.py:271`). On this host those are UTC+8 hours. Independently, that
function's grid (0–8 / 8–16 / 16–24) differs from the engine's
`SESSION_WINDOWS` (0–8 / 8–13 / 13–21 + gap). Both belong to R4-T2's audit;
the stamp record sidesteps them by computing `session` from its own UTC
`stamped_at` (§8.3).

**F7 — `open_time_source` values do not match what the style analytic tests
for.** The Binance path writes `"user_trades"`
(`binance_review/constants.py:18`); `compute_style_suitability`
(`analytics.py:309`) filters for `"order_history"`, the *Bybit* constant. Every
Binance row therefore falls into the `estimated_fallback` branch, so
style-suitability silently reports the lower data-quality tier for all users.
Not a forensics metric, but it is in the same read path and R4-T2 should
confirm it.

**F8 — leverage is never on record, so margin-based sizing is undefined.**
`DEFAULT_LEVERAGE = 1.0` is never enriched away
(`binance_review/constants.py:34`); Binance exposes no historical-leverage
endpoint. Sizing variance is therefore notional/risk only (§5.6), and
`roi_percent` on the row understates ROI for leveraged positions — already
documented in that constant's comment, restated here because §5.6 depends on it.

**F9 — `fetch_klines` cannot request 1m or 5m.** `BINANCE_INTERVALS`
(`worker/binance.py:22`) is keyed by `TokenTimeframe`, whose finest member is
`15M`. The §4.1 ladder requires a raw-interval sibling in the same backend
module. This is a backend-only change — `TokenTimeframe` lives in
`engine/smc/mock_candles.py` and must **not** be extended, because that would
be an engine-surface change for a review-plane need.

**F10 — no open-position observation exists today.** Nothing in the current
worker sees a position while it is open; `binance_review` syncs realized-PnL
events after the fact. The stamp-at-open record is therefore net-new
observation infrastructure (§8.2), and — by the never-backfill rule — every
trade closed before it ships permanently has `context = null`. That is the
intended, honest outcome, not a gap to be filled later.
