"""Permit-request schemas — the HTTP request/response layer for issuing a
Trade Permit (POST /execution/permits).

Separate from the existing ``schemas.py`` (which is the permit-card response
layer) to keep the intake shapes close to their endpoint without growing
``schemas.py`` further.
"""

from decimal import Decimal

from pydantic import BaseModel, Field


class PermitRequest(BaseModel):
    """Body submitted by the trade ticket to request a permit.

    The UI never submits a raw ``quantity`` — only the inputs the sizing
    module derives quantity from (EDR 0020 decision 1).  Position size is
    computed server-side from ``entry_price``, ``stop_price``, and the
    account constitution's ``risk_per_trade_percent``.

    ``atr_percent`` and ``stop_placement`` are caller-supplied to allow the
    Trade Quality Score to be fully computed at request time.  If the UI
    cannot supply ``atr_percent`` (e.g. live price data unavailable), it
    may omit it; the scoring module then conservatively scores
    ``volatility_vs_stop`` at 0.

    ``correlation_bucket`` maps to the sector grouping used by the exposure
    aggregation (e.g. ``btc``, ``eth``, ``l1``, ``defi``, ``meme``).  An
    unknown bucket is treated as ``other``.
    """

    symbol: str
    side: str = Field(pattern=r"^(LONG|SHORT)$")
    entry_price: Decimal = Field(gt=0)
    stop_price: Decimal = Field(gt=0)
    take_profit_price: Decimal | None = None
    risk_percent: Decimal = Field(ge=0.5, le=3.0)
    leverage: Decimal = Field(ge=1, le=125)
    correlation_bucket: str = Field(default="other")

    # Quality-score inputs (supplied by the client from its live chart data)
    atr_percent: float = Field(
        default=0.0,
        ge=0.0,
        description="ATR as % of price — used by volatility_vs_stop component of TQS",
    )
    stop_placement: str = Field(
        default="none",
        pattern=r"^(none|weak|adequate|strong)$",
        description="Stop-vs-structure quality — caller-assessed",
    )
    is_high_liquidity_window: bool = Field(
        default=True,
        description="Whether current session window is high-liquidity",
    )
