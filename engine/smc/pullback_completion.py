"""PULLBACK COMPLETION — evidence that a retracement is ending.

The goal is explicitly **not** to call the exact turn. It is to say what can be
observed right now, item by item, so a human can decide whether the retracement
looks finished:

    ✓ Pullback volume cooled          0.8x
    ✓ Retracement controlled          38% of leg
    ✓ Reached structural level        5m swing low
    ✓ Minor liquidity swept           equal lows
    ✓ Bearish CHoCH on 1m
    ✗ Directional volume re-expanding 1.1x

## Why a list and not a score

A single 0-100 number would be easier to sort by and much worse to trust: it
hides which evidence fired, invites threshold-fiddling, and reads as certainty
the detector has not earned. So the output is the evidence, and the state is a
count over it — with one deliberate rule: LIKELY additionally requires a
**trigger**, something that actually happened (a micro CHoCH, a sweep, or fresh
directional displacement) rather than six ways of saying "it went quiet".

A score can be layered on later *if* the journal shows it predicts anything.
The evidence stays inspectable either way.

## Independence

Takes measurements, returns evidence. It does not know about higher-timeframe
bias, ranking, or R-multiples, and it never decides whether a situation is
worth showing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from smc.pullback import PullbackRead

CompletionState = Literal["NONE", "FORMING", "DEVELOPING", "LIKELY"]

EvidenceCode = Literal[
    "VOLUME_COOLED",
    "RETRACEMENT_CONTROLLED",
    "STRUCTURAL_LEVEL",
    "LIQUIDITY_SWEPT",
    "MICRO_CHOCH",
    "OPPOSING_MOMENTUM_EXHAUSTED",
    "RENEWED_DISPLACEMENT",
    "VOLUME_REEXPANDING",
]

#: Evidence that something *happened*, as opposed to something merely being
#: quiet. LIKELY requires at least one of these — otherwise a dead tape would
#: read as an imminent resumption.
TRIGGER_CODES: frozenset[str] = frozenset(
    {"MICRO_CHOCH", "LIQUIDITY_SWEPT", "RENEWED_DISPLACEMENT"}
)


@dataclass(frozen=True, slots=True)
class CompletionConfig:
    """Per-mode thresholds. A scalper needs the turn called on thinner
    evidence and sooner; an intraday trader can afford to wait for more."""

    cooling_rvol: float = 1.00
    controlled_retrace_frac: float = 0.62
    # Counter-directional move on the fast window at or below which opposing
    # momentum reads as exhausted.
    exhausted_opposing_pct: float = 0.15
    # Fresh move *in the impulse direction* that counts as the leg resuming.
    renewed_displacement_pct: float = 0.25
    # Relative volume at which the directional tape is re-expanding.
    reexpansion_rvol: float = 1.50
    # Evidence counts for each state.
    forming_min: int = 2
    developing_min: int = 3
    likely_min: int = 5

    def __post_init__(self) -> None:
        if not 0 < self.forming_min <= self.developing_min <= self.likely_min:
            raise ValueError("completion thresholds must be non-decreasing and positive")


DEFAULT_COMPLETION_CONFIG = CompletionConfig()


@dataclass(frozen=True, slots=True)
class Evidence:
    """One observation, its verdict, and the reading behind it.

    `detail` is a short machine-ish string ("0.8x", "38% of leg") rather than a
    sentence: the card shows it verbatim, and prose belongs nowhere near a
    detector.
    """

    code: EvidenceCode
    met: bool
    detail: str


@dataclass(frozen=True, slots=True)
class CompletionRead:
    state: CompletionState
    evidence: tuple[Evidence, ...]
    met_count: int
    # Whether at least one *event* (not just quiet tape) is among the evidence.
    has_trigger: bool

    @property
    def met(self) -> tuple[Evidence, ...]:
        return tuple(item for item in self.evidence if item.met)


def _fmt_mult(value: float | None) -> str:
    return "—" if value is None else f"{value:.1f}x"


def read_completion(
    pullback: PullbackRead,
    *,
    directional_move_pct: float,
    directional_rvol: float | None,
    micro_choch: bool,
    liquidity_swept: bool,
    config: CompletionConfig = DEFAULT_COMPLETION_CONFIG,
) -> CompletionRead:
    """Assembles the evidence list for the current retracement.

    `directional_move_pct` is the fast-window move measured **in the impulse's
    own direction** (positive = the leg resuming), so bullish and bearish
    produce identical evidence from mirrored tape. `directional_rvol` is the
    relative volume behind it.
    """
    volume_ratio = pullback.volume_ratio
    evidence: list[Evidence] = [
        Evidence(
            code="VOLUME_COOLED",
            met=volume_ratio is not None and volume_ratio <= config.cooling_rvol,
            detail=_fmt_mult(volume_ratio),
        ),
        Evidence(
            code="RETRACEMENT_CONTROLLED",
            met=pullback.structure_intact
            and pullback.retrace_frac <= config.controlled_retrace_frac,
            detail=f"{pullback.retrace_frac * 100:.0f}% of leg",
        ),
        Evidence(
            code="STRUCTURAL_LEVEL",
            met=pullback.at_level is not None,
            detail=(
                f"{pullback.at_level.timeframe} {pullback.at_level.kind}"
                if pullback.at_level is not None
                else "—"
            ),
        ),
        Evidence(
            code="LIQUIDITY_SWEPT",
            met=liquidity_swept,
            detail="swept" if liquidity_swept else "—",
        ),
        Evidence(
            code="MICRO_CHOCH",
            met=micro_choch,
            detail="printed" if micro_choch else "—",
        ),
        Evidence(
            code="OPPOSING_MOMENTUM_EXHAUSTED",
            met=pullback.opposing_move_pct <= config.exhausted_opposing_pct,
            detail=f"{pullback.opposing_move_pct:.2f}%",
        ),
        Evidence(
            code="RENEWED_DISPLACEMENT",
            met=directional_move_pct >= config.renewed_displacement_pct,
            detail=f"{directional_move_pct:+.2f}%",
        ),
        Evidence(
            code="VOLUME_REEXPANDING",
            met=directional_rvol is not None and directional_rvol >= config.reexpansion_rvol,
            detail=_fmt_mult(directional_rvol),
        ),
    ]

    met_count = sum(1 for item in evidence if item.met)
    has_trigger = any(item.met and item.code in TRIGGER_CODES for item in evidence)

    if met_count >= config.likely_min and has_trigger:
        state: CompletionState = "LIKELY"
    elif met_count >= config.developing_min:
        state = "DEVELOPING"
    elif met_count >= config.forming_min:
        state = "FORMING"
    else:
        state = "NONE"

    return CompletionRead(
        state=state,
        evidence=tuple(evidence),
        met_count=met_count,
        has_trigger=has_trigger,
    )
