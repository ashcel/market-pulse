"""Safe data tools for the AI Desk agent."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from langchain_core.tools import tool
from sqlalchemy import text

from app.database import SessionFactory
from app.news_intel.repo import load_latest_sentiment

BINANCE_BASE = "https://api.binance.com"
TIMEOUT_S = 15


OPEN_POSITIONS_SQL = (
    "select symbol, side, quantity, entry_price, leverage, status, updated_at "
    "from execution_records "
    "where status not in ('FAILED', 'CANCELLED', 'CLOSED') "
    "{user_filter}"
    "order by updated_at desc limit 20"
)


def _sma(prices: list[float], period: int) -> float | None:
    return sum(prices[-period:]) / period if len(prices) >= period else None


async def load_open_positions(user_id: str | None = None) -> list[dict[str, Any]]:
    """Load the non-terminal execution records that represent open exposure.

    Live exchange positions are not persisted; execution records retain the
    position state, so they are the durable view of "what am I holding".
    """
    sql = OPEN_POSITIONS_SQL.format(user_filter="and user_id = :user_id " if user_id else "")
    params = {"user_id": user_id} if user_id else {}
    async with SessionFactory() as db:
        result = await db.execute(text(sql), params)
        return [dict(row._mapping) for row in result]


async def load_recent_events(hours: int = 24, limit: int = 10) -> list[dict[str, Any]]:
    """Load token events published in the recent window, newest first."""
    sql = (
        "select symbol, title, source, published_at from token_event "
        f"where published_at >= now() - interval '{int(hours)} hours' "
        "order by published_at desc limit :limit"
    )
    async with SessionFactory() as db:
        result = await db.execute(text(sql), {"limit": limit})
        return [dict(row._mapping) for row in result]


async def _read_chart(symbol: str, timeframe: str = "1d", limit: int = 30) -> str:
    pair = symbol.upper()
    if not pair.endswith("USDT"):
        pair += "USDT"
    safe_limit = min(max(limit, 25), 100)
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        ticker, klines = await client.get(
            f"{BINANCE_BASE}/api/v3/ticker/24hr", params={"symbol": pair}
        ), await client.get(
            f"{BINANCE_BASE}/api/v3/klines",
            params={"symbol": pair, "interval": timeframe, "limit": safe_limit},
        )
    if ticker.status_code != 200 or klines.status_code != 200:
        return f"Binance data unavailable for {pair}."
    ticker_data = ticker.json()
    closes = [float(row[4]) for row in klines.json()]
    sma_7, sma_25 = _sma(closes, 7), _sma(closes, 25)
    trend = "neutral"
    if sma_7 is not None and sma_25 is not None:
        trend = "bullish" if closes[-1] > sma_7 > sma_25 else "bearish" if closes[-1] < sma_7 < sma_25 else "mixed"
    return json.dumps(
        {
            "symbol": pair,
            "timeframe": timeframe,
            "price": float(ticker_data["lastPrice"]),
            "change_24h_percent": float(ticker_data["priceChangePercent"]),
            "sma_7": sma_7,
            "sma_25": sma_25,
            "trend": trend,
        }
    )


@tool
async def read_chart(symbol: str, timeframe: str = "1d", limit: int = 30) -> str:
    """Read Binance price, 24-hour change, SMA-7/25, and trend for a crypto symbol."""
    return await _read_chart(symbol, timeframe, limit)


@tool
async def query_db(natural_query: str) -> str:
    """Run a safe predefined SELECT for sentiment, token events, positions, or executions."""
    query = natural_query.lower()
    if "sentiment" in query:
        sql = "select snapshot_at, market_sentiment, key_narratives, ai_brief from sentiment_snapshot order by snapshot_at desc limit 1"
    elif any(word in query for word in ("event", "news", "today", "headline")):
        sql = "select symbol, title, source, published_at from token_event where published_at >= now() - interval '24 hours' order by published_at desc limit 10"
    elif any(word in query for word in ("position", "holding")):
        # Position state is retained on execution records; live exchange positions are not persisted.
        sql = "select symbol, side, quantity, entry_price, leverage, status, updated_at from execution_records where status not in ('FAILED', 'CANCELLED', 'CLOSED') order by updated_at desc limit 20"
    elif any(word in query for word in ("trade", "execution", "order")):
        sql = "select symbol, side, quantity, entry_price, filled_quantity, status, created_at from execution_records order by created_at desc limit 10"
    else:
        return "Supported database topics: sentiment, events/news, positions, executions/trades."
    async with SessionFactory() as db:
        result = await db.execute(text(sql))
        rows = [dict(row._mapping) for row in result]
    return json.dumps(rows, default=str) if rows else "No matching database records."


@tool
async def search_web(query: str) -> str:
    """Search DuckDuckGo for up to five current web results."""
    try:
        from duckduckgo_search import DDGS

        results = await asyncio.to_thread(lambda: list(DDGS().text(query, max_results=5)))
        return json.dumps(results, default=str) if results else "No web results found."
    except Exception as exc:
        return f"Web search unavailable: {exc}"


@tool
async def read_sentiment() -> str:
    """Read the latest Market Pulse sentiment snapshot."""
    async with SessionFactory() as db:
        snapshot: dict[str, Any] | None = await load_latest_sentiment(db)
    return json.dumps(snapshot, default=str) if snapshot else "No sentiment snapshot available."


async def gather_portfolio_context(positions: list[dict[str, Any]]) -> dict[str, Any]:
    """Fetch chart, sentiment, and event context for a batch of positions.

    Charts for every distinct symbol are fetched concurrently; sentiment and
    events run alongside them. Individual failures degrade to an error string
    for that symbol rather than failing the whole batch.
    """
    symbols = list(dict.fromkeys(str(p.get("symbol", "")).upper() for p in positions if p.get("symbol")))

    async def chart_for(symbol: str) -> tuple[str, Any]:
        try:
            raw = await _read_chart(symbol, "1d", 30)
        except Exception as exc:  # network/parse failures are per-symbol, not fatal
            return symbol, {"error": f"chart unavailable: {exc}"}
        try:
            return symbol, json.loads(raw)
        except json.JSONDecodeError:
            return symbol, {"error": raw}

    async def sentiment_ctx() -> Any:
        try:
            async with SessionFactory() as db:
                return await load_latest_sentiment(db)
        except Exception as exc:
            return {"error": f"sentiment unavailable: {exc}"}

    async def events_ctx() -> Any:
        try:
            return await load_recent_events()
        except Exception as exc:
            return {"error": f"events unavailable: {exc}"}

    results = await asyncio.gather(
        *(chart_for(symbol) for symbol in symbols),
        sentiment_ctx(),
        events_ctx(),
    )
    charts = dict(results[: len(symbols)])  # type: ignore[arg-type]
    sentiment, events = results[len(symbols)], results[len(symbols) + 1]

    return {
        "positions": positions,
        "charts": charts,
        "sentiment": sentiment,
        "recent_events": events,
    }


@tool
async def analyze_positions(positions_json: str) -> str:
    """Gather chart, sentiment, and event context for a batch of open positions.

    Pass a JSON array of positions, each with at least a "symbol" key (e.g.
    '[{"symbol": "BTCUSDT", "side": "BUY", "entry_price": 65000}]'). Returns a
    single JSON payload with per-symbol price/SMA/trend, the latest market
    sentiment snapshot, and recent token events — everything needed to judge
    each position in one call instead of one `read_chart` call per symbol.
    """
    try:
        parsed = json.loads(positions_json)
    except json.JSONDecodeError as exc:
        return f"positions_json must be a JSON array of position objects: {exc}"
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return "positions_json must be a JSON array of position objects."
    positions = [p for p in parsed if isinstance(p, dict)]
    if not positions:
        return "No positions provided — nothing to analyze."

    context = await gather_portfolio_context(positions)
    return json.dumps(context, default=str)


TOOLS = [read_chart, query_db, search_web, read_sentiment, analyze_positions]
