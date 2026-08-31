"""The archive of every forward-test cohort ever recorded.

Every persisted row is provenance-stamped, and the rule that gives those stamps
meaning has until now lived as a prose comment on `DETECTOR_GENERATION`. Prose
cannot be queried, and the question it answers is asked constantly: *may these
two cohorts be averaged together?*

This module is that comment turned into data. It declares, per generation, what
changed and — the part that matters — **which measurements the change broke**.

## Why generation and not version

`strategy_version` is the obvious key and it is the wrong one. The record
already contains a counterexample: `discover-forward-test/1.0.0` carries rows
from three different detector generations, because the version tracks the
recording rules and the generation tracks what a result *means*. Filtering that
version gives one bucket holding three experiments.

So the archive is keyed by generation, and `releases_for_version` exists to map
the other way for anyone holding only a version string.

## Comparability is per metric, not per cohort

"Not comparable" is almost never true of a whole cohort. Generation 6 changed
how the round trip is priced: `realized_r` and `cost_r` are on a new basis,
while `gross_r` is bit-for-bit what generation 5 would have produced, and the
set of setups that exist at all is untouched. Collapsing that into one boolean
would throw away 215 rows of pooled gross sample to record a fact about fees —
which is exactly why every gate in `smc.arms` is written against gross.

Each release therefore declares three flags, each stated **against the release
immediately before it**:

| flag | pooling it protects |
|---|---|
| `gross_comparable` | mean `gross_r`, every arm gate, MFE/MAE in R |
| `net_comparable` | mean `realized_r`, `cost_r`, anything after fees |
| `population_comparable` | counts, hit rate, per-symbol and per-combo cuts |

`pooled_generations(generation, metric)` walks that chain in both directions and
returns every generation that may be averaged with the one given. A caller that
wants a defensible mean asks the archive rather than deciding for itself.

## What this module is not

It records what happened. It never decides anything: no gate reads it, and
adding a release here does not restart any clock — `recorder.DETECTOR_GENERATION`
does that, and it is derived from `LIVE` below so the two can never disagree.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

from smc.forward_test import FORWARD_TEST_VERSION

#: Bumped when an entry is added or an existing one is corrected. Not stamped on
#: rows: the archive describes cohorts from the outside, and a row already
#: carries the generation that indexes into it.
VERSION_ARCHIVE_VERSION = "1.0.0"

#: The measurements a change can break. A caller passes one of these to
#: `pooled_generations` rather than asking "is this cohort comparable", because
#: that question has no single answer.
Metric = Literal["gross_r", "net_r", "population"]

METRICS: tuple[Metric, ...] = ("gross_r", "net_r", "population")

#: Rows written before the generation stamp existed read as `None`, and they are
#: **not** generation 1. They are unattributed: the stamp is missing, which is a
#: different claim from a known value, and the same rule the rest of this plane
#: holds to ("a missing fact is never a good fact") applies to provenance first
#: of all. Reports bucket them under this label and never pool them with
#: anything.
UNSTAMPED = "unstamped"


@dataclass(frozen=True)
class Release:
    """One detector generation, and what its arrival invalidated.

    The three `*_comparable` flags are stated against the release immediately
    before this one. The first release has no predecessor and sets them all
    False — nothing precedes it, so nothing pools with it.
    """

    generation: int
    #: The `FORWARD_TEST_VERSION` in force. Several generations can share one:
    #: the version tracks recording rules, the generation tracks meaning.
    forward_test_version: str
    #: First day rows could be written under it. Sourced from the record, not
    #: from the commit date — a change is in the archive when it is *live*.
    opened: date
    summary: str
    #: What actually moved, one clause each.
    changed: tuple[str, ...]
    gross_comparable: bool
    net_comparable: bool
    population_comparable: bool
    #: Why the flags are what they are, when it is not self-evident.
    note: str = ""

    @property
    def strategy_version(self) -> str:
        """As stamped on the row by `recorder.STRATEGY_VERSION`."""
        return f"discover-forward-test/{self.forward_test_version}"

    def comparable(self, metric: Metric) -> bool:
        """Whether `metric` survives the step from the previous release."""
        if metric == "gross_r":
            return self.gross_comparable
        if metric == "net_r":
            return self.net_comparable
        return self.population_comparable


#: Oldest first. Append only — a release is never edited to say something other
#: than what it did, because rows recorded under it still exist and still mean
#: what they meant.
ARCHIVE: tuple[Release, ...] = (
    Release(
        generation=1,
        forward_test_version="1.0.0",
        opened=date(2026, 8, 12),
        summary="Original geometry.",
        changed=("first recorded cohort",),
        gross_comparable=False,
        net_comparable=False,
        population_comparable=False,
        note=(
            "Stops sat inside the symbol's own noise band, so an 'invalidation' "
            "was frequently a level the symbol crossed every minute. Nothing "
            "precedes this cohort, so all three flags are False by definition "
            "rather than by finding. Its rows carry no generation stamp — the "
            "field did not exist yet — so they report as `unstamped` and this "
            "entry reads zero. That is the honest shape: the rows exist, and "
            "nothing on them says which cohort they belong to."
        ),
    ),
    Release(
        generation=2,
        forward_test_version="1.0.0",
        opened=date(2026, 8, 12),
        summary="Volatility-floored stops.",
        changed=("the stop is held to a floor derived from the symbol's own volatility",),
        gross_comparable=False,
        net_comparable=False,
        population_comparable=False,
        note=(
            "Moving the stop moves the R denominator, so every per-trade number "
            "is on a new basis, and setups whose stop could not clear the floor "
            "stopped existing."
        ),
    ),
    Release(
        generation=3,
        forward_test_version="1.0.0",
        opened=date(2026, 8, 12),
        summary="Costs deducted, per-horizon patience, SWING added.",
        changed=(
            "`realized_r` is net of the round trip",
            "each horizon gets its own patience rather than one shared timeout",
            "a SWING horizon joins SCALP and INTRADAY",
        ),
        gross_comparable=False,
        net_comparable=False,
        population_comparable=False,
        note=(
            "Patience changes when a trade ends, which changes gross; costs "
            "change net; a new horizon changes the population. All three at "
            "once."
        ),
    ),
    Release(
        generation=4,
        forward_test_version="1.1.0",
        opened=date(2026, 8, 12),
        summary="One live hypothesis per symbol.",
        changed=(
            "a second setup on a symbol already being observed is not recorded "
            "while the first is open — same mode at all, any mode when the "
            "direction is opposite",
        ),
        gross_comparable=False,
        net_comparable=False,
        population_comparable=False,
        note=(
            "Generation 3 recorded the overlaps, so its rows hold several and "
            "sometimes contradictory positions on one move. Those are not an "
            "independent sample and must not be pooled with these — the break "
            "is in the sampling, which is why it takes all three flags down "
            "rather than only the population one."
        ),
    ),
    Release(
        generation=5,
        forward_test_version="1.2.0",
        opened=date(2026, 8, 13),
        summary="Two measurement fixes and one geometry fix.",
        changed=(
            "exits fill at the resting order's price instead of at the "
            "observation that revealed the crossing",
            "the stop's floor is enforced against the entry rather than the "
            "pullback extreme",
            "a cost floor: the round trip may eat at most `max_cost_r` of risk",
        ),
        gross_comparable=False,
        net_comparable=False,
        population_comparable=False,
        note=(
            "Generation 4 charged its stops a mean 0.174R of sampling-rate "
            "slippage and credited its targets 2.97R of overshoot — a bias "
            "whose size was set by how often the recorder looked, not by the "
            "strategy. None of the three was tuned on an outcome. Both floors "
            "also remove setups that previously existed."
        ),
    ),
    Release(
        generation=6,
        forward_test_version="1.3.0",
        opened=date(2026, 8, 16),
        summary="Cost priced per leg.",
        changed=(
            "the entry is a resting limit in the zone and pays a maker's fee "
            "with a maker's slippage",
            "a target exit is a resting limit and pays the same",
            "a stop, trail or timeout crosses the spread and pays a taker's; an "
            "unknown exit reason is charged as a taker so an open position "
            "marked to market is never flattered",
        ),
        gross_comparable=True,
        net_comparable=False,
        population_comparable=True,
        note=(
            "The first release in the archive that breaks only one metric. "
            "Generation 5 charged both legs as takers, overstating cost by "
            "0.063R/trade over its 244 costed rows against a gross edge of "
            "+0.107R. Nothing about which setups exist or where they resolve "
            "changed — `structural_path.PathConfig.round_trip_cost_pct` "
            "deliberately did not follow the fee down, because that number "
            "gates detection and lowering it would admit tighter stops. So "
            "gross and the population pool across this boundary and every arm "
            "gate keeps its sample; only `realized_r` and `cost_r` restart."
        ),
    ),
    Release(
        generation=7,
        forward_test_version="1.4.0",
        opened=date(2026, 8, 31),
        summary="Partial-exit ladder arm pre-registered.",
        changed=(
            "pre-registered partial_lock exit arm: 50% at +0.5R, 30% at +1R, residual stop to breakeven",
        ),
        gross_comparable=True,
        net_comparable=False,
        population_comparable=True,
        note=(
            "Partial exit is a settlement-semantics change: realized_r now "
            "reflects locked partials plus residual, not a single exit. "
            "Gross and population pool across this boundary; realized_r and "
            "cost_r restart. Arm is pre-registered only — engine logic is "
            "stubbed until the arm clears its gate."
        ),
    ),
)

#: The generation being written right now. `recorder.DETECTOR_GENERATION` is
#: this, so appending a release is the single edit that opens a cohort.
LIVE: Release = ARCHIVE[-1]

# Enforced at import, in the same spirit as `MAX_ARMS_PER_AXIS`. An archive that
# describes a version other than the one being written is worse than no archive:
# it would answer pooling questions confidently and wrongly, about rows nobody
# would think to re-check. Bumping `FORWARD_TEST_VERSION` without appending a
# release therefore fails at startup rather than at the next weekly report.
if LIVE.forward_test_version != FORWARD_TEST_VERSION:  # pragma: no cover - import guard
    raise RuntimeError(
        f"version archive is stale: FORWARD_TEST_VERSION is {FORWARD_TEST_VERSION!r} "
        f"but the newest release describes {LIVE.forward_test_version!r}. "
        "Append a Release to smc.version_archive.ARCHIVE for the new cohort."
    )

if sorted(r.generation for r in ARCHIVE) != list(  # pragma: no cover - import guard
    range(1, len(ARCHIVE) + 1)
):
    raise RuntimeError("version archive generations must be 1..N with no gaps or repeats")

_BY_GENERATION: dict[int, Release] = {release.generation: release for release in ARCHIVE}


def release_for(generation: int | None) -> Release | None:
    """The release a row's `versions.generation` refers to, or None.

    None covers both an unstamped row and a generation this archive has never
    heard of. Both mean the same thing to a caller — there is no basis on which
    to pool it — and neither should be silently mapped onto a real cohort.
    """
    if generation is None:
        return None
    return _BY_GENERATION.get(generation)


def releases_for_version(version: str) -> tuple[Release, ...]:
    """Every generation recorded under a version string, oldest first.

    Accepts either form of the stamp — `1.2.0` or the full
    `discover-forward-test/1.2.0`. Returns a tuple and not a single release on
    purpose: `1.0.0` holds three generations, and a caller that assumed one
    would be pooling three experiments without noticing.
    """
    wanted = version.rsplit("/", 1)[-1].strip()
    return tuple(r for r in ARCHIVE if r.forward_test_version == wanted)


def pooled_generations(generation: int, metric: Metric) -> tuple[int, ...]:
    """Every generation whose `metric` may be averaged with `generation`'s.

    Walks the declared chain in both directions: backwards while each release
    says it kept the metric intact, forwards while each *next* release says the
    same. Returns just `(generation,)` when the cohort stands alone, and an
    empty tuple when the generation is not in the archive — an unknown cohort
    pools with nothing, including itself.
    """
    if generation not in _BY_GENERATION:
        return ()

    index = next(i for i, r in enumerate(ARCHIVE) if r.generation == generation)

    first = index
    while first > 0 and ARCHIVE[first].comparable(metric):
        first -= 1

    last = index
    while last + 1 < len(ARCHIVE) and ARCHIVE[last + 1].comparable(metric):
        last += 1

    return tuple(r.generation for r in ARCHIVE[first : last + 1])


def pooled_with_live(metric: Metric) -> tuple[int, ...]:
    """The cohorts a report of today's numbers may include for `metric`.

    The common case, and the one worth having a name for: almost every read is
    "what is the current edge", and the honest answer depends on the metric
    being asked about.
    """
    return pooled_generations(LIVE.generation, metric)
