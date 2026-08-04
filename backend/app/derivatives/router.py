"""Derivatives Intelligence read API.

Two endpoints, both authenticated with the normal Market Pulse session (or the
server-to-server internal key the TanStack proxy uses). Both return finished
interpretations: the client picks colours and lays out cards, and computes no
number of its own.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Query

from app.auth.dependencies import CurrentUserId, DbSession
from app.exceptions import AppError, NotFoundError

from . import repo
from .binance import canonical_symbol
from .constants import DELTA_WINDOWS_S, HISTORY_WINDOWS_S
from .schemas import DerivativesIntelligence, HistoryMetric, HistoryWindow
from .service import build_summary, derive, history_series

router = APIRouter(prefix="/derivatives", tags=["derivatives"])

# Deltas reach back 24h, and `pick_at` needs a sample slightly OLDER than the
# window's start to answer the 24h one at all.
_READ_LOOKBACK_S = DELTA_WINDOWS_S["24h"] + 3600


class InvalidSymbolError(AppError):
    code = "INVALID_SYMBOL"


def normalize_symbol(raw: str) -> str:
    """Uppercase, strip non-alphanumerics, ensure the USDT suffix — the same
    rule `app/quant/router.py` applies, so a Ticket page that renders a bare
    `BTC` reaches the right row here."""
    symbol = canonical_symbol(raw)
    if symbol == "USDT":
        raise InvalidSymbolError("symbol is empty after normalization", {"symbol": raw})
    return symbol


@router.get(
    "/summary",
    summary="Cross-symbol derivatives summary",
    description=(
        "Top momentum movers, top squeeze risks, top/bottom OI-delta movers and the regime "
        "distribution across every symbol with a recent snapshot — one pass over the same "
        "read model `/{symbol}` uses, so nothing here can disagree with a per-symbol card. "
        "Registered ahead of `/{symbol}` so the literal path wins the route match."
    ),
)
async def get_derivatives_summary(
    db: DbSession,
    _user_id: CurrentUserId,
) -> dict[str, Any]:
    symbols = await repo.list_symbols(db)
    intelligences: list[DerivativesIntelligence] = []
    for symbol in symbols:
        series = await repo.load_series(db, symbol, lookback_s=_READ_LOOKBACK_S)
        if not series:
            continue
        intelligence = derive(symbol, series)
        if intelligence is not None:
            intelligences.append(intelligence)

    summary = build_summary(intelligences)
    return {
        "data": summary.model_dump(mode="json"),
        "meta": {"symbols_scanned": len(symbols)},
        "error": None,
    }


@router.get(
    "/{symbol}",
    summary="Derivatives intelligence for one symbol",
    description=(
        "Latest raw snapshot plus every derived score, the classified market "
        "regime and a deterministic Indonesian summary. Nothing here is "
        "recomputed client-side."
    ),
)
async def get_derivatives(
    db: DbSession,
    _user_id: CurrentUserId,
    symbol: str,
) -> dict[str, Any]:
    normalized = normalize_symbol(symbol)
    series = await repo.load_series(db, normalized, lookback_s=_READ_LOOKBACK_S)
    if not series:
        # Distinguish "we have never collected this" from "the collector is
        # behind": both are 404 to the client, but the message differs so an
        # operator reading logs knows which one they are looking at.
        ever = await repo.has_symbol(db, normalized)
        message = (
            "no recent derivatives snapshot for this symbol"
            if ever
            else "no derivatives data collected for this symbol"
        )
        raise NotFoundError(message, {"symbol": normalized})

    intelligence = derive(normalized, series)
    if intelligence is None:  # pragma: no cover — `series` is non-empty here
        raise NotFoundError("no derivatives data collected for this symbol", {"symbol": normalized})

    return {
        "data": intelligence.model_dump(mode="json"),
        "meta": {"symbol": normalized, "samples": len(series)},
        "error": None,
    }


@router.get(
    "/{symbol}/history",
    summary="Sparkline series for one derived metric",
    description=(
        "Server-computed series so a sparkline can never disagree with the card printed above it."
    ),
)
async def get_derivatives_history(
    db: DbSession,
    _user_id: CurrentUserId,
    symbol: str,
    metric: Annotated[HistoryMetric, Query()] = "momentum",
    window: Annotated[HistoryWindow, Query()] = "1h",
) -> dict[str, Any]:
    normalized = normalize_symbol(symbol)
    # Momentum at each point needs its own trailing deltas, so the query pulls
    # the window PLUS the longest delta window behind it. Trimming happens in
    # `history_series`, after the derivation that needs the extra history.
    lookback = HISTORY_WINDOWS_S[window] + DELTA_WINDOWS_S["24h"]
    series = await repo.load_series(db, normalized, lookback_s=lookback)
    if not series:
        raise NotFoundError("no derivatives data collected for this symbol", {"symbol": normalized})

    points = history_series(series, metric, window)
    return {
        "data": {
            "symbol": normalized,
            "metric": metric,
            "window": window,
            "points": [point.model_dump(mode="json") for point in points],
        },
        "meta": {"count": len(points)},
        "error": None,
    }
