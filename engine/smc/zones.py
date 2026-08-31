"""Supply/demand base zones (port of zones.ts).

A true demand/supply base: a tight cluster of indecision candles followed by
an explosive departure. Demand = bullish departure, supply = bearish.
"""

from dataclasses import dataclass
from typing import Literal

from smc.mock_candles import TokenTimeframe
from smc.types import Candle

ZoneKind = Literal["demand", "supply"]
ZoneFreshness = Literal["fresh", "tested"]

# Base detection needs each candle to summarize a meaningful auction. On
# 15M/30M a 200-bar window is 2-4 days of intraday churn — "bases" there are
# mostly noise, so supply/demand zones are only computed on these timeframes.
SD_ZONE_TIMEFRAMES: tuple[TokenTimeframe, ...] = ("1H", "4H", "1D", "1W")

_MAX_BASE_CANDLES = 5
_MAX_ZONES_PER_KIND = 2


@dataclass(slots=True)
class BaseZone:
    kind: ZoneKind
    price_low: float
    price_high: float
    # First candle of the base.
    start_time: int
    # The departure candle that confirmed the zone.
    end_time: int
    # "fresh" = never revisited since forming; "tested" = revisited once and held.
    freshness: ZoneFreshness


@dataclass(slots=True)
class BaseZoneCandidate:
    """A detected base before the freshness replay — what the lifecycle view enumerates."""

    kind: ZoneKind
    price_low: float
    price_high: float
    start_time: int
    end_time: int
    # Index of the departure candle; post-formation replays start after it.
    departure_index: int


def atr_series(candles: list[Candle], length: int = 14) -> list[float | None]:
    """Rolling simple-average true range; None until `length` bars are available."""
    out: list[float | None] = [None] * len(candles)
    total = 0.0
    for i, c in enumerate(candles):
        prev_close = candles[i - 1].close if i > 0 else c.close
        tr = max(c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close))
        total += tr
        if i >= length:
            first = candles[i - length]
            first_prev = candles[i - length - 1].close if i - length > 0 else first.close
            total -= max(
                first.high - first.low,
                abs(first.high - first_prev),
                abs(first.low - first_prev),
            )
        if i >= length - 1:
            out[i] = total / length
    return out


def compute_base_zone_candidates(candles: list[Candle]) -> list[BaseZoneCandidate]:
    """Every base the detector stands behind geometrically, before the freshness
    filter drops traded-through/consumed ones."""
    if len(candles) < 30:
        return []
    atr = atr_series(candles)
    zones: list[BaseZoneCandidate] = []

    for i in range(15, len(candles)):
        ref = atr[i - 1]
        if ref is None or ref <= 0:
            continue

        # Conviction departure: the body dwarfs recent true range and the
        # candle isn't mostly wick.
        departure = candles[i]
        body = abs(departure.close - departure.open)
        range_ = departure.high - departure.low
        if body < ref * 1.15 or range_ <= 0 or body < range_ * 0.55:
            continue

        # Walk back over indecision candles to collect the base.
        start = i - 1
        while (
            start > 0
            and i - start <= _MAX_BASE_CANDLES
            and abs(candles[start].close - candles[start].open) <= ref * 0.45
        ):
            start -= 1
        base = candles[start + 1 : i]
        if not base or len(base) > _MAX_BASE_CANDLES:
            continue

        # The base must be a tight shelf, not a volatile chop cluster.
        base_high = max(c.high for c in base)
        base_low = min(c.low for c in base)
        if base_high - base_low > ref * 1.4:
            continue

        # Distal edge = full wick extreme; proximal edge = candle bodies (with
        # a minimum thickness so single-doji bases still draw as a band).
        bullish = departure.close > departure.open
        if bullish:
            kind: ZoneKind = "demand"
            price_low = base_low
            price_high = max(*(max(c.open, c.close) for c in base), base_low + ref * 0.2)
        else:
            kind = "supply"
            price_high = base_high
            price_low = min(*(min(c.open, c.close) for c in base), base_high - ref * 0.2)

        zones.append(
            BaseZoneCandidate(
                kind=kind,
                price_low=price_low,
                price_high=price_high,
                start_time=candles[start + 1].time,
                end_time=departure.time,
                departure_index=i,
            )
        )

    return zones


def compute_base_zones(candles: list[Candle]) -> list[BaseZone]:
    zones: list[BaseZone] = []
    for candidate in compute_base_zone_candidates(candles):
        freshness = _zone_freshness(
            candles,
            candidate.departure_index + 1,
            candidate.kind,
            candidate.price_low,
            candidate.price_high,
        )
        if freshness is None:
            continue
        zones.append(
            BaseZone(
                kind=candidate.kind,
                price_low=candidate.price_low,
                price_high=candidate.price_high,
                start_time=candidate.start_time,
                end_time=candidate.end_time,
                freshness=freshness,
            )
        )
    return _select_zones(zones)


def _zone_freshness(
    candles: list[Candle],
    from_index: int,
    kind: ZoneKind,
    low: float,
    high: float,
) -> ZoneFreshness | None:
    """Replays price action after the departure. None when the zone is
    invalidated: a close beyond the distal edge (traded through) or a second
    revisit (consumed)."""
    touches = 0
    # Price often lingers at the proximal edge right after departure — that
    # initial contact is part of forming, not a test.
    inside = True
    for k in range(from_index, len(candles)):
        c = candles[k]
        if c.close < low if kind == "demand" else c.close > high:
            return None
        touching = c.low <= high if kind == "demand" else c.high >= low
        if touching and not inside:
            touches += 1
            if touches >= 2:
                return None
        inside = touching
    return "fresh" if touches == 0 else "tested"


def select_zone_candidates(candidates: list[BaseZoneCandidate]) -> list[BaseZoneCandidate]:
    """Candidate curation under _select_zones' exact rules, for the lifecycle
    ledger — accepts the display-plane divergence of picking a recently-dead
    base over an older live one, to show terminal zones at all."""
    return _select_zones(candidates)


from typing import TypeVar

Z = TypeVar("Z", "BaseZone", "BaseZoneCandidate")


def _select_zones(zones: list[Z]) -> list[Z]:
    """Most recent zones win; overlapping same-kind duplicates and overflow are dropped."""
    picked: list[Z] = []
    for zone in sorted(zones, key=lambda z: z.end_time, reverse=True):
        if sum(1 for p in picked if p.kind == zone.kind) >= _MAX_ZONES_PER_KIND:
            continue
        overlaps = any(
            p.kind == zone.kind
            and zone.price_low <= p.price_high
            and zone.price_high >= p.price_low
            for p in picked
        )
        if not overlaps:
            picked.append(zone)
    return sorted(picked, key=lambda z: z.start_time)
