"""Env-overridable knobs for the MOMENTUM RADAR plane.

Thresholds live in two pure, tested config objects and are re-exported here so
a deployment can retune either without a code change:

* `smc.momentum.MomentumConfig` — flow detection and the underlying state
  machine, via `MOMENTUM_<FIELD>` env vars.
* `smc.momentum_events.EventConfig` — the durable event/UI-state layer
  (hysteresis bands, TTLs, dwell times, ranking stability), via
  `MOMENTUM_EVENT_<FIELD>`.

This module also owns the *runtime* knobs: how the ingestor and scanner behave.

Nothing here is persisted and nothing reads Postgres: the radar is an
in-memory plane by design (see `app.momentum.state`).
"""

from __future__ import annotations

import os
from dataclasses import fields, replace
from typing import Any

from smc.market_context import DEFAULT_CONTEXT_CONFIG, ContextConfig, ContextTimeframe
from smc.momentum import DEFAULT_CONFIG, MomentumConfig
from smc.momentum_events import DEFAULT_EVENT_CONFIG, EventConfig


def _env_float(name: str, fallback: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return fallback
    try:
        return float(raw)
    except ValueError:
        return fallback


def _env_int(name: str, fallback: int) -> int:
    return int(_env_float(name, float(fallback)))


def _env_bool(name: str, fallback: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return fallback
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_detector_config() -> MomentumConfig:
    """`MomentumConfig` with any `MOMENTUM_<FIELD_UPPER>` env override applied.

    e.g. `MOMENTUM_MIN_RVOL=2.5` retunes the participation gate, and
    `MOMENTUM_REQUIRE_ALIGNED_1M_3M=0` drops the whipsaw filter. Weights are
    validated on construction, so an override set that no longer sums to 1.0
    fails loudly at import rather than silently skewing every score.
    """
    overrides = _overrides(MomentumConfig, DEFAULT_CONFIG, "MOMENTUM_")
    return replace(DEFAULT_CONFIG, **overrides) if overrides else DEFAULT_CONFIG


def load_event_config() -> EventConfig:
    """`EventConfig` with any `MOMENTUM_EVENT_<FIELD_UPPER>` override applied.

    e.g. `MOMENTUM_EVENT_VOLUME_ANOMALY_FIRE_RVOL=4` makes the radar pickier
    about what counts as an anomaly, and `MOMENTUM_EVENT_MIN_STATE_SECONDS=45`
    makes the New/Developing/Confirmed sections even calmer. The fire/clear
    ordering and TTL invariants are validated on construction, so an override
    set that would break the hysteresis fails loudly at import.
    """
    overrides = _overrides(EventConfig, DEFAULT_EVENT_CONFIG, "MOMENTUM_EVENT_")
    return replace(DEFAULT_EVENT_CONFIG, **overrides) if overrides else DEFAULT_EVENT_CONFIG


def load_context_config() -> ContextConfig:
    """`ContextConfig` with any `MOMENTUM_CONTEXT_<FIELD_UPPER>` override.

    e.g. `MOMENTUM_CONTEXT_WEIGHT_4H=4` makes the macro regime dominate the HTF
    badge, `MOMENTUM_CONTEXT_FLIP_CONFIRMATIONS=3` makes the badge even
    stickier.
    """
    overrides = _overrides(ContextConfig, DEFAULT_CONTEXT_CONFIG, "MOMENTUM_CONTEXT_")
    return replace(DEFAULT_CONTEXT_CONFIG, **overrides) if overrides else DEFAULT_CONTEXT_CONFIG


def _overrides(spec_type: type, defaults: Any, prefix: str) -> dict[str, Any]:
    """Reads `<PREFIX><FIELD_UPPER>` for every field, typed off the default."""
    overrides: dict[str, Any] = {}
    for spec in fields(spec_type):
        env_name = f"{prefix}{spec.name.upper()}"
        if os.getenv(env_name) is None:
            continue
        current = getattr(defaults, spec.name)
        if isinstance(current, bool):
            overrides[spec.name] = _env_bool(env_name, current)
        elif isinstance(current, int):
            overrides[spec.name] = _env_int(env_name, current)
        else:
            overrides[spec.name] = _env_float(env_name, current)
    return overrides


# ── ingestor ────────────────────────────────────────────────────────────────
# One Binance USDS-M futures connection carries the whole perp universe:
# `!ticker@arr` pushes a 24h rolling ticker for every symbol once a second.
# That is deliberately the *only* market connection this plane opens — no
# per-symbol subscription, no REST call per symbol (see `ingestor.py`).
#
# `auto` probes the websocket at startup and falls back to whole-market REST
# polling when this host cannot receive futures stream frames (which is the
# case on the production VPS). `ws` / `rest` pin the transport.
FEED_MODE = os.getenv("MOMENTUM_FEED", "auto").strip().lower()
WS_URL = os.getenv("MOMENTUM_WS_URL", "wss://fstream.binance.com/ws/!ticker@arr")
# How long the startup probe waits for a *frame* (not a handshake) before
# giving up on the websocket.
WS_PROBE_SECONDS = _env_float("MOMENTUM_WS_PROBE_SECONDS", 20.0)
# REST fallback cadence. `/fapi/v1/ticker/24hr` with no symbol costs 40 request
# weight per call whatever the universe size, so this is the knob that trades
# radar resolution against the shared per-IP budget (5s -> 480 weight/min).
REST_POLL_SECONDS = _env_float("MOMENTUM_REST_POLL_SECONDS", 5.0)
WS_RECONNECT_MIN_SECONDS = _env_float("MOMENTUM_WS_RECONNECT_MIN_SECONDS", 1.0)
WS_RECONNECT_MAX_SECONDS = _env_float("MOMENTUM_WS_RECONNECT_MAX_SECONDS", 60.0)
# No frame for this long means the stream is wedged — drop and reconnect.
WS_STALL_SECONDS = _env_float("MOMENTUM_WS_STALL_SECONDS", 90.0)
# Only USDT-quoted perps; the radar's whole universe convention elsewhere.
QUOTE_SUFFIX = os.getenv("MOMENTUM_QUOTE_SUFFIX", "USDT")
# Zero-sanity liquidity floor, matching `scan_universe_all`'s intent: skip
# delisting/dead books rather than rank noise.
MIN_QUOTE_VOLUME_24H = _env_float("MOMENTUM_MIN_QUOTE_VOLUME_24H", 2_000_000.0)

# ── state store ─────────────────────────────────────────────────────────────
# Sample cadence and retention. 1s cadence x 30min of history is ~1800 samples
# per symbol; at ~600 perps that would be hundreds of MB as Python objects, so
# `SymbolState` packs them into parallel `array('d')` buffers instead.
SAMPLE_MIN_INTERVAL_SECONDS = _env_float("MOMENTUM_SAMPLE_MIN_INTERVAL_SECONDS", 1.0)
HISTORY_SECONDS = _env_float("MOMENTUM_HISTORY_SECONDS", 1_800.0)
# Rolling window the relative-volume/trade-rate baselines are measured over.
BASELINE_SECONDS = _env_float("MOMENTUM_BASELINE_SECONDS", 900.0)
# An observed baseline needs this much *elapsed span* (and a handful of
# samples) behind it; below that the store falls back to the 24h-average prior
# (quoteVolume24h / 1440 per minute). Expressed as a span, not a sample count,
# so it means the same thing whether the feed ticks every 1s or every 5s.
BASELINE_MIN_SPAN_SECONDS = _env_float("MOMENTUM_BASELINE_MIN_SPAN_SECONDS", 600.0)
BASELINE_MIN_SAMPLES = _env_int("MOMENTUM_BASELINE_MIN_SAMPLES", 10)

# ── slow lane: higher-timeframe context ─────────────────────────────────────
# The context cache runs on its own timer and is deliberately stingy: it only
# fetches klines for symbols the fast lane is tracking, one timeframe at a
# time, under a per-pass budget. See `app.momentum.context_cache`.
CONTEXT_ENABLED = _env_bool("MOMENTUM_CONTEXT_ENABLED", True)
CONTEXT_TICK_SECONDS = _env_float("MOMENTUM_CONTEXT_TICK_SECONDS", 15.0)
# Per-timeframe refresh cadence. A 4H bar closes every four hours — refreshing
# it every 15 minutes is already far more often than it can change.
CONTEXT_REFRESH_SECONDS: dict[ContextTimeframe, float] = {
    "4H": _env_float("MOMENTUM_CONTEXT_REFRESH_4H", 900.0),
    "1H": _env_float("MOMENTUM_CONTEXT_REFRESH_1H", 300.0),
    "15M": _env_float("MOMENTUM_CONTEXT_REFRESH_15M", 120.0),
    "5M": _env_float("MOMENTUM_CONTEXT_REFRESH_5M", 60.0),
}
# Bars per fetch. 200 x 4H is ~33 days of regime, and stays in the cheap
# request-weight tier.
CONTEXT_KLINE_LIMIT = _env_int("MOMENTUM_CONTEXT_KLINE_LIMIT", 200)
# Ceiling on how many symbols carry context at once, and how hard a single
# pass may hit the API.
CONTEXT_MAX_SYMBOLS = _env_int("MOMENTUM_CONTEXT_MAX_SYMBOLS", 60)
CONTEXT_MAX_FETCHES_PER_TICK = _env_int("MOMENTUM_CONTEXT_MAX_FETCHES_PER_TICK", 24)
CONTEXT_CONCURRENCY = _env_int("MOMENTUM_CONTEXT_CONCURRENCY", 4)
# How long a symbol keeps its context after the fast lane stops tracking it.
CONTEXT_INTEREST_TTL_SECONDS = _env_float("MOMENTUM_CONTEXT_INTEREST_TTL_SECONDS", 600.0)

# ── scanner ─────────────────────────────────────────────────────────────────
# How often the momentum engine + state machine sweep the store. The ingestor
# runs independently at 1s; this is the evaluation tick.
SCAN_INTERVAL_SECONDS = _env_float("MOMENTUM_SCAN_INTERVAL_SECONDS", 2.0)
# Per-section cap in the API payload.
TOP_K = _env_int("MOMENTUM_TOP_K", 24)
# 1m micro-structure (CHoCH) sub-cadence, for tracked symbols only. A 1m
# structure read cannot change more than once a minute, so reading it every
# few seconds would be pure waste.
MICRO_STRUCTURE_INTERVAL_SECONDS = _env_float("MOMENTUM_MICRO_INTERVAL_SECONDS", 20.0)
MICRO_STRUCTURE_MINUTES = _env_int("MOMENTUM_MICRO_MINUTES", 40)
# SSE push cadence to the browser.
STREAM_INTERVAL_SECONDS = _env_float("MOMENTUM_STREAM_INTERVAL_SECONDS", 2.0)
STREAM_HEARTBEAT_SECONDS = _env_float("MOMENTUM_STREAM_HEARTBEAT_SECONDS", 20.0)
ENABLED = _env_bool("MOMENTUM_ENABLED", True)
