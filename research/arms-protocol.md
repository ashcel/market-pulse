# Arms protocol

How competing implementations are run, measured and promoted.

Registry: `engine/smc/arms.py` · Report: `backend/app/research/arms_report.py`
· Runner: `deploy/weekly-arms-report.sh` · Weekly output: `research/weekly/`

## The shape

An **axis** is one functionality. An **arm** is one way of doing it. Each axis
carries a control — whatever the live detector does today — and **at most two**
alternatives. `MAX_ARMS_PER_AXIS = 3`, enforced at import.

Three is a power budget, not a preference. Every arm added to a report widens
the Holm family and raises the bar for all of them, so a fourth arm makes the
other three harder to resolve. The way to test a fourth idea is to retire one.

| axis | question | how it runs |
|---|---|---|
| `exit` | what to do with a filled position | settled forward, paired |
| `plan` | where entry, stop and target are drawn | settled forward, paired, own frozen snapshot |
| `detect` | which situations become setups at all | flag stamped at detection, read as a subset |

### Why detector arms are flags

An exit or plan arm rides the same detection, so it can be settled alongside
the control against the same tape. A detector arm claims a *different set of
setups should have existed* — there is no matching observation to settle. It is
therefore a predicate evaluated once at detection and stored on the row
(`arm_flags`), and the report reads it as a subset.

This costs nothing at runtime and keeps the property the rest of the record
has: the flag is frozen at `detected_at` and never recomputed. It also means a
detector arm can never be accidentally "switched on" in production — there is
nothing to switch.

The price is statistical: a subset comparison is unpaired, so detector arms
carry much higher floors (600) than settled arms (400).

## Registering an arm

An arm enters the registry with all four of these, or it does not enter:

1. **A hypothesis stated so it can be wrong.** Not "test a wider stop" —
   "the control's edge is real but sub-cost; a 1.5% minimum stop nets more".
2. **A registration date.** Observations before it do not exist. The report
   never back-fills.
3. **A gate**: minimum settled sample, minimum gross edge, alpha.
4. **A free slot on its axis.**

Registration is a code change to `engine/smc/arms.py`, which bumps
`ARMS_VERSION`. That version is stamped on every row, so two registries can
never pool.

## Gates

`Gate(min_settled, min_gross_edge_r, alpha)`.

**Gross, always.** A plan arm with a wider stop pays proportionally less fee
per R. That is arithmetic, not edge. Gating on net R would promote a wide stop
for free — the record already produced this exact mirage once, when
`structural_swing` showed t = +2.82 against the control on net R at n = 6, with
a gross difference of **exactly 0.000**.

**Cumulative, not weekly.** A week is ~700 settled setups at an observation sd
of ~1.4R, so a weekly mean carries a standard error near 0.05R. Gates apply to
the arm's whole sample since registration. The weekly numbers are shown because
they are what changed, never because they decide.

**One Holm family per run.** Every arm judged in a report goes through one
Holm–Bonferroni correction, so the family-wise error rate is the stated alpha
rather than alpha per arm per week. Fifty-two weekly reports at uncorrected
p < 0.05 across six arms is ~15 false positives a year, all of them arriving as
confident news.

**Below the floor, there is no verdict.** Not a provisional one, not a ranking,
not a p-value — the report prints `INSUFFICIENT` and how far short it is, and
nothing else. This is the single most important rule here.

### Verdicts

| verdict | meaning |
|---|---|
| `PASS` | over floor, Holm-significant, edge ≥ minimum. **Opens a decision.** Promotes nothing. |
| `RETIRE` | over floor, Holm-significant, control wins. The slot is free. |
| `FAIL` | over floor, not significant, or edge below minimum. Keep running or retire by judgment. |
| `INSUFFICIENT` | under floor. No other number is reported. |
| `NO DATA` | the arm never produced a settled pair. |

## Promotion

**A `PASS` never changes anything by itself.** Promotion of an arm to control
is a human decision, and it is:

1. an EDR in `docs/decisions/`, stating what the arm proved and what it does
   not,
2. an `ENGINE_VERSION` bump — this changes decision or trigger semantics, which
   per `CLAUDE.md` restarts the evidence clock,
3. the old control demoted to an arm, or retired if the question is closed.

The weekly agent may propose all of this. It may not do any of it.

## Cost scenarios

The report re-derives net R under a cheaper round trip (maker fills) from
stored geometry — `entry * round_trip_pct / 100 / |entry - invalidation|`, every
term already on the row. This is a **scenario, not an arm**: no gate reads it,
because nothing has yet demonstrated those fills are reachable. It is there
because on the standing record it is the largest single number in the file.

Every scenario shares one denominator (`costed_rows`). A filled row settled
before costs were recorded is a missing measurement, not a free trade; letting
it into one scenario and not another moved the live figure by 0.05R once.

## The weekly cycle

Cron, Monday 08:00 UTC, on this VPS. It cannot be a cloud agent — the Postgres
it reads is bound to `localhost:5435`.

1. Generate `research/weekly/YYYY-Www.md` (deterministic, stdlib only).
2. Send the summary to Telegram.
3. *Then* run the interpretation pass (`claude -p`), which appends `## Reading`
   and may propose rotations.

Stage 3 is best-effort and runs last on purpose. An LLM is allowed to be
unavailable; the record is not.

## Standing state (2026-08-14)

Registry `1.0.0`. Control on all three axes is the live SCALP/INTRADAY
detector at `ENGINE_VERSION 2.0.0`.

| axis | arm | registered | floor | status |
|---|---|---|---|---|
| exit | `no_trail` | 2026-08-13 | 400 | 175 settled |
| exit | `wide_trail` | 2026-08-13 | 400 | 175 settled |
| plan | `structural_swing` | 2026-08-13 | 150 | 6 settled |
| plan | `wide_stop` | 2026-08-14 | 400 | new |
| detect | `displacement_only` | 2026-08-14 | 600 | new |
| detect | `htf_aligned` | 2026-08-14 | 600 | new |

The evaluation that produced this registry: over 202 filled setups the control
ran -0.190R net per trade (t = -1.94) on a gross edge of +0.072R (t = +0.76) —
statistically indistinguishable from zero, and ~1,400 trades short of being
able to say otherwise. Mean stop was 0.79% of price against a 0.14% round trip,
putting cost at 26% of R. Under maker fills the same record nets +0.009R
instead of -0.116R. That is why the `plan` axis and the cost scenarios exist:
the binding constraint on this strategy is not the detector.
