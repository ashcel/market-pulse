"""Market structure — swing labeling, BOS/CHoCH, equal levels (port of structure.ts).

An interleaved sequence of swing highs and lows, each labeled relative to the
prior swing of its own kind, and a trend state derived from those labels.
"""

from dataclasses import dataclass
from typing import Literal

from smc.types import PivotPoint

SwingLabel = Literal["HH", "HL", "LH", "LL"]
StructureTrend = Literal["uptrend", "downtrend", "range"]
StructureEvent = Literal["bos", "choch"]
EqualKind = Literal["eqh", "eql"]

# How close two same-kind swing prices must be, as a fraction of the cluster
# anchor's price, to read as equal — "equal" highs are rarely tick-identical.
EQUAL_LEVEL_TOLERANCE = 0.001


@dataclass(slots=True)
class SwingPoint(PivotPoint):
    # This swing vs the previous same-kind swing. An extreme-extending label
    # (HH/LL) requires a *strict* break; a level match takes the internal
    # label (LH/HL) so a flat range never reads as a downtrend.
    label: SwingLabel | None = None
    # The structural break this swing produced. Retained per-swing so the full
    # BOS/CHoCH history survives; the structure's `event` is the latest only.
    event: StructureEvent | None = None
    # EQH/EQL vs the anchor of the current same-kind run. Only later members
    # of a cluster carry the flag — a completed swing's record never changes
    # as future swings arrive (replay safety).
    equal: EqualKind | None = None


@dataclass(slots=True)
class EqualLevel:
    kind: EqualKind
    # The liquidity line: the most extreme price among the cluster's swings.
    price: float
    # Member swings in time order; always at least two.
    swings: list[SwingPoint]


@dataclass(slots=True)
class MarketStructure:
    # Strictly alternating swing legs in time order (see to_alternating_swings).
    swings: list[SwingPoint]
    trend: StructureTrend
    last_high: SwingPoint | None
    last_low: SwingPoint | None
    # Latest structural break in the whole series (not necessarily the last swing).
    event: StructureEvent | None
    event_swing: SwingPoint | None
    # Clusters of consecutive equal swing highs/lows — double/triple tops/bottoms.
    equal_highs: list[EqualLevel]
    equal_lows: list[EqualLevel]


def structure_lean(structure: MarketStructure) -> Literal["long", "short", "none"]:
    """The structure's directional lean — the single definition every consumer reads.

    The trend when one exists; in a range the latest structural break decides
    while still "live" (its swing is still the most recent of its kind).
    """
    if structure.trend == "uptrend":
        return "long"
    if structure.trend == "downtrend":
        return "short"
    live = (
        structure.event_swing
        if structure.event_swing is not None
        and (
            structure.event_swing is structure.last_high
            or structure.event_swing is structure.last_low
        )
        else None
    )
    if live is not None and live.label == "HH":
        return "long"
    if live is not None and live.label == "LL":
        return "short"
    return "none"


def trend_from(high_label: SwingLabel | None, low_label: SwingLabel | None) -> StructureTrend:
    """An uptrend prints higher highs and higher lows; a downtrend, the mirror."""
    if high_label == "HH" and low_label == "HL":
        return "uptrend"
    if high_label == "LH" and low_label == "LL":
        return "downtrend"
    return "range"


def to_alternating_swings(pivots: list[PivotPoint]) -> list[PivotPoint]:
    """Collapse confirmed pivots into a strictly alternating high/low sequence.

    Consecutive same-kind pivots belong to a single swing leg, not a
    progression of legs — keep only each run's extreme. Pure forward fold, no
    lookahead: the still-forming leg's extreme can change as more same-kind
    pivots confirm, but every completed leg is frozen. Ties keep the earlier
    pivot (strict comparison), so the output is deterministic.
    """
    legs: list[PivotPoint] = []
    for pivot in pivots:
        current = legs[-1] if legs else None
        if current is None or current.kind != pivot.kind:
            legs.append(pivot)
            continue
        extends_leg = (
            pivot.price > current.price if pivot.kind == "high" else pivot.price < current.price
        )
        if extends_leg:
            legs[-1] = pivot
    return legs


