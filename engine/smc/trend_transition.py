"""Trend transitions — the narrative connecting structure.py's two outputs
(port of trend-transition.ts).

The structure maintains a *current* trend and discrete CHoCH/BOS events, but
nothing says "the downtrend that CHoCH hinted against is now a confirmed
uptrend as of swing X". This deriver folds the already-labeled swing sequence
back through `trend_from` (the exact evolution `compute_market_structure`
maintains — parity-pinned) and emits transition records:

- **choch-hint**: a CHoCH printed against the prevailing trend — the first
  structural hint, not yet a new trend. A hint that never confirms simply
  stays a hint in the history, superseded by whatever happened instead.
- **confirmed**: the running trend actually flipped. When a pending hint
  pointed this way the hint record upgrades in place (keeping the originating
  CHoCH swing); a flip with no hint — structure forming out of a range —
  confirms directly with `choch_swing=None`.

Falls *into* range are deliberately not records: a range is the space between
trends, and the next transition's `from` field carries it.

Replay-safe: labels and events are frozen per swing (structure.py's own rule)
and the fold is forward-only. Display-plane: read by no verdict — hysteresis'
contextBias-flip release stays the only trend reactivity in the decision path.
"""

from dataclasses import dataclass
from typing import Literal

from smc.structure import MarketStructure, StructureTrend, SwingLabel, SwingPoint, trend_from

TransitionPhase = Literal["choch-hint", "confirmed"]


@dataclass(slots=True)
class TrendTransition:
    # The trend the market is leaving — the prevailing state when the transition opened.
    from_trend: StructureTrend
    # The newly established trend (confirmed) or the hinted direction (choch-hint).
    to_trend: StructureTrend
    phase: TransitionPhase
    # The CHoCH that opened the transition; None when structure formed straight out of a range.
    choch_swing: SwingPoint | None
    # The swing whose labels completed the flip; None while the hint is live.
    confirm_swing: SwingPoint | None
    # Time of the latest phase advance.
    time: int


def derive_trend_transitions(structure: MarketStructure) -> list[TrendTransition]:
    """Full transition history, chronological."""
    out: list[TrendTransition] = []
    high_label: SwingLabel | None = None
    low_label: SwingLabel | None = None
    trend: StructureTrend = "range"
    pending: TrendTransition | None = None

    for swing in structure.swings:
        # A new opposing extreme kills a live hint — the market resumed instead.
        # A fall into range does NOT: the interlude between CHoCH and the
        # confirming swing is range by construction (HH beside a stale LL).
        if pending is not None and (
            (pending.to_trend == "uptrend" and swing.label == "LL")
            or (pending.to_trend == "downtrend" and swing.label == "HH")
        ):
            pending = None

        # A CHoCH opens (or reopens) a transition toward its break direction.
        if swing.event == "choch":
            pending = TrendTransition(
                from_trend=trend,
                to_trend="uptrend" if swing.label == "HH" else "downtrend",
                phase="choch-hint",
                choch_swing=swing,
                confirm_swing=None,
                time=swing.time,
            )
            out.append(pending)

        if swing.kind == "high":
            high_label = swing.label
        else:
            low_label = swing.label
        next_trend = trend_from(high_label, low_label)

        if next_trend != trend and next_trend != "range":
            if pending is not None and pending.to_trend == next_trend:
                # The hinted reversal completed — upgrade the record in place so
                # the history reads hint → confirmation as one transition.
                pending.phase = "confirmed"
                pending.confirm_swing = swing
                pending.time = swing.time
            else:
                out.append(
                    TrendTransition(
                        from_trend=trend,
                        to_trend=next_trend,
                        phase="confirmed",
                        choch_swing=None,
                        confirm_swing=swing,
                        time=swing.time,
                    )
                )
            pending = None

        trend = next_trend

    return out


def latest_transition(structure: MarketStructure) -> TrendTransition | None:
    """The most recent transition record (confirmed or still a live hint); None when none."""
    transitions = derive_trend_transitions(structure)
    return transitions[-1] if transitions else None
