import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.auth.dependencies import CurrentUserId, DbSession

from .position_ws_manager import position_ws_manager

router = APIRouter(prefix="/execution/positions", tags=["execution"])


@router.get("/stream")
async def stream_positions(
    request: Request, user_id: CurrentUserId, db: DbSession
) -> StreamingResponse:
    await position_ws_manager.start_listener(user_id, db)
    queue: asyncio.Queue[list[dict[str, object]]] = asyncio.Queue(maxsize=1)
    position_ws_manager.register_client(user_id, queue)

    initial = await position_ws_manager.load_initial_positions(user_id)

    async def events() -> AsyncIterator[str]:
        try:
            yield _sse(initial)
            while not await request.is_disconnected():
                try:
                    positions = await asyncio.wait_for(queue.get(), timeout=15)
                    yield _sse(positions)
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await position_ws_manager.remove_client(user_id, queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(positions: list[dict[str, object]]) -> str:
    return f"event: positions\ndata: {json.dumps(positions, separators=(',', ':'))}\n\n"
