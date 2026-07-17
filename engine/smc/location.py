"""Entry-location grading (port of location.ts).

A directionally-correct verdict is still a bad trade when price is extended
away from the structure you'd want to enter against. This grades *where*
price sits in the support->resistance range for the trade's direction, so
"favored" can be reserved for setups that are also well located.

Grading runs on the last *closed* bar's analytics, so it changes once per bar.
"""

from dataclasses import dataclass
from typing import Literal

from smc.quant import SignalEvaluation, TradeDirection
from smc.sessions import SessionLevel, nearest_session_structure
from smc.zones import BaseZone

LocationGrade = Literal["at-structure", "mid-range", "extended"]
# How much fresh supply/demand structure backs the entry location.
ZoneConfluence = Literal["none", "single-timeframe", "multi-timeframe"]

_LABELS: dict[LocationGrade, str] = {
    "at-structure": "At structure",
    "mid-range": "Mid-range",
    "extended": "Extended",
}


@dataclass(slots=True)
class LocationRead:
    grade: LocationGrade
    # Short chip label for the UI.
    label: str
    # One-sentence plain explanation.
    note: str
    # The level to wait for a pullback/rally toward.
    pullback_target: float
    # 0 = at support, 1 = at resistance. May sit slightly outside [0,1].
    range_position: float
    confluence: ZoneConfluence


@dataclass(slots=True)
class LocationZones:
    """Execution- and context-timeframe zones for grading + confluence."""

    execution: list[BaseZone]
    context: list[BaseZone]


def _fmt_price(value: float) -> str:
    abs_ = abs(value)
    if abs_ >= 1000:
        text = f"{value:,.2f}".rstrip("0").rstrip(".")
        return f"${text}"
    if abs_ >= 1:
        text = f"{value:,.4f}".rstrip("0").rstrip(".")
        return f"${text}"
    text = f"{value:.5g}"
    return f"${text}"


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def _zones_overlap(a: BaseZone, b: BaseZone) -> bool:
    return a.price_low <= b.price_high and a.price_high >= b.price_low


def _entry_zone_at_price(
    zones: list[BaseZone],
    direction: Literal["long", "short"],
    price: float,
    atr: float | None,
) -> BaseZone | None:
    """The best fresh/tested zone price is sitting on for the trade direction.
    Fresh zones win over tested; ties break to the nearest proximal edge."""
    kind = "demand" if direction == "long" else "supply"
    matches: list[BaseZone] = []
    for z in zones:
        if z.kind != kind:
            continue
        buffer = (
            atr * 0.5
            if atr is not None and atr > 0
            else ((z.price_high - z.price_low) * 0.5 or price * 0.002)
        )
        inside = (
            z.price_low <= price <= z.price_high + buffer
            if direction == "long"
            else z.price_low - buffer <= price <= z.price_high
        )
        if inside:
            matches.append(z)
    if not matches:
        return None
    return sorted(
        matches,
        key=lambda z: (
            0 if z.freshness == "fresh" else 1,
            abs(price - (z.price_high if direction == "long" else z.price_low)),
        ),
    )[0]


def _pullback_zone(
    zones: list[BaseZone],
    direction: Literal["long", "short"],
    price: float,
) -> BaseZone | None:
    """The nearest fresh directional zone still ahead of a pullback (below for a long)."""
    kind = "demand" if direction == "long" else "supply"
    candidates = [
        z
        for z in zones
        if z.kind == kind
        and z.freshness == "fresh"
        and (z.price_high < price if direction == "long" else z.price_low > price)
    ]
    if not candidates:
        return None
    return sorted(
        candidates,
        key=lambda z: -z.price_high if direction == "long" else z.price_low,
    )[0]


