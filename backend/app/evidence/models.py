"""`forward_return` — the evidence plane's ground truth, append-only.

One row per (symbol, bar, horizon): what the asset actually did over that
horizon starting from that bar's close. Every Information Coefficient the
product reports is a rank correlation against this table, so the rules are
strict:

Idempotency is `(symbol, observed_at, horizon, version)` UNIQUE. The writer
re-fetches overlapping kline windows on every pass, so the same measurement is
recomputed constantly; a retry collides with itself and is dropped by
ON CONFLICT DO NOTHING. Recomputing can never change a stored number, because
the inputs are closed bars.

`version` carries `FORWARD_RETURN_VERSION`. Redefining a horizon writes a new
cohort rather than reinterpreting the old one — the same discipline the engine
uses for `ENGINE_VERSION`.

Immutability is enforced by trigger, not convention (matching
`derivatives_snapshot`): a correction is a new version, never an UPDATE. A
mutable ground truth is how a track record quietly becomes a backtest.
"""

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import DateTime, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# Exact in Postgres, hydrated as Decimal; the repo converts to float once so
# the statistics layer only ever sees floats.
_NUM = Numeric(38, 12)


class ForwardReturn(Base):
    __tablename__ = "forward_return"
    __table_args__ = (
        sa.UniqueConstraint(
            "symbol",
            "observed_at",
            "horizon",
            "version",
            name="forward_return_symbol_observed_horizon_version_key",
        ),
        # The IC pass reads one horizon across a date window for many symbols.
        sa.Index("forward_return_horizon_observed_idx", "horizon", sa.text("observed_at DESC")),
        sa.Index("forward_return_symbol_observed_idx", "symbol", sa.text("observed_at DESC")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)

    #: Close time of the anchor bar. The measurement window is strictly after
    #: this instant — see `forward_returns.compute_forward_returns`.
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    horizon: Mapped[str] = mapped_column(String(8), nullable=False)
    horizon_bars: Mapped[int] = mapped_column(Integer, nullable=False)
    interval: Mapped[str] = mapped_column(String(8), nullable=False)

    base_close: Mapped[float] = mapped_column(_NUM, nullable=False)
    forward_close: Mapped[float] = mapped_column(_NUM, nullable=False)
    forward_return: Mapped[float] = mapped_column(_NUM, nullable=False)

    version: Mapped[str] = mapped_column(String(16), nullable=False)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa.func.now()
    )
