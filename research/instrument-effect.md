# The instrument effect

*opened 2026-08-15 · status: collecting · no decision pending*

## The question

The forward test's stated purpose is to tell us which setups to take and which
to skip. Before that question can be answered at all, a prior one has to be
settled: **does the edge belong to the pattern, or to the symbols the pattern
happened to find?**

Nothing in the record could distinguish those two until now, and the first
week's numbers are exactly what an instrument effect looks like.

## What the first 264 settled setups showed

At `discover-forward-test/1.2.0`, engine `2.0.0`, all settled inside four days
(2026-08-12 .. 08-15) in a single bearish/choppy tape:

| book | n | gross | net |
|---|---|---|---|
| all settled (pooled, 3 strategy versions) | 264 | +0.089R | -0.152R |
| 1.2.0 only | 130 | +0.085R | -0.101R |
| 1.2.0 **ex-top-5 symbols** | 114 | **-0.036R** | **-0.224R** |

On 1.2.0 the top five symbols contribute **+15.1R against a total of +11.0R**
— 137%, because the rest of the book is net negative. **Half the gross R comes
from a single symbol.** One vote per symbol rather than per trade: mean
+0.100R, **median -0.108R**. Fifty-nine symbols, and the median one loses.

The best-looking subset has the same disease one level down.
`displacement+participation` (n=28, gross +0.665R, net +0.468R) is the only
positive-net cut anywhere in the record — and across the full 264 rows that
combo drew **101% of its own +23.6R from six symbols holding eight trades
between them** (ENSO, BR, IRYS, GPS, H, BMT — five of them single trades).

This is not evidence that displacement is worthless. It is evidence that the
record cannot currently tell the difference between "displacement works" and
"displacement kept finding the week's six biggest movers".

## Why more of the same sample will not settle it

Adding forward-test rows adds *pattern* observations. The competing explanation
is about *instruments*, and there is nothing on a row that describes the
instrument — so no amount of n resolves it. The record had no column for the
question.

It also cannot be answered by slicing harder. 264 rows, one regime, four days,
and roughly fifteen candidate dimensions: cut that enough ways and something
always separates. The score-quintile shape already shows it (Q4 +0.383R, Q5
+0.009R — non-monotone, which is what noise looks like when you rank it).

## What now gets recorded

`SetupSnapshot` freezes five instrument facts at detection alongside everything
else on the row (`engine/smc/forward_test.py`, written into `evidence` by
`app/research/recorder.py`):

| field | source | why |
|---|---|---|
| `quote_volume_24h` | ticker frame | liquidity — the most direct candidate for "this symbol is untradeable" |
| `change_24h_pct` | ticker frame | was it already extended when we found it |
| `trades_1m` | ticker frame | thin-book proxy |
| `volatility_1m_pct` | rolling state | the symbol's own noise band |
| `listing_age_days` | `app/research/symbol_facts.py` | a perp listed last week does not trade like one listed two years ago |

Plus one derived property, `stop_noise_ratio` — the stop as a multiple of the
symbol's own 1m noise band. Below 1x, the "invalidation" sits inside the range
the symbol prints every minute, which makes it a coin flip rather than a
structural level. This is the cheapest available explanation for a book paying
0.21R of cost against a 0.09R gross edge.

Four ride the all-market ticker frame the windows already come from and cost
nothing. `listing_age_days` is a dict lookup into an onboard-date map refreshed
on its own 6h timer — the recorder still fetches nothing at detection, so no
lookahead is introduced.

### Two rules this collection is bound by

- **Rows written before 2026-08-15 carry none of it and are never
  back-filled.** Reconstructing an instrument fact from today's ticker would
  stamp a later instant's value onto an earlier detection — the exact lookahead
  the whole plane is built to prevent. Old rows read `unknown`, which is a
  different claim from zero.
- **A missing fact is never a good fact.** `listing_age_days` is `None` when the
  map has no entry, and the report counts it as `unknown` rather than putting it
  in the first bucket.

## Reading it

`python -m app.research.instrument_report [--strategy-version …] [--out …]`

