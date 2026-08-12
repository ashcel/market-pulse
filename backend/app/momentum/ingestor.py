"""Realtime feed for the radar — one all-market source, two transports.

Preferred transport is a single Binance websocket:
`wss://fstream.binance.com/ws/!ticker@arr` pushes an array of 24h tickers for
every USDS-M perpetual once a second. One connection covers the full universe:
no per-symbol subscription, no REST fan-out, no second connection duplicating
what the browser's `binance-live-feed.ts` already does for a single token page.

Some networks reach Binance's REST API fine but never receive futures stream
data — the socket opens, `SUBSCRIBE` is even acknowledged, and then nothing
arrives. **This VPS is one of them** (verified 2026-08-11: spot streams deliver,
`fstream` control frames ack, market frames never land). So the ingestor probes
the websocket at startup and, when no frame arrives inside `WS_PROBE_SECONDS`,
falls back to polling `GET /fapi/v1/ticker/24hr` with no `symbol` — the same
one-call, whole-market snapshot `app.worker.binance.fetch_perp_ticker_24h_all`
already serves the patterns pass, through the same shared weight limiter. Still
one request for the entire universe, never one per symbol.

`MOMENTUM_FEED` forces the choice (`auto` | `ws` | `rest`); `auto` is the
default and logs which transport it settled on.

Resilience follows the same "degrade, never crash" convention as
`app.worker.binance`: a dropped connection reconnects with exponential backoff,
a wedged connection is dropped and retried, a failed poll is skipped, and a
malformed frame is ignored. While a feed is down the store simply stops
receiving samples — candidates age out through the state machine's own staleness
rule rather than through anything special here.

`websockets` ships with `uvicorn[standard]`, so the preferred path adds no
dependency.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Literal

import websockets

from app.momentum import config as cfg
from app.momentum.state import MarketStateStore, TickerFrame, parse_ticker_array
from app.worker.binance import fetch_perp_ticker_24h_all

logger = logging.getLogger("momentum.ingestor")

FeedMode = Literal["ws", "rest"]

# Consecutive websocket attempts that connect but deliver nothing before the
# ingestor gives up on the transport and switches to polling for good.
WS_STALL_TOLERANCE = 2


class MomentumIngestor:
    """Owns the market feed and pushes frames into `MarketStateStore`."""

    def __init__(self, store: MarketStateStore) -> None:
        self.store = store
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self.connected = False
        self.mode: FeedMode | None = None
        self.connect_count = 0
        self.last_error: str | None = None

    # ── lifecycle ───────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="momentum-ingestor")

    async def stop(self) -> None:
        self._stopping = True
        self.connected = False
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    # ── transport selection ─────────────────────────────────────────────────

    async def _run(self) -> None:
        configured = cfg.FEED_MODE
        if configured in ("ws", "rest"):
            self.mode = configured  # type: ignore[assignment]
        else:
            self.mode = "ws" if await self._websocket_delivers() else "rest"
            logger.info("[momentum] feed auto-selected: %s", self.mode)

        if self.mode == "ws":
            await self._websocket_loop()
        else:
            await self._rest_loop()

    async def _websocket_delivers(self) -> bool:
        """One probe: can this host actually receive stream frames? A socket
        that opens but never delivers is exactly the failure mode this guards,
        so the probe waits for a *frame*, not for the handshake."""
        try:
            async with websockets.connect(
                cfg.WS_URL, open_timeout=cfg.WS_PROBE_SECONDS, max_size=8 * 1024 * 1024
            ) as socket:
                raw = await asyncio.wait_for(socket.recv(), timeout=cfg.WS_PROBE_SECONDS)
                self._handle(raw)
                return True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.info(
                "[momentum] websocket probe failed (%s: %s); falling back to REST polling",
                type(exc).__name__,
                exc,
            )
            return False

    # ── websocket transport ─────────────────────────────────────────────────

    async def _websocket_loop(self) -> None:
        backoff = cfg.WS_RECONNECT_MIN_SECONDS
        stalls = 0
        while not self._stopping:
            try:
                await self._consume()
                backoff = cfg.WS_RECONNECT_MIN_SECONDS
                stalls = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.connected = False
                self.last_error = f"{type(exc).__name__}: {exc}"
                if isinstance(exc, TimeoutError):
                    stalls += 1
                logger.warning(
                    "[momentum] stream dropped (%s); retry in %.0fs", self.last_error, backoff
                )
            if self._stopping:
                return
            if stalls >= WS_STALL_TOLERANCE and cfg.FEED_MODE == "auto":
                logger.warning("[momentum] websocket keeps stalling; switching to REST polling")
                self.mode = "rest"
                await self._rest_loop()
                return
            await asyncio.sleep(backoff)
            backoff = min(cfg.WS_RECONNECT_MAX_SECONDS, backoff * 2)

    async def _consume(self) -> None:
        async with websockets.connect(
            cfg.WS_URL, ping_interval=20, ping_timeout=20, max_size=8 * 1024 * 1024
        ) as socket:
            self.connected = True
            self.connect_count += 1
            self.last_error = None
            logger.info("[momentum] connected to %s", cfg.WS_URL)
            try:
                while not self._stopping:
                    raw = await asyncio.wait_for(socket.recv(), timeout=cfg.WS_STALL_SECONDS)
                    self._handle(raw)
            finally:
                self.connected = False

    def _handle(self, raw: str | bytes) -> None:
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            return
        # A bare `/ws/<stream>` connection delivers the payload directly; a
        # combined `/stream?streams=` connection wraps it in `{stream, data}`.
        # Accept both so `MOMENTUM_WS_URL` can be pointed at either form.
        if isinstance(payload, dict):
            payload = payload.get("data")
        frames = parse_ticker_array(payload)
        if not frames:
            return
        self.store.ingest_batch(frames, time.time())

    # ── REST polling transport ──────────────────────────────────────────────

    async def _rest_loop(self) -> None:
        """One whole-market ticker call per interval, through the shared
        per-IP weight limiter. `REST_POLL_SECONDS` is the knob that trades
        radar resolution against Binance request weight — the endpoint costs 40
        weight per call whatever the universe size."""
        logger.info("[momentum] polling /fapi/v1/ticker/24hr every %.0fs", cfg.REST_POLL_SECONDS)
        while not self._stopping:
            started = time.monotonic()
            try:
                rows = await fetch_perp_ticker_24h_all()
                frames = [
                    TickerFrame(
                        symbol=row.ticker,
                        price=row.last_price,
                        quote_volume_24h=row.quote_volume24h,
                        trades_24h=row.trades24h,
                        change_24h_pct=row.change_percent24h,
                        event_ts=time.time(),
                    )
                    for row in rows
                    if row.last_price > 0 and row.quote_volume24h >= cfg.MIN_QUOTE_VOLUME_24H
                ]
                if frames:
                    self.store.ingest_batch(frames, time.time())
                    self.connected = True
                    self.connect_count += 1
                    self.last_error = None
                else:
                    self.connected = False
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.connected = False
                self.last_error = f"{type(exc).__name__}: {exc}"
                logger.warning("[momentum] ticker poll failed (%s)", self.last_error)
            elapsed = time.monotonic() - started
            # Always leave a gap proportional to the configured interval, so a
            # slow or failing call can never turn this into a hot loop.
            await asyncio.sleep(
                max(cfg.REST_POLL_SECONDS - elapsed, cfg.REST_POLL_SECONDS * 0.1)
            )
