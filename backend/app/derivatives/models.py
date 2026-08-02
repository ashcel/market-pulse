"""`derivatives_snapshot` — append-only Binance USDⓈ-M positioning facts.

Mirrors the `signal_events` contract (docs/IMPLEMENTATION-PLAN.md §1 rule 5:
"append-only untuk fakta, read model untuk tampilan"). Nothing derived is
stored: momentum, crowding, squeeze and regime are computed on read in
`service.py`, so changing a threshold re-reads history instead of corrupting
it.

Idempotency is `(symbol, timestamp)` UNIQUE with the writer flooring every
snapshot onto the 5-minute grid, so a retried tick inside the same slot
collides with itself and is dropped by ON CONFLICT DO NOTHING.

Immutability is enforced in the database, not by convention: the migration
installs a trigger that raises `derivatives_snapshot is append-only` on any
UPDATE or DELETE. A correction is a new row in the next slot.

`symbol` is the canonical `<TICKER>USDT` form (PEPEUSDT), never the 1000x
futures contract name — the price/OI scale is unwound at write time so this
table joins straight onto every other plane in Market Pulse.
"""

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import DateTime, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# Postgres `numeric` is exact but hydrates as Decimal; the read path converts
# to float once, in the repo, so the service only ever sees floats.
_NUM = Numeric(38, 12)


class DerivativesSnapshot(Base):
    __tablename__ = "derivatives_snapshot"
    __table_args__ = (
        sa.UniqueConstraint("symbol", "timestamp", name="derivatives_snapshot_symbol_ts_key"),
        sa.Index("derivatives_snapshot_symbol_ts_idx", "symbol", sa.text("timestamp DESC")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    # Floored onto the 5-minute grid by the writer — see the module docstring.
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Every metric is nullable: a feed that failed must degrade the read, never
    # invent a zero. The cold-start OI backfill writes rows carrying only the
    # OI pair, which is exactly why these are not NOT NULL.
    open_interest: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    open_interest_usd: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    funding_rate: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    long_short_ratio: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    top_trader_accounts_ratio: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    top_trader_positions_ratio: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    taker_buy_volume: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    taker_sell_volume: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    basis: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    premium: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    # OI USD / market cap. NULL whenever CoinGecko has no mapping or is down —
    # never fabricated, since the ratio is meaningless with a guessed cap.
    oi_marketcap_ratio: Mapped[float | None] = mapped_column(_NUM, nullable=True)
    price: Mapped[float | None] = mapped_column(_NUM, nullable=True)
