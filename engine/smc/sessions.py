"""Trading-session high/low levels (port of sessions.ts, pure parts).

Crypto trades 24/7, but liquidity still rotates through Asia, European and US
sessions; the high/low a session prints become next-day intraday levels. This
computes the most recent *completed* session's range per region. Windows are
UTC and non-overlapping. Best computed from 1H candles.

The TS module's fetch helpers (fetchSessionLevels / server fn) are backend
concerns — the Python engine takes candles as inputs (framework-free).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from smc.types import Candle, PivotKind

TradingSession = Literal["asia", "eu", "us"]


@dataclass(slots=True)
class SessionWindow:
    session: TradingSession
    label: str
    # UTC hours [start, end).
    start_hour: int
    end_hour: int


# Non-overlapping UTC blocks. Tokyo runs the early hours, London the middle,
# New York the afternoon; 21:00-24:00 is the thin post-US lull and is left out
# so it doesn't smear into the next Asia range.
SESSION_WINDOWS: tuple[SessionWindow, ...] = (
    SessionWindow(session="asia", label="Asia", start_hour=0, end_hour=8),
    SessionWindow(session="eu", label="London", start_hour=8, end_hour=13),
    SessionWindow(session="us", label="New York", start_hour=13, end_hour=21),
)

# A week of 1H candles — the fetch limit backend callers should use.
SESSION_LEVELS_CANDLE_LIMIT = 168


@dataclass(slots=True)
class SessionLevel:
    session: TradingSession
    label: str
    high: float
    low: float
    # UTC ms of the session window's start and end.
    start_ms: int
    end_ms: int


@dataclass(slots=True)
class SessionPrice:
    """One horizontal price a session prints — its high or its low."""

    label: str
    session: TradingSession
    kind: PivotKind
    price: float


def _window_for(hour: int) -> SessionWindow | None:
    return next((w for w in SESSION_WINDOWS if w.start_hour <= hour < w.end_hour), None)


def compute_session_levels(candles: list[Candle], now_ms: int | None = None) -> list[SessionLevel]:
    """Most recent completed session per region, from the candle set.

    A session is "completed" once its window end is in the past (now_ms); the
    still-forming current session is skipped so its H/L doesn't move under you.
    """
    if now_ms is None:
        now_ms = int(datetime.now(tz=UTC).timestamp() * 1000)
    if not candles:
        return []

    # Accumulate H/L per concrete session instance, keyed by (session, start ms).
    instances: dict[tuple[TradingSession, int], SessionLevel] = {}

    for c in candles:
        d = datetime.fromtimestamp(c.time, tz=UTC)
        win = _window_for(d.hour)
        if win is None:
            continue
        day_start = datetime(d.year, d.month, d.day, tzinfo=UTC)
        start_ms = int(day_start.timestamp() * 1000) + win.start_hour * 3_600_000
        end_ms = int(day_start.timestamp() * 1000) + win.end_hour * 3_600_000
        if end_ms > now_ms:
            continue  # session not finished yet

        key = (win.session, start_ms)
        existing = instances.get(key)
        if existing is not None:
            existing.high = max(existing.high, c.high)
            existing.low = min(existing.low, c.low)
        else:
            instances[key] = SessionLevel(
                session=win.session,
                label=win.label,
                high=c.high,
                low=c.low,
                start_ms=start_ms,
                end_ms=end_ms,
            )

    # Pick the latest completed instance for each region.
    latest: dict[TradingSession, SessionLevel] = {}
    for inst in instances.values():
        held = latest.get(inst.session)
        if held is None or inst.start_ms > held.start_ms:
            latest[inst.session] = inst

    return [latest[w.session] for w in SESSION_WINDOWS if w.session in latest]


def session_prices(levels: list[SessionLevel]) -> list[SessionPrice]:
    """Flatten session levels into individual high/low prices for level-matching."""
    out: list[SessionPrice] = []
    for level in levels:
        out.append(
            SessionPrice(label=level.label, session=level.session, kind="high", price=level.high)
        )
        out.append(
            SessionPrice(label=level.label, session=level.session, kind="low", price=level.low)
        )
    return out


def nearest_session_structure(
    levels: list[SessionLevel],
    direction: Literal["long", "short"],
    price: float,
    max_distance: float,
) -> SessionPrice | None:
    """The nearest session level acting as structure on the entry side: at or
    below price for a long (support it's holding), at or above for a short
    (resistance it's capped by), within max_distance."""
    on_side = [
        p
        for p in session_prices(levels)
        if (p.price <= price if direction == "long" else p.price >= price)
    ]
    best: SessionPrice | None = None
    best_dist = float("inf")
    for p in on_side:
        dist = abs(price - p.price)
        if dist < best_dist:
            best_dist = dist
            best = p
    return best if best is not None and best_dist <= max_distance else None
