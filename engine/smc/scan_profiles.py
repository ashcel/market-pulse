"""SCAN PROFILES — one radar, two horizons.

The scanner serves scalp and intraday traders, and they are not looking at the
same market. A 0.8% displacement over three minutes is the whole trade for one
and noise for the other; a 45-minute-old event is stale for one and still
forming for the other. Running both off one threshold set would produce a
scanner that is wrong for everybody, so every mode-dependent number lives here,
in one bundle per mode.

    SCALP      context 1H/15m · structure 5m/3m · events 1m/3m
    INTRADAY   context 4H/1H  · structure 15m/5m · events 5m/15m

Swing deliberately absent: it belongs to the slower, separate architecture
around 4H/1H/daily structure, not to a realtime radar.

What differs between the two is only *configuration* — the detectors, the state
machine and the aggregator are shared code reading different windows and
thresholds. That is the point: a mode is a set of numbers, not a fork.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field, replace
from typing import Literal

from smc.market_context import DEFAULT_CONTEXT_CONFIG, ContextConfig
from smc.momentum import DEFAULT_CONFIG as DEFAULT_FLOW_CONFIG
from smc.momentum import MomentumConfig
from smc.momentum_events import DEFAULT_EVENT_CONFIG, EventConfig
from smc.pullback import DEFAULT_PULLBACK_CONFIG, PullbackConfig
from smc.pullback_completion import DEFAULT_COMPLETION_CONFIG, CompletionConfig
from smc.structural_path import DEFAULT_PATH_CONFIG, PathConfig

Mode = Literal["SCALP", "INTRADAY"]

MODES: tuple[Mode, ...] = ("SCALP", "INTRADAY")


@dataclass(frozen=True, slots=True)
class SituationConfig:
    """How the aggregator decides what is worth a human's attention.

    These are the funnel's last two stages: freshness, and the hard cap on how
    many situations may be surfaced at once. An empty radar is a valid answer —
    `max_surfaced` exists to stop the page filling with marginal candidates,
    not to guarantee it fills at all.
    """

    # An event older than this stops being "what just happened". Measured
    # against the *newest* event on the symbol, not the first.
    freshness_seconds: float = 180.0
    # A DEVELOPING card whose newest event is older than this goes STALE —
    # unless a structural event is actively extending the story. Ageing is not
    # development.
    developing_max_age_seconds: float = 300.0
    # How recently a structural event must have landed to keep an ageing card
    # alive.
    structural_extension_seconds: float = 180.0
    # A situation with nothing live left goes STALE rather than vanishing.
    stale_seconds: float = 420.0
    # Minimum smoothed event score before a situation can surface at all.
    min_score: float = 45.0
    # Weakest evidence tier allowed to surface. LOW qualifies as a situation
    # but not as one worth a human's attention.
    min_tier: str = "MEDIUM"
    # Hard cap per mode, after ranking. The funnel's final narrowing.
    max_surfaced: int = 8
    # Dwell between situation-state transitions, so a section cannot strobe.
    min_state_seconds: float = 20.0
    # A pullback/continuation situation must clear this to be surfaced; below
    # it the structure leaves no room worth watching.
    require_path: bool = True


@dataclass(frozen=True, slots=True)
class ScanProfile:
    """Everything one mode needs, assembled once at import."""

    mode: Mode
    # Timeframes whose structure the slow lane must have for this mode.
    context_timeframes: tuple[str, ...]
    # Which of those the target/POI search reads levels from, highest first.
    structure_timeframes: tuple[str, ...]
    # Where the mode's "micro" structural read comes from: the 1m map rebuilt
    # from the tick buffer, or the slow lane's 5M structure.
    micro_source: Literal["1m", "5M"]

    flow: MomentumConfig
    events: EventConfig
    context: ContextConfig
    pullback: PullbackConfig
    completion: CompletionConfig
    path: PathConfig
    situation: SituationConfig = field(default_factory=SituationConfig)


# ── SCALP ────────────────────────────────────────────────────────────────────
# Fast, shallow, tight. Fires on 1m/3m displacement, wants the pullback called
# early, and only cares about a path if it is decisively asymmetric — a scalp
# with a 1.5R structure is not worth the spread.

SCALP = ScanProfile(
    mode="SCALP",
    context_timeframes=("1H", "15M", "5M"),
    structure_timeframes=("15M", "5M"),
    micro_source="1m",
    flow=replace(
        DEFAULT_FLOW_CONFIG,
        fast_window="1m",
        slow_window="3m",
        trend_window="5m",
        min_displacement_fast_pct=0.45,
        min_displacement_slow_pct=0.80,
        min_rvol=2.0,
        stale_seconds=300.0,
    ),
    events=replace(
        DEFAULT_EVENT_CONFIG,
        fast_window="1m",
        primary_window="3m",
        volume_anomaly_fire_rvol=3.0,
        volume_anomaly_clear_rvol=1.8,
        displacement_fire_pct=0.80,
        displacement_clear_pct=0.35,
        event_ttl_seconds=180.0,
        min_state_seconds=20.0,
        new_window_seconds=90.0,
    ),
    # 1H leads, 15m follows, 5m is detail. The 4H regime is deliberately given
    # no vote: a scalp that waits for the 4H to agree is not a scalp.
    context=replace(
        DEFAULT_CONTEXT_CONFIG,
        weight_4h=0.0,
        weight_1h=3.0,
        weight_15m=2.0,
        weight_5m=1.0,
        read_ttl_seconds=1_800.0,
    ),
    pullback=replace(
        DEFAULT_PULLBACK_CONFIG,
        min_retrace_frac=0.20,
        healthy_retrace_frac=0.50,
        max_retrace_frac=0.75,
        cooling_rvol=1.00,
        poi_proximity_pct=0.35,
    ),
    completion=replace(
        DEFAULT_COMPLETION_CONFIG,
        renewed_displacement_pct=0.25,
        reexpansion_rvol=1.50,
        likely_min=4,
    ),
    # A scalp stop still has to clear the 1m noise band — that is what the
    # first forward-test cohort proved, with a median 55 seconds to
    # invalidation on 0.25% stops.
    path=replace(
        DEFAULT_PATH_CONFIG,
        min_rr=2.5,
        good_rr=4.0,
        invalidation_buffer_frac=0.12,
        min_risk_volatility_mult=1.5,
        min_risk_pct=0.35,
    ),
    # Scalp decays hard: a two-minute-old event is history, and a card that
    # has not produced anything new in five minutes is not "developing".
    situation=SituationConfig(
        freshness_seconds=120.0,
        developing_max_age_seconds=300.0,
        structural_extension_seconds=120.0,
        stale_seconds=300.0,
        min_score=50.0,
        min_tier="MEDIUM",
        max_surfaced=8,
        min_state_seconds=20.0,
    ),
)


# ── INTRADAY ─────────────────────────────────────────────────────────────────
# Slower and larger. Fires on 5m/15m displacement, wants the 4H regime to have
# an opinion, and tolerates a longer path with a wider structural stop.

INTRADAY = ScanProfile(
    mode="INTRADAY",
    context_timeframes=("4H", "1H", "15M"),
    structure_timeframes=("1H", "15M"),
    micro_source="5M",
    flow=replace(
        DEFAULT_FLOW_CONFIG,
        fast_window="5m",
        slow_window="15m",
        trend_window="15m",
        min_displacement_fast_pct=0.80,
        min_displacement_slow_pct=1.40,
        min_rvol=1.8,
        displacement_scale_pct=5.0,
        stale_seconds=900.0,
        invalid_ttl_seconds=600.0,
    ),
    events=replace(
        DEFAULT_EVENT_CONFIG,
        fast_window="5m",
        primary_window="15m",
        # A 15m relative-volume read is far steadier than a 3m one, so the bar
        # is lower in multiples while meaning more in traded value.
        volume_anomaly_fire_rvol=2.5,
        volume_anomaly_clear_rvol=1.5,
        volume_anomaly_scale_rvol=6.0,
        displacement_fire_pct=1.20,
        displacement_clear_pct=0.60,
        displacement_scale_pct=4.00,
        invalidation_opposing_pct=1.40,
        event_active_seconds=90.0,
        event_ttl_seconds=600.0,
        min_state_seconds=45.0,
        new_window_seconds=300.0,
        tracker_grace_seconds=300.0,
        faded_ttl_seconds=600.0,
    ),
    context=replace(
        DEFAULT_CONTEXT_CONFIG,
        weight_4h=3.0,
        weight_1h=2.0,
        weight_15m=1.0,
        weight_5m=0.0,
    ),
    pullback=replace(
        DEFAULT_PULLBACK_CONFIG,
        min_retrace_frac=0.25,
        healthy_retrace_frac=0.55,
        max_retrace_frac=0.70,
        cooling_rvol=1.10,
        opposing_move_pct=1.40,
        poi_proximity_pct=0.60,
    ),
    completion=replace(
        DEFAULT_COMPLETION_CONFIG,
        cooling_rvol=1.10,
        exhausted_opposing_pct=0.30,
        renewed_displacement_pct=0.50,
        reexpansion_rvol=1.40,
        likely_min=5,
    ),
    path=replace(
        DEFAULT_PATH_CONFIG,
        min_rr=1.8,
        good_rr=3.0,
        invalidation_buffer_frac=0.15,
        # A wider horizon needs a wider stop: 5m/15m events swing through more
        # noise than a 1m one.
        min_risk_volatility_mult=2.5,
        min_risk_pct=0.60,
    ),
    situation=SituationConfig(
        freshness_seconds=600.0,
        developing_max_age_seconds=1_800.0,
        structural_extension_seconds=900.0,
        stale_seconds=1_800.0,
        min_score=50.0,
        min_tier="MEDIUM",
        max_surfaced=8,
        min_state_seconds=45.0,
    ),
)


PROFILES: dict[Mode, ScanProfile] = {"SCALP": SCALP, "INTRADAY": INTRADAY}


def profile_for(mode: str) -> ScanProfile:
    """Profile by name, defaulting to scalp. Total, so an unknown mode from a
    query string degrades instead of raising."""
    name = mode.strip().upper()
    for candidate in MODES:
        if candidate == name:
            return PROFILES[candidate]
    return SCALP


#: Every timeframe the slow lane must fetch to serve both modes.
REQUIRED_TIMEFRAMES: tuple[str, ...] = ("4H", "1H", "15M", "5M")


def profile_hash(profile: ScanProfile) -> str:
    """Stable hash over everything in a profile that can move an outcome.

    Stamped onto every forward-test record so a result is always traceable to
    the exact detector configuration that produced it — and, just as
    important, so records from different configurations can never be pooled
    into one statistic. Changing a single threshold changes this hash.
    """
    payload = {
        "mode": profile.mode,
        "context_timeframes": list(profile.context_timeframes),
        "structure_timeframes": list(profile.structure_timeframes),
        "micro_source": profile.micro_source,
        "flow": asdict(profile.flow),
        "events": asdict(profile.events),
        "context": asdict(profile.context),
        "pullback": asdict(profile.pullback),
        "completion": asdict(profile.completion),
        "path": asdict(profile.path),
        "situation": asdict(profile.situation),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()[:12]
