"""AI Desk Review router — chat and portfolio-analysis endpoints."""

from __future__ import annotations

import json
import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .agent import build_agent, format_history

router = APIRouter(prefix="/ai-desk", tags=["ai-desk"])

# In-memory conversation store: conversation_id -> list of messages
_conversations: dict[str, list[dict]] = {}
_MAX_HISTORY = 20  # Keep last 20 messages per conversation


class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None


class ChatData(BaseModel):
    response: str
    conversation_id: str


class ChatResponse(BaseModel):
    data: ChatData
    meta: None = None
    error: None = None


@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(
    payload: ChatRequest,
) -> ChatResponse:
    """Send a message to the AI Desk Review agent and get a response."""
    if not payload.message.strip():
        raise HTTPException(status_code=422, detail="Message cannot be empty.")
    conv_id = payload.conversation_id or str(uuid.uuid4())

    if conv_id not in _conversations:
        _conversations[conv_id] = []

    history = _conversations[conv_id]
    history.append({"role": "user", "content": payload.message})

    # Trim history if too long
    if len(history) > _MAX_HISTORY:
        history = history[-_MAX_HISTORY:]
        _conversations[conv_id] = history

    try:
        executor = build_agent()
        langchain_history = format_history(history[:-1])  # everything except latest user msg

        result = await executor.ainvoke({
            "input": payload.message,
            "history": langchain_history,
        })

        response_text = result.get("output", "Sorry, I couldn't process that.")
        history.append({"role": "assistant", "content": response_text})
    except Exception as exc:
        history.pop()
        raise HTTPException(status_code=502, detail=f"AI Desk unavailable: {exc}") from exc

    return ChatResponse(
        data=ChatData(response=response_text, conversation_id=conv_id)
    )


class AnalyzeTradesData(BaseModel):
    response: str
    positions_analyzed: int
    conversation_id: str


class AnalyzeTradesResponse(BaseModel):
    data: AnalyzeTradesData
    meta: None = None
    error: None = None


class AnalyzePosition(BaseModel):
    symbol: str
    side: Literal["LONG", "SHORT"]
    entryPrice: float
    markPrice: float | None
    unrealizedPnl: float
    leverage: float


class AnalyzeTradesRequest(BaseModel):
    positions: list[AnalyzePosition]


NO_POSITIONS_MESSAGE = (
    "You have no open positions right now, so there is nothing to review. "
    "That is a valid state — wait for a setup rather than forcing a trade."
)


def _describe_position(position: dict[str, Any]) -> str:
    """One-line human summary of a position for the agent prompt."""
    symbol = position.get("symbol", "?")
    side = position.get("side", "?")
    entry = position.get("entryPrice")
    mark = position.get("markPrice")
    pnl = position.get("unrealizedPnl")
    leverage = position.get("leverage")
    return (
        f"- {symbol} {side} entry={entry} mark={mark} "
        f"unrealizedPnL={pnl} leverage={leverage}x"
    )


def _build_analysis_prompt(positions: list[dict[str, Any]]) -> str:
    listing = "\n".join(_describe_position(p) for p in positions)
    payload = json.dumps(positions, default=str)
    return (
        "Analyze my current positions:\n"
        f"{listing}\n\n"
        "Call `analyze_positions` with this exact JSON array to get charts, "
        f"sentiment, and recent events in one shot:\n{payload}\n\n"
        "Then check web news for the notable holdings. Give a specific action "
        "suggestion (hold / close / adjust stop) for each position with the "
        "reasoning behind it, and finish with a short portfolio-level risk note. "
        "Use Markdown with one section per position."
    )


@router.post("/analyze-trades", response_model=AnalyzeTradesResponse)
async def analyze_trades_endpoint(
    payload: AnalyzeTradesRequest,
) -> AnalyzeTradesResponse:
    """Run a full AI Desk review over the submitted live positions."""
    conv_id = str(uuid.uuid4())
    positions = [position.model_dump() for position in payload.positions]

    if not positions:
        return AnalyzeTradesResponse(
            data=AnalyzeTradesData(
                response=NO_POSITIONS_MESSAGE,
                positions_analyzed=0,
                conversation_id=conv_id,
            )
        )

    prompt = _build_analysis_prompt(positions)
    _conversations[conv_id] = [{"role": "user", "content": prompt}]

    try:
        executor = build_agent()
        result = await executor.ainvoke({"input": prompt, "history": []})
        response_text = result.get("output", "Sorry, I couldn't analyze your positions.")
    except Exception as exc:
        _conversations.pop(conv_id, None)
        raise HTTPException(status_code=502, detail=f"AI Desk unavailable: {exc}") from exc

    _conversations[conv_id].append({"role": "assistant", "content": response_text})

    return AnalyzeTradesResponse(
        data=AnalyzeTradesData(
            response=response_text,
            positions_analyzed=len(positions),
            conversation_id=conv_id,
        )
    )
