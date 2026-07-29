import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import websockets
from sqlalchemy.ext.asyncio import AsyncSession

from app.binance_review.crypto import decrypt as review_decrypt
from app.binance_review.service import get_key as get_review_key

from .binance_client import BinanceExecClient
from .exec_key_crypto import decrypt as exec_decrypt
from .exec_key_service import get_exec_key

logger = logging.getLogger(__name__)


@dataclass
class _Listener:
    client: BinanceExecClient
    listen_key: str
    task: asyncio.Task[None] | None = None
    clients: set[asyncio.Queue[list[dict[str, Any]]]] = field(default_factory=set)
    positions: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    connected: bool = False


class PositionWSManager:
    def __init__(self) -> None:
        self._listeners: dict[str, _Listener] = {}
        self._lock = asyncio.Lock()

    def health_status(self) -> str:
        if not self._listeners:
            return "idle"
        return "connected" if all(x.connected for x in self._listeners.values()) else "reconnecting"

    async def start_listener(self, user_id: str, db: AsyncSession) -> None:
        async with self._lock:
            if user_id in self._listeners:
                return
            # Use mainnet (review key) for live positions display.
            # Fall back to the exec key if no review key exists.
            try:
                rk = await get_review_key(db, user_id)
                client = BinanceExecClient(
                    rk.api_key, review_decrypt(rk.encrypted_secret), testnet=False
                )
            except Exception:
                key = await get_exec_key(db, user_id)
                client = BinanceExecClient(
                    key.api_key, exec_decrypt(key.encrypted_secret), testnet=key.testnet
                )
            listen_key = await client.create_listen_key()
            listener = _Listener(client, listen_key)
            self._listeners[user_id] = listener
            listener.task = asyncio.create_task(self._run(user_id), name=f"position-ws:{user_id}")

    async def stop_listener(self, user_id: str) -> None:
        async with self._lock:
            listener = self._listeners.pop(user_id, None)
        if listener is None:
            return
        if listener.task is not None:
            listener.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await listener.task
        with contextlib.suppress(Exception):
            await listener.client.close_listen_key(listener.listen_key)

    def register_client(self, user_id: str, queue: asyncio.Queue[list[dict[str, Any]]]) -> None:
        listener = self._listeners.get(user_id)
        if listener is None:
            raise RuntimeError("Position listener is not running")
        listener.clients.add(queue)

    async def load_initial_positions(self, user_id: str) -> list[dict[str, Any]]:
        listener = self._listeners[user_id]
        listener.positions.clear()
        for row in await listener.client.get_positions():
            position = _normalize_position(row)
            if position["positionAmt"] != 0:
                key = (position["symbol"], str(row.get("positionSide", "BOTH")))
                listener.positions[key] = position
        return list(listener.positions.values())

    async def remove_client(self, user_id: str, queue: asyncio.Queue[list[dict[str, Any]]]) -> None:
        listener = self._listeners.get(user_id)
        if listener is None:
            return
        listener.clients.discard(queue)
        if not listener.clients:
            await self.stop_listener(user_id)

    async def _run(self, user_id: str) -> None:
        keepalive: asyncio.Task[None] | None = None
        try:
            while True:
                listener = self._listeners.get(user_id)
                if listener is None:
                    return
                if keepalive is None:
                    keepalive = asyncio.create_task(self._keepalive(user_id))
                ws_base = (
                    "wss://stream.binancefuture.com/ws"
                    if listener.client.testnet
                    else "wss://fstream.binance.com/ws"
                )
                try:
                    async with websockets.connect(
                        f"{ws_base}/{listener.listen_key}", ping_interval=20, ping_timeout=20
                    ) as socket:
                        listener.connected = True
                        async for message in socket:
                            self._handle_message(user_id, json.loads(message))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    listener.connected = False
                    logger.exception("Binance position stream disconnected for user %s", user_id)
                    await asyncio.sleep(5)
        finally:
            if keepalive is not None:
                keepalive.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await keepalive

    async def _keepalive(self, user_id: str) -> None:
        while True:
            await asyncio.sleep(30 * 60)
            listener = self._listeners.get(user_id)
            if listener is None:
                return
            try:
                await listener.client.keepalive_listen_key(listener.listen_key)
            except Exception:
                logger.exception("Binance listen key keepalive failed for user %s", user_id)

    def _handle_message(self, user_id: str, event: dict[str, Any]) -> None:
        if event.get("e") != "ACCOUNT_UPDATE":
            return
        listener = self._listeners.get(user_id)
        if listener is None:
            return
        for raw in event.get("a", {}).get("P", []):
            position = _normalize_position(raw)
            key = (position["symbol"], str(raw.get("ps", "BOTH")))
            if position["positionAmt"] == 0:
                listener.positions.pop(key, None)
            else:
                previous = listener.positions.get(key)
                if previous is not None:
                    position["markPrice"] = previous["markPrice"]
                    position["leverage"] = previous["leverage"]
                listener.positions[key] = position
        snapshot = list(listener.positions.values())
        for queue in tuple(listener.clients):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            queue.put_nowait(snapshot)


def _normalize_position(raw: dict[str, Any]) -> dict[str, Any]:
    amount = float(raw.get("positionAmt", raw.get("pa", 0)))
    position_side = str(raw.get("positionSide", raw.get("ps", "BOTH")))
    side = (
        position_side if position_side in {"LONG", "SHORT"} else ("LONG" if amount > 0 else "SHORT")
    )
    mark_price = raw.get("markPrice")
    return {
        "symbol": str(raw.get("symbol", raw.get("s", ""))),
        "side": side,
        "positionAmt": amount,
        "entryPrice": float(raw.get("entryPrice", raw.get("ep", 0))),
        "unrealizedPnl": float(raw.get("unRealizedProfit", raw.get("up", 0))),
        "markPrice": float(mark_price) if mark_price not in (None, "") else None,
        "leverage": int(raw.get("leverage", 1)),
    }


position_ws_manager = PositionWSManager()