def compute_market_structure(
    pivots: list[PivotPoint],
    equal_tolerance: float = EQUAL_LEVEL_TOLERANCE,
) -> MarketStructure:
    """Label alternating swing legs, maintaining trend and the latest break.

    Pass the full pivot set from compute_pivots — replay-safe, so backtests can
    rebuild structure from a bar-limited window.
    """
    swings: list[SwingPoint] = []
    last_high: SwingPoint | None = None
    last_low: SwingPoint | None = None
    trend: StructureTrend = "range"
    event: StructureEvent | None = None
    event_swing: SwingPoint | None = None

    # Equal-level runs: the current chain of consecutive same-kind swings still
    # within tolerance of the chain's first member (anchor). Comparing against
    # the anchor keeps a chain from drifting one tolerance per step.
    equal_highs: list[EqualLevel] = []
    equal_lows: list[EqualLevel] = []
    high_run: list[SwingPoint] = []
    low_run: list[SwingPoint] = []

    def close_run(run: list[SwingPoint], kind: EqualKind, out: list[EqualLevel]) -> None:
        if len(run) < 2:
            return
        prices = [s.price for s in run]
        out.append(
            EqualLevel(
                kind=kind,
                price=max(prices) if kind == "eqh" else min(prices),
                swings=list(run),
            )
        )

    for pivot in to_alternating_swings(pivots):
        # The extreme label (HH/LL) needs a strict break of the prior same-kind
        # swing; an equal level takes the internal label (LH/HL).
        label: SwingLabel | None = None
        if pivot.kind == "high":
            if last_high is not None:
                label = "HH" if pivot.price > last_high.price else "LH"
        elif last_low is not None:
            label = "LL" if pivot.price < last_low.price else "HL"

        # A swing only breaks structure when it takes out the prior same-kind
        # extreme. While the prior state is still range, the swing is structure
        # *forming*, not breaking — no event until a trend exists.
        swing_event: StructureEvent | None = None
        if label in ("HH", "LL") and trend != "range":
            reverses = (label == "HH" and trend == "downtrend") or (
                label == "LL" and trend == "uptrend"
            )
            swing_event = "choch" if reverses else "bos"

        # Equality against the current run's anchor; flagged on the later swing only.
        run = high_run if pivot.kind == "high" else low_run
        anchor = run[0] if run else None
        matches_anchor = (
            anchor is not None and abs(pivot.price - anchor.price) <= anchor.price * equal_tolerance
        )
        equal: EqualKind | None = (
            ("eqh" if pivot.kind == "high" else "eql") if matches_anchor else None
        )

        swing = SwingPoint(
            time=pivot.time,
            price=pivot.price,
            kind=pivot.kind,
            label=label,
            event=swing_event,
            equal=equal,
        )
        swings.append(swing)
        if swing_event is not None:
            event = swing_event
            event_swing = swing

        if pivot.kind == "high":
            if matches_anchor:
                high_run.append(swing)
            else:
                close_run(high_run, "eqh", equal_highs)
                high_run = [swing]
            last_high = swing
        else:
            if matches_anchor:
                low_run.append(swing)
            else:
                close_run(low_run, "eql", equal_lows)
                low_run = [swing]
            last_low = swing

        trend = trend_from(
            last_high.label if last_high else None,
            last_low.label if last_low else None,
        )

    close_run(high_run, "eqh", equal_highs)
    close_run(low_run, "eql", equal_lows)

    return MarketStructure(
        swings=swings,
        trend=trend,
        last_high=last_high,
        last_low=last_low,
        event=event,
        event_swing=event_swing,
        equal_highs=equal_highs,
        equal_lows=equal_lows,
    )