It reports concentration first and every cut afterwards, because a subset that
looks good and a subset that contains LSK are otherwise hard to tell apart. It
emits **no verdicts** — every cut in it was chosen after seeing the data, none
is corrected for the number of cuts, and a `•` marks only that a bucket's own
interval excludes zero. Buckets under n=10, or with no spread at all, are never
marked; three stops that all resolved at exactly -1.000R are not certainty.

Not wired into the weekly cron yet: with coverage at 0/130 it would send four
empty sections a week. Wire it once coverage passes roughly half the settled
record.

## What would close this

A cut here is a **hypothesis, not a filter**. The path to acting on one is the
standing protocol (`research/arms-protocol.md`):

1. coverage accumulates — at ~65 settled/day, a usable instrument sample is
   two to three weeks out;
2. the surviving candidate is written up as a `detect` arm in
   `engine/smc/arms.py` with a gate registered **before** it is evaluated;
3. it settles on rows collected after registration;
4. a PASS opens an EDR. It does not make the decision.

`MAX_ARMS_PER_AXIS` is 2 and the `detect` axis is currently full
(`displacement_only`, `htf_aligned`). An instrument arm therefore costs a slot,
which is a decision for the owner and not something a report can take.

## The entry leg is charged for a crossing it never makes

Found while reviewing the same record, and larger than any filter yet
demonstrated.

`ForwardTestConfig.round_trip_cost_pct` is `2 * (taker_fee_pct +
slippage_pct)` — both legs priced as though they crossed the spread. But the
entry is a **resting order in the entry zone**: `advance_position` fills it when
price trades into the zone, and settles the record `NO_FILL` when price never
arrives. An order that waits to be hit is a maker, and it pays no adverse
slippage, because there is no crossing to be adverse to.

This is the same class of error `smc.forward_test` already documents at length
about exits: *"Charging it a second time through the observation price is not
conservatism, it is a bias."* The entry leg is charging it a first time for
something that does not happen.

Re-derived over the 244 settled rows carrying a cost (entry maker; exit maker
on a target's limit, taker on a stop, trail or timeout):

| assumption | mean cost | mean net |
|---|---|---|
| taker both legs (live) | 0.209R | -0.102R |
| **maker entry, real exit** | **0.146R** | **-0.039R** |
| maker both legs (unreachable — no stop is a maker fill) | 0.090R | +0.017R |

**0.063R/trade**, against a gross edge of +0.107R. It does not turn the book
positive, and net remains indistinguishable from zero (t=-0.25 on the wider
244-row cut) — but it means roughly a third of the reported deficit is a
pricing artifact rather than the strategy.

Shipped as a **scenario only**, in `app/research/arms_report.py`. Changing what
the recorder writes would move `realized_r` on every future row and restart the
net-R clock — a `DETECTOR_GENERATION` bump, which is a decision and not a
report's to take. The flat "maker" row is retained but relabelled *unreachable*,
because it prices every stop-out as a resting order and no stop is one.

**Open for the owner:** whether to bump to generation 6 and price the entry leg
correctly at the source. Against: it restarts net-R comparability at exactly the
moment the arms need sample. For: every week not fixed adds rows whose net R is
known to be wrong by a measurable amount, and the arms are gated on **gross** R
anyway — which this does not touch.

## One thing to check while collecting

`htf_aligned` was registered 2026-08-14 on the hypothesis that HTF agreement
outperforms. The full-population cut says the opposite:

| cut | n | gross |
|---|---|---|
| `alignment = aligned` | 54 | **-0.158R** |
| `alignment = counter_trend` | 74 | +0.141R |
| `alignment = mixed` | 135 | +0.167R |
| `htf_agreement >= 0.6` | 116 | +0.017R |
| `htf_agreement 0.3–0.6` | 90 | +0.326R |

The arm's own paired number (+0.321R) is at n=7. That gate is 600 pairs wide
and holds one of two `detect` slots; worth re-reading the registration before
it absorbs them.

## Related

- `research/arms-protocol.md` — how anything here becomes real
- `research/weekly/` — the deterministic arms report
- `docs/decisions/` — where a PASS would be recorded
