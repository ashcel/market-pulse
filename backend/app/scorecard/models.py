"""source_scorecard — the evidence table (Sprint 5, IMPLEMENTATION-PLAN §3).

One row per (source, source_version, regime, horizon, window_days).
n < 20 → evidence.status='insufficient'; the UI shows "Belum cukup data".
"""

import uuid

import sqlalchemy as sa
from sqlalchemy import DateTime, Double, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class SourceScorecard(Base):
    __tablename__ = "source_scorecard"
    __table_args__ = (
        sa.Index(
            "source_scorecard_lookup_idx",
            "source",
            "source_version",
            "regime",
            "horizon",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    source_version: Mapped[str] = mapped_column(String(32), nullable=False)
    regime: Mapped[str] = mapped_column(String(32), nullable=False)
    horizon: Mapped[str] = mapped_column(String(16), nullable=False)
    window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    n: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    hit_rate: Mapped[float | None] = mapped_column(Double, nullable=True)
    avg_r: Mapped[float | None] = mapped_column(Double, nullable=True)
    computed_at: Mapped[sa.DateTime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
