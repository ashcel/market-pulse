"""Radar driver: observations → events → situations, and the snapshot the API serves.

The scanner is an **information compression engine**. Roughly 600 perpetuals
produce millions of observations an hour; the output is a handful of situations
worth opening. Every stage below exists to reduce uncertainty or reduce the
candidate set — a stage that does neither has no business in the pipeline.

    ~600 markets                       the ingested universe
      → rolling 1m/3m/5m/15m metrics   (`state.py`, raw observations)
      → durable events                 (`smc.momentum_events`, hysteretic)
      → directional + structural       (`smc.situation`, against cached context)
      → developing                     (pullback → completion → continuation)
      → surfaced                       (worth_watching, ranked, capped)

Both trading modes run over the same observations. `smc.scan_profiles` holds
every number that differs between them, so SCALP (1m/3m events under 1H/15m
context) and INTRADAY (5m/15m events under 4H/1H context) are two threshold
sets over one pipeline rather than two pipelines.

## Speeds

Fast lane, every `SCAN_INTERVAL_SECONDS`: aggregate, advance the flow machine,
mint events, read the pullback, assemble situations. All in memory, no I/O.

Slow lane, on its own timers: `context_cache` fetches 4H/1H/15m/5m klines and
computes structure. The fast lane only ever *reads* it, via dict lookups, and
never waits for it.

Micro structure has its own sub-cadence again: 1m candles folded from the tick
buffer for scalp, the slow lane's 5M structure for intraday.

Nothing here is persisted, and Postgres is never touched. `SituationJournal`
keeps a bounded in-memory record so the process can later be measured; that is
a research artifact, not a system of record.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field

from smc.market_context import MARKET_CONTEXT_VERSION
from smc.micro_structure import MicroStructureRead, is_new_break, read_micro_structure
from smc.momentum import (
    MOMENTUM_VERSION,
    Candidate,
    advance_candidate,
    detect_momentum,
    expire_candidate,
    open_candidate,
    pressure_label,
    should_drop,
    signed_change,
    window_rvol,
)
from smc.momentum_events import (
    MOMENTUM_EVENTS_VERSION,
    MarketEvent,
    SymbolTracker,
    advance_tracker,
    should_drop_tracker,
    structural_event,
    structural_events,
)
from smc.scan_profiles import MODES, PROFILES, Mode, ScanProfile, profile_for
from smc.situation import Situation, SituationState, advance_situation, rank_situations, surfaced
from smc.situation_journal import JOURNAL_VERSION, SituationJournal

from app.momentum import config as cfg
from app.momentum.context_cache import ContextCache
from app.momentum.ingestor import MomentumIngestor
from app.momentum.state import MarketStateStore, WindowMetrics

logger = logging.getLogger("momentum.scanner")

#: Lifecycle states the UI groups surfaced situations by, in lifecycle order.
ACTIVE_STATES: tuple[SituationState, ...] = (
    "NEW",
    "DEVELOPING",
    "PULLBACK",
    "PULLBACK_COMPLETION",
    "CONTINUATION_CANDIDATE",
)


@dataclass(frozen=True, slots=True)
class FunnelCounts:
    """How many candidates survived each stage of the last sweep.

    Shipped to the UI on purpose: when the radar is empty, the funnel is the
    difference between "nothing is happening" and "something upstream is
    broken". It is also the honest answer to "why am I only seeing six cards".
    """

    universe: int
    tracked: int
    events: int
    qualified: int
    directional: int
    structural: int
    developing: int
    surfaced: int


@dataclass(frozen=True, slots=True)
class RadarEntry:
    """One card: the compressed situation plus the raw flow behind it.

    `pressure` ("heavy sell pressure" and friends) rides along as *secondary
    telemetry only* — the most reactive string the radar produces, deliberately
    never a headline.
    """

    situation: Situation
    metrics: WindowMetrics
    headline: MarketEvent | None
    pressure: str


@dataclass(frozen=True, slots=True)
class RadarSnapshot:
    updated_at: float
    mode: Mode
    version: str
    events_version: str
    context_version: str
    journal_version: str
    universe_size: int
    tracked: int
    connected: bool
    # Which transport is feeding the store: "ws", "rest", or "starting".
    feed: str
    # True until the store has enough history for the working windows.
    warming_up: bool
    funnel: FunnelCounts
    # The surfaced situations, ranked. Deliberately short — often empty.
    situations: list[RadarEntry] = field(default_factory=list)
    # Recently invalidated or gone quiet; collapsed in the UI.
    closed: list[RadarEntry] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return len(self.situations)


@dataclass
class ModeState:
    """One trading mode's registries. Separate per mode because the same tape
    is a different situation at a different horizon."""

    profile: ScanProfile
    candidates: dict[str, Candidate] = field(default_factory=dict)
    trackers: dict[str, SymbolTracker] = field(default_factory=dict)
    situations: dict[str, Situation] = field(default_factory=dict)
    journal: SituationJournal = field(default_factory=SituationJournal)


class MomentumScanner:
    """Per-mode registries, and the evaluation tick that drives all of them."""

    def __init__(
        self,
        store: MarketStateStore,
        ingestor: MomentumIngestor,
        context_cache: ContextCache | None = None,
    ) -> None:
        self.store = store
        self.ingestor = ingestor
        self.context_cache = context_cache if context_cache is not None else ContextCache()
        self.modes: dict[str, ModeState] = {
            mode: ModeState(profile=PROFILES[mode]) for mode in MODES
        }
        self._metrics: dict[str, WindowMetrics] = {}
        # Last 1m structure read per symbol (scalp's micro source), and when.
        self._micro: dict[str, tuple[float, MicroStructureRead | None]] = {}
        # When a 1m CHoCH last printed, and which way.
        self._micro_choch: dict[str, tuple[float, str]] = {}
        self._snapshots: dict[str, RadarSnapshot] = {
            mode: _empty_snapshot(mode) for mode in MODES
        }
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self._revision = 0

    # ── lifecycle ───────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._loop(), name="momentum-scanner")

    async def stop(self) -> None:
        self._stopping = True
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    async def _loop(self) -> None:
        while not self._stopping:
            try:
                self.tick(time.time())
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[momentum] scan tick failed")
            await asyncio.sleep(cfg.SCAN_INTERVAL_SECONDS)

    # ── evaluation ──────────────────────────────────────────────────────────

    def tick(self, now: float) -> RadarSnapshot:
        """One sweep across every mode. Separated from `_loop` so tests can
        drive it with an explicit clock; returns the default mode's snapshot
        for convenience."""
        metrics_list = self.store.snapshot_metrics(now)
        self._metrics = {m.symbol: m for m in metrics_list}
        warming = sum(1 for m in metrics_list if m.warming_up)

        # Micro structure is mode-independent and expensive, so it is read once
        # per symbol per sub-cadence and shared by both modes.
        for symbol in self._interesting(metrics_list):
            self._read_micro(symbol, now)

        for mode, state in self.modes.items():
            self._sweep_mode(state, metrics_list, now)
            self._snapshots[mode] = self._build_snapshot(
                state, now, tracked=len(metrics_list), warming=warming
            )

        # Tell the slow lane which symbols are worth kline requests. Declaring
        # interest is a dict write; fetching happens on its own timer.
        interest = {symbol for state in self.modes.values() for symbol in state.trackers}
        self.context_cache.track(interest, now)

        self._revision += 1
        return self._snapshots["SCALP"]

    def _interesting(self, metrics_list: list[WindowMetrics]) -> set[str]:
        """Symbols any mode is already tracking — the only ones worth spending
        a micro-structure read on."""
        tracked: set[str] = set()
        for state in self.modes.values():
            tracked |= set(state.trackers)
        return tracked & {m.symbol for m in metrics_list}

    def _sweep_mode(
        self, state: ModeState, metrics_list: list[WindowMetrics], now: float
    ) -> None:
        profile = state.profile
        seen: set[str] = set()

        for metrics in metrics_list:
            seen.add(metrics.symbol)
            existing = state.trackers.get(metrics.symbol)
            structural = self._advance_flow(state, metrics, now)
            if existing is not None:
                structural += self._micro_events(state, metrics.symbol, now)

            # Volume cooling is only meaningful while price is actually
            # retracing, so the event layer needs to know whether it is.
            previous = state.situations.get(metrics.symbol)
            in_pullback = previous is not None and previous.state in (
                "PULLBACK",
                "PULLBACK_COMPLETION",
            )

            tracker = advance_tracker(
                existing,
                metrics,
                now,
                profile.events,
                structural=structural,
                context=self.context_cache.get(metrics.symbol, profile.mode),
                context_config=profile.context,
                in_pullback=in_pullback,
            )
            if tracker is None:
                continue
            state.trackers[metrics.symbol] = tracker
            situation = self._advance_situation(state, tracker, metrics, now)
            state.situations[metrics.symbol] = situation
            state.journal.observe(situation, metrics.price, now)

        # Symbols that stopped ticking altogether never reach the loop above.
        for symbol, candidate in list(state.candidates.items()):
            if symbol not in seen and not candidate.is_terminal:
                state.candidates[symbol] = expire_candidate(candidate, now, profile.flow)
            if should_drop(state.candidates[symbol], now, profile.flow):
                del state.candidates[symbol]

        for symbol, tracker in list(state.trackers.items()):
            if should_drop_tracker(tracker, now, profile.events):
                del state.trackers[symbol]
                state.situations.pop(symbol, None)

    def _advance_flow(
        self, state: ModeState, metrics: WindowMetrics, now: float
    ) -> list[MarketEvent]:
        """Runs the flow state machine for one symbol and returns the discrete
        structural events this tick produced.

        The machine's *states* are internal: they supply the impulse leg the
        pullback detector measures, and their transitions become events.
        """
        previous = state.candidates.get(metrics.symbol)
        if previous is not None and not previous.is_terminal:
            current = advance_candidate(previous, metrics, now, state.profile.flow)
            state.candidates[metrics.symbol] = current
            return structural_events(previous, current, state.profile.events)

        signal = detect_momentum(metrics, state.profile.flow)
        if signal is None:
            return []
        state.candidates[metrics.symbol] = open_candidate(metrics, signal)
        # Opening a candidate is not itself an event: the conditions that made
        # it fire are already covered by the event layer.
        return []

    def _read_micro(self, symbol: str, now: float) -> None:
        """1m structure for one tracked symbol, on its own sub-cadence.

        A 1m read cannot change more than once a minute, and folding the tick
        buffer into candles is far too expensive to do for the whole universe
        every tick.
        """
        last_at, previous = self._micro.get(symbol, (0.0, None))
        if now - last_at < cfg.MICRO_STRUCTURE_INTERVAL_SECONDS:
            return
        candles = self.store.micro_candles(symbol, now, cfg.MICRO_STRUCTURE_MINUTES)
        current = read_micro_structure(candles)
        self._micro[symbol] = (now, current if current is not None else previous)
        if current is not None and is_new_break(previous, current) and current.direction:
            self._micro_choch[symbol] = (now, current.direction)

    def _micro_events(
        self, state: ModeState, symbol: str, now: float
    ) -> list[MarketEvent]:
        """The mode's micro structural break, as an event.

        Scalp reads the 1m map rebuilt from ticks; intraday reads the slow
        lane's 5M structure — the same question at each mode's own resolution.
        """
        profile = state.profile
        if profile.micro_source == "1m":
            printed = self._micro_choch.get(symbol)
            if printed is None or now - printed[0] > cfg.SCAN_INTERVAL_SECONDS * 2:
                return []
            direction = printed[1]
        else:
            maps = self.context_cache.maps(symbol, ("5M",))
            if not maps or maps[0].event != "choch":
                return []
            label = maps[0].event_label
            direction = "bullish" if label in ("HH", "HL") else "bearish"
            tracker = state.trackers.get(symbol)
            # The 5M read is slow-moving, so dedupe against what is already
            # live rather than re-minting the same break every tick.
            if tracker is not None and any(e.type == "CHOCH" for e in tracker.events):
                return []
        return [
            structural_event(
                symbol,
                "CHOCH",
                direction,  # type: ignore[arg-type]
                now,
                unit=profile.micro_source,
                config=profile.events,
            )
        ]

    def _advance_situation(
        self, state: ModeState, tracker: SymbolTracker, metrics: WindowMetrics, now: float
    ) -> Situation:
        """Measures the flow the aggregator needs, then composes.

        Every measurement is taken here rather than inside `smc.situation` so
        the aggregator stays a combiner and cannot quietly become a detector.
        """
        profile = state.profile
        candidate = state.candidates.get(metrics.symbol)
        direction = tracker.direction
        fast = profile.flow.fast_window

        directional_move = 0.0
        opposing_move = 0.0
        if direction is not None:
            signed = signed_change(metrics, direction, fast) or 0.0
            directional_move = signed
            opposing_move = max(0.0, -signed)

        rvol = window_rvol(metrics, fast) or window_rvol(metrics, profile.flow.slow_window)
        micro = self._micro_choch.get(metrics.symbol)
        micro_choch = (
            micro is not None
            and direction is not None
            and micro[1] == direction
            and now - micro[0] <= profile.events.event_active_seconds
        )

        return advance_situation(
            state.situations.get(metrics.symbol),
            tracker,
            candidate,
            price=metrics.price,
            pullback_extreme=candidate.pullback_extreme if candidate is not None else None,
            volume_ratio=rvol,
            opposing_move_pct=opposing_move,
            directional_move_pct=directional_move,
            directional_rvol=rvol,
            micro_choch=micro_choch,
            volatility_pct=metrics.volatility_1m_pct,
            maps=self.context_cache.maps(metrics.symbol, profile.structure_timeframes),
            now=now,
            profile=profile,
        )

    # ── snapshot ────────────────────────────────────────────────────────────

    def _entry(self, situation: Situation) -> RadarEntry | None:
        metrics = self._metrics.get(situation.symbol)
        if metrics is None:
            return None
        return RadarEntry(
            situation=situation,
            metrics=metrics,
            headline=situation.headline,
            pressure=pressure_label(
                self.modes[situation.mode].candidates[situation.symbol]
            )
            if situation.symbol in self.modes[situation.mode].candidates
            else "",
        )

    def _build_snapshot(
        self, state: ModeState, now: float, tracked: int, warming: int
    ) -> RadarSnapshot:
        profile = state.profile
        situations = list(state.situations.values())
        shown = surfaced(situations, profile)
        closed = rank_situations([s for s in situations if s.is_terminal])[:8]

        counts: dict[str, int] = {}
        for situation in situations:
            counts[situation.state] = counts.get(situation.state, 0) + 1

        developing = sum(
            1
            for s in situations
            if s.state in ("PULLBACK", "PULLBACK_COMPLETION", "CONTINUATION_CANDIDATE")
        )
        funnel = FunnelCounts(
            universe=len(self.store),
            tracked=tracked,
            events=sum(1 for t in state.trackers.values() if t.events),
            # "Qualified" is the funnel's real narrowing: a relationship
            # between independent families, not a lone observation.
            qualified=sum(1 for t in state.trackers.values() if t.qualification.qualified),
            directional=sum(1 for s in situations if s.direction is not None),
            structural=sum(1 for s in situations if s.targets),
            developing=developing,
            surfaced=len(shown),
        )

        return RadarSnapshot(
            updated_at=now,
            mode=profile.mode,
            version=MOMENTUM_VERSION,
            events_version=MOMENTUM_EVENTS_VERSION,
            context_version=MARKET_CONTEXT_VERSION,
            journal_version=JOURNAL_VERSION,
            universe_size=len(self.store),
            tracked=tracked,
            connected=self.ingestor.connected,
            feed=self.ingestor.mode or "starting",
            # Warming up only while a majority of the universe still lacks the
            # working windows — a few fresh listings must not pin the radar.
            warming_up=tracked == 0 or warming > tracked / 2,
            funnel=funnel,
            situations=[e for e in (self._entry(s) for s in shown) if e is not None],
            closed=[e for e in (self._entry(s) for s in closed) if e is not None],
            counts=counts,
        )

    # ── reads ───────────────────────────────────────────────────────────────

    def snapshot(self, mode: str = "SCALP") -> RadarSnapshot:
        return self._snapshots.get(profile_for(mode).mode, self._snapshots["SCALP"])

    @property
    def revision(self) -> int:
        return self._revision

    def state_for(self, mode: str = "SCALP") -> ModeState:
        return self.modes[profile_for(mode).mode]

    def candidate(self, symbol: str, mode: str = "SCALP") -> Candidate | None:
        return self.state_for(mode).candidates.get(symbol.strip().upper())

    def tracker(self, symbol: str, mode: str = "SCALP") -> SymbolTracker | None:
        return self.state_for(mode).trackers.get(symbol.strip().upper())

    def situation(self, symbol: str, mode: str = "SCALP") -> Situation | None:
        return self.state_for(mode).situations.get(symbol.strip().upper())

    def journal(self, mode: str = "SCALP") -> SituationJournal:
        return self.state_for(mode).journal


def _empty_snapshot(mode: str) -> RadarSnapshot:
    return RadarSnapshot(
        updated_at=time.time(),
        mode=profile_for(mode).mode,
        version=MOMENTUM_VERSION,
        events_version=MOMENTUM_EVENTS_VERSION,
        context_version=MARKET_CONTEXT_VERSION,
        journal_version=JOURNAL_VERSION,
        universe_size=0,
        tracked=0,
        connected=False,
        feed="starting",
        warming_up=True,
        funnel=FunnelCounts(0, 0, 0, 0, 0, 0, 0, 0),
    )


# ── process-wide singletons ─────────────────────────────────────────────────
# One store, one connection, one scanner per process. The API service runs a
# single uvicorn worker, so this is the whole plane; if it ever grows workers,
# the radar must move behind one of them (or into the arq worker) rather than
# being duplicated per process.

_store = MarketStateStore()
_ingestor = MomentumIngestor(_store)
_context_cache = ContextCache()
_scanner = MomentumScanner(_store, _ingestor, context_cache=_context_cache)


def get_scanner() -> MomentumScanner:
    return _scanner


def get_context_cache() -> ContextCache:
    return _context_cache


async def start_momentum_radar() -> None:
    """Called from the FastAPI lifespan. A no-op when `MOMENTUM_ENABLED=0`."""
    if not cfg.ENABLED:
        logger.info("[momentum] disabled by config; radar not started")
        return
    _ingestor.start()
    _scanner.start()
    if cfg.CONTEXT_ENABLED:
        _context_cache.start()
    logger.info(
        "[momentum] radar started (flow %s, events %s, context %s, journal %s)",
        MOMENTUM_VERSION,
        MOMENTUM_EVENTS_VERSION,
        MARKET_CONTEXT_VERSION if cfg.CONTEXT_ENABLED else "off",
        JOURNAL_VERSION,
    )


async def stop_momentum_radar() -> None:
    await _scanner.stop()
    await _context_cache.stop()
    await _ingestor.stop()