def grade_location(
    evaluation: SignalEvaluation,
    direction: TradeDirection,
    zones: LocationZones | None = None,
    session_levels: list[SessionLevel] | None = None,
) -> LocationRead | None:
    """Grades where price sits for the given direction. None when there isn't a
    usable support/resistance frame. Fresh supply/demand structure can promote
    the grade to at-structure and flag multi-timeframe confluence."""
    if direction not in ("long", "short"):
        return None
    analytics = evaluation.analytics
    support = analytics.support
    resistance = analytics.resistance
    last_close = analytics.last_close
    atr_percent = analytics.atr_percent
    if support is None or resistance is None or not last_close or resistance <= support:
        return None

    # Fraction of the support->resistance band where price sits.
    pos = _clamp((last_close - support) / (resistance - support), -0.5, 1.5)
    # Proximity to the *ideal* entry structure: 0 = right at it, 1 = chasing
    # into the opposite level.
    proximity = pos if direction == "long" else 1 - pos
    pullback_target = support if direction == "long" else resistance

    # "Within ~1 ATR of structure" reads as at-structure regardless of fraction.
    atr_pct = atr_percent if atr_percent is not None and atr_percent > 0 else None
    dist_to_structure_pct = (
        ((last_close - support) / last_close) * 100
        if direction == "long"
        else ((resistance - last_close) / last_close) * 100
    )
    hugs_structure = atr_pct is not None and dist_to_structure_pct <= atr_pct * 1.1

    grade: LocationGrade
    if proximity <= 0.4 or hugs_structure:
        grade = "at-structure"
    elif proximity >= 0.7:
        grade = "extended"
    else:
        grade = "mid-range"

    near_level = support if direction == "long" else resistance
    far_level = resistance if direction == "long" else support
    side = "support" if direction == "long" else "resistance"
    ceiling = "resistance" if direction == "long" else "support"
    zone_word = "demand" if direction == "long" else "supply"

    # Fresh supply/demand backing. A zone price is literally sitting on is a
    # better read of "at structure" than a pivot fraction, so it can promote
    # the grade; a higher-timeframe zone lining up is multi-timeframe confluence.
    atr = analytics.atr14
    exe_zone = _entry_zone_at_price(zones.execution, direction, last_close, atr) if zones else None
    pullback_level = pullback_target
    confluence: ZoneConfluence = "none"

    if exe_zone is not None:
        grade = "at-structure"
        higher_zone = (
            next(
                (
                    z
                    for z in zones.context
                    if z.kind == exe_zone.kind
                    and (_zones_overlap(z, exe_zone) or z.price_low <= last_close <= z.price_high)
                ),
                None,
            )
            if zones
            else None
        )
        confluence = "multi-timeframe" if higher_zone is not None else "single-timeframe"
        zone_span = f"{_fmt_price(exe_zone.price_low)}–{_fmt_price(exe_zone.price_high)}"  # noqa: RUF001 — en dash matches the TS copy
        note = (
            (
                f"Price is on a {exe_zone.freshness} {zone_word} zone ({zone_span}) that lines "
                f"up with a higher-timeframe {zone_word} zone — multi-timeframe confluence, "
                f"the highest-quality {direction} entry on offer."
            )
            if confluence == "multi-timeframe"
            else (
                f"Price is on a {exe_zone.freshness} {zone_word} zone ({zone_span}) — a "
                f"structure-backed {direction} entry with a tight stop below it."
            )
        )
    elif grade == "at-structure":
        note = (
            f"Price is hugging {side} ({_fmt_price(near_level)}) — a clean spot to enter a "
            f"{direction} with a tight stop."
        )
    elif grade == "mid-range":
        note = (
            f"Price is mid-range between {_fmt_price(support)} and {_fmt_price(resistance)} — "
            f"a workable but not ideal {direction} entry; a pullback toward "
            f"{_fmt_price(pullback_target)} would be cleaner."
        )
    else:
        # When extended, a fresh zone beyond price is a better pullback target
        # than the raw pivot — that's where a discretionary trader would wait.
        zone = _pullback_zone(zones.execution, direction, last_close) if zones else None
        if zone is not None:
            pullback_level = zone.price_high if direction == "long" else zone.price_low
        note = (
            (
                f"Price is extended toward {ceiling} ({_fmt_price(far_level)}). Wait for a "
                f"pullback into the fresh {zone_word} zone near {_fmt_price(pullback_level)} — "
                f"a far cleaner {direction} entry than chasing here."
            )
            if zone is not None
            else (
                f"Price is extended toward {ceiling} ({_fmt_price(far_level)}) — entering here "
                f"chases the move with a wide stop and little room to target. Wait for a "
                f"pullback toward {_fmt_price(pullback_level)}."
            )
        )

    # Session high/low levels are horizontal intraday structure — strong enough
    # to read as "at structure" on their own, extra confluence when stacked.
    session_hug_dist = atr * 0.75 if atr is not None and atr > 0 else last_close * 0.004
    session_hug = (
        nearest_session_structure(session_levels, direction, last_close, session_hug_dist)
        if session_levels
        else None
    )
    if session_hug is not None:
        held = "holding" if direction == "long" else "capped at"
        session_desc = (
            f"the {session_hug.label} session {session_hug.kind} ({_fmt_price(session_hug.price)})"
        )
        if exe_zone is not None:
            note += f" It stacks on {session_desc} — added session-level confluence."
        elif grade != "at-structure":
            grade = "at-structure"
            note = (
                f"Price is {held} {session_desc} — an intraday level to lean a tight stop "
                f"against for a {direction} entry."
            )
        else:
            note += f" It also aligns with {session_desc}."

    return LocationRead(
        grade=grade,
        label=_LABELS[grade],
        note=note,
        pullback_target=pullback_level,
        range_position=pos,
        confluence=confluence,
    )
