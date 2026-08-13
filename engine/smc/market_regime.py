"""Whole-market regime, read from the same all-market tick the radar already has.

Why this exists: two forward-test cohorts were compared and the apparent
difference between them turned out to be tape, not detector. One ran across a
2.5-hour trending afternoon where a trailing stop kept 64% of its best excursion;
the next ran 14 overnight hours of chop where the same rule kept 36% of a *larger*
excursion. Nothing in the record said so — every row carried per-symbol context
and none carried what the market as a whole was doing — so the two cohorts could
not be compared on equal terms and the trail could not be judged at all.

This module answers one question, cheaply and without a network call: **is the
whole tape going one way, or is it churning?** It is an *observation*, never a
gate. Nothing here filters a setup, sizes anything, or changes a decision. It is
recorded so that outcomes can later be segmented by the conditions they happened
in, which is the only way a rule like "trail after 1R" can ever be shown to be
right or wrong rather than lucky or unlucky.

Deliberately crude. Breadth over a liquidity floor, and the median absolute
move — no smoothing, no memory, no regression. A regime read that needed
tuning would be another parameter to defend; this one is a headcount.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from statistics import median
from typing import Any, Literal

MARKET_REGIME_VERSION = "1.0.0"

RegimeState = Literal["bullish", "bearish", "choppy", "unknown"]

# A symbol has to trade to count as a vote. Below this, its 15m print is a
# spread artefact rather than participation.
MIN_QUOTE_VOLUME_24H = 5_000_000.0

# How far a symbol must have moved over the window to count as advancing or
# declining rather than flat. Roughly a fee's width — under it, direction is
# not a claim anyone would act on.
MOVE_THRESHOLD_PCT = 0.15

# How lopsided the advance/decline split has to be before the tape is called
# directional. Below it the market is churning, whatever its median move.
BREADTH_MARGIN = 0.20

# Fewest voting symbols for a read to mean anything. A cold-started store has
# a handful of symbols with windows and they are not a market.
MIN_SAMPLE = 40


@dataclass(frozen=True)
class MarketRegime:
    """What the whole tape was doing at one instant.

    `state` is the label; the numbers behind it are kept because the label is a
    threshold away from being a different label, and later analysis should be
    able to re-cut this without re-running the tape.
    """

    state: RegimeState
    # Share of voting symbols advancing / declining over the window.
    advancing: float
    declining: float
    # Median absolute move across voting symbols — how much the tape is moving
    # at all, independent of which way. Separates a dead range from a violent
    # two-sided chop, which are the same `state` and very different to trade.
    energy_pct: float
    # How many symbols voted, out of how many were seen.
    sample: int
    universe: int
    version: str = MARKET_REGIME_VERSION

    @property
    def breadth(self) -> float:
        """Advance minus decline: +1.0 everything up, -1.0 everything down."""
        return round(self.advancing - self.declining, 4)

    @property
    def is_directional(self) -> bool:
        return self.state in ("bullish", "bearish")


UNKNOWN_REGIME = MarketRegime(
    state="unknown", advancing=0.0, declining=0.0, energy_pct=0.0, sample=0, universe=0
)


def _window_change(metrics: object, window: str) -> float | None:
    value = getattr(metrics, f"change_{window}_pct", None)
    return float(value) if value is not None else None


def read_regime(
    metrics: Iterable[object],
    *,
    window: str = "15m",
    min_quote_volume: float = MIN_QUOTE_VOLUME_24H,
    move_threshold: float = MOVE_THRESHOLD_PCT,
    breadth_margin: float = BREADTH_MARGIN,
    min_sample: int = MIN_SAMPLE,
) -> MarketRegime:
    """Classifies the tape from one pass over the whole-market window metrics.

    Takes whatever the fast lane already computed — no fetch, no store lookup,
    no per-symbol call — so this costs one iteration over a list the scanner is
    holding anyway.

    Symbols missing the window (cold start) or under the liquidity floor do not
    vote. Too few voters and the answer is `unknown`, which is a real answer:
    the alternative is calling a regime off nine symbols.
    """
    changes: list[float] = []
    universe = 0
    for entry in metrics:
        universe += 1
        if float(getattr(entry, "quote_volume_24h", 0.0) or 0.0) < min_quote_volume:
            continue
        change = _window_change(entry, window)
        if change is None:
            continue
        changes.append(change)

    if len(changes) < min_sample:
        return MarketRegime(
            state="unknown",
            advancing=0.0,
            declining=0.0,
            energy_pct=0.0,
            sample=len(changes),
            universe=universe,
        )

    up = sum(1 for change in changes if change >= move_threshold)
    down = sum(1 for change in changes if change <= -move_threshold)
    total = len(changes)
    advancing = up / total
    declining = down / total
    energy = median(abs(change) for change in changes)

    if advancing - declining >= breadth_margin:
        state: RegimeState = "bullish"
    elif declining - advancing >= breadth_margin:
        state = "bearish"
    else:
        # Includes both a dead tape and a violent two-sided one. `energy_pct`
        # is what tells them apart; the label deliberately does not, because a
        # trade taken into either is taken without a market-wide tailwind.
        state = "choppy"

    return MarketRegime(
        state=state,
        advancing=round(advancing, 4),
        declining=round(declining, 4),
        energy_pct=round(energy, 4),
        sample=total,
        universe=universe,
    )


def regime_payload(regime: MarketRegime | None) -> dict[str, Any]:
    """The flat form stored on a record. Missing reads round-trip as `unknown`
    rather than as an absent key, so a row from before this shipped and a row
    from a cold start are distinguishable from one another only by `sample`."""
    read = regime if regime is not None else UNKNOWN_REGIME
    return {
        "state": read.state,
        "advancing": read.advancing,
        "declining": read.declining,
        "breadth": read.breadth,
        "energy_pct": read.energy_pct,
        "sample": read.sample,
        "universe": read.universe,
        "version": read.version,
    }


def regime_from_payload(payload: Sequence[Any] | dict[str, Any] | None) -> MarketRegime:
    """Rebuilds a read from a stored payload. Anything unrecognised is
    `unknown` — a corrupted blob must not silently become a regime claim."""
    if not isinstance(payload, dict):
        return UNKNOWN_REGIME
    state = str(payload.get("state") or "unknown")
    if state not in ("bullish", "bearish", "choppy", "unknown"):
        return UNKNOWN_REGIME
    return MarketRegime(
        state=state,  # type: ignore[arg-type]
        advancing=float(payload.get("advancing") or 0.0),
        declining=float(payload.get("declining") or 0.0),
        energy_pct=float(payload.get("energy_pct") or 0.0),
        sample=int(payload.get("sample") or 0),
        universe=int(payload.get("universe") or 0),
        version=str(payload.get("version") or MARKET_REGIME_VERSION),
    )
