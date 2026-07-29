"""Forward-test plane — backend-owned since the 2.0.0 reset (Phase 4).

Table shapes are kept byte-compatible with the legacy TS schema
(`frontend/src/server/db/migrations`) so the legacy web app's read models
(`/api/forward-test`) keep working unchanged until the SPA cutover. The
Python arq worker is the sole writer.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Double, ForeignKey, Index, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class EngineRun(Base):
    __tablename__ = "engine_run"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=text("gen_random_uuid()")
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    engine_version: Mapped[str] = mapped_column(Text, nullable=False)
    config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    git_sha: Mapped[str] = mapped_column(Text, nullable=False)
    universe_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'ok'::text"))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class EvalLog(Base):
    __tablename__ = "eval_log"
    __table_args__ = (
        Index("eval_log_verdict_idx", "verdict"),
        Index("eval_log_lookup_idx", "symbol", "market", "intent", "evaluated_at"),
        Index("eval_log_bt_idx", "bt_win_rate", "bt_total_trades"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=text("gen_random_uuid()")
    )
    engine_run_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("engine_run.id"), nullable=True
    )
    evaluated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    symbol: Mapped[str] = mapped_column(Text, nullable=False)
    market: Mapped[str] = mapped_column(Text, nullable=False)
    intent: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str | None] = mapped_column(Text, nullable=True)
    setup_type: Mapped[str] = mapped_column(Text, nullable=False)
    regime: Mapped[str] = mapped_column(Text, nullable=False)
    timeframe: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Double, nullable=True)
    bt_win_rate: Mapped[float | None] = mapped_column(Double, nullable=True)
    bt_expectancy: Mapped[float | None] = mapped_column(Double, nullable=True)
    bt_avg_r: Mapped[float | None] = mapped_column(Double, nullable=True)
    bt_total_trades: Mapped[int | None] = mapped_column(nullable=True)
    bt_low_sample: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    no_trade_reasons: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    component_scores: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    engine_version: Mapped[str] = mapped_column(Text, nullable=False)
    config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    git_sha: Mapped[str] = mapped_column(Text, nullable=False)


class ShadowSignalRow(Base):
    __tablename__ = "shadow_signal"
    __table_args__ = (
        Index("shadow_open_idx", "status"),
        Index("shadow_group_idx", "symbol", "timeframe", "market"),
        Index("shadow_combo_idx", "engine_version", "setup_type", "regime"),
        # The idempotency backbone: at most one *active* record per
        # symbol/market/intent — re-running an eval pass no-ops the duplicate.
        Index(
            "shadow_active_uniq",
            "symbol",
            "market",
            "intent",
            unique=True,
            postgresql_where=text("status = 'active'::text"),
        ),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=text("gen_random_uuid()")
    )
    symbol: Mapped[str] = mapped_column(Text, nullable=False)
    market: Mapped[str] = mapped_column(Text, nullable=False)
    intent: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    setup_type: Mapped[str] = mapped_column(Text, nullable=False)
    regime: Mapped[str] = mapped_column(Text, nullable=False)
    timeframe: Mapped[str] = mapped_column(Text, nullable=False)
    entry: Mapped[float] = mapped_column(Double, nullable=False)
    stop: Mapped[float] = mapped_column(Double, nullable=False)
    target1: Mapped[float] = mapped_column(Double, nullable=False)
    target2: Mapped[float] = mapped_column(Double, nullable=False)
    confidence: Mapped[float] = mapped_column(Double, nullable=False)
    objective_resolved: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'::text"))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    close_price: Mapped[float | None] = mapped_column(Double, nullable=True)
    result_r: Mapped[float | None] = mapped_column(Double, nullable=True)
    engine_version: Mapped[str] = mapped_column(Text, nullable=False)
    config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    git_sha: Mapped[str] = mapped_column(Text, nullable=False)
    engine_run_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("engine_run.id"), nullable=True
    )


class AnticipatorySignalRow(Base):
    __tablename__ = "anticipatory_signal"
    __table_args__ = (
        Index("anticipatory_open_idx", "status"),
        Index("anticipatory_group_idx", "symbol", "timeframe", "market"),
        # One open (pending or filled) anticipatory record per
        # symbol/market/intent — the fill harness's dedup.
        Index(
            "anticipatory_active_uniq",
            "symbol",
            "market",
            "intent",
            unique=True,
            postgresql_where=text("status = ANY (ARRAY['pending'::text, 'filled'::text])"),
        ),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=text("gen_random_uuid()")
    )
    symbol: Mapped[str] = mapped_column(Text, nullable=False)
    market: Mapped[str] = mapped_column(Text, nullable=False)
    intent: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    setup_type: Mapped[str] = mapped_column(Text, nullable=False)
    regime: Mapped[str] = mapped_column(Text, nullable=False)
    timeframe: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    entry: Mapped[float] = mapped_column(Double, nullable=False)
    stop: Mapped[float] = mapped_column(Double, nullable=False)
    objective: Mapped[float] = mapped_column(Double, nullable=False)
    objective_strength: Mapped[str] = mapped_column(Text, nullable=False)
    zone_freshness: Mapped[str] = mapped_column(Text, nullable=False)
    reward_risk: Mapped[float] = mapped_column(Double, nullable=False)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'pending'::text")
    )
    filled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    close_price: Mapped[float | None] = mapped_column(Double, nullable=True)
    result_r: Mapped[float | None] = mapped_column(Double, nullable=True)
    engine_version: Mapped[str] = mapped_column(Text, nullable=False)
    config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    git_sha: Mapped[str] = mapped_column(Text, nullable=False)
    engine_run_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("engine_run.id"), nullable=True
    )


class VerdictHold(Base):
    __tablename__ = "verdict_hold"
    __table_args__ = (Index("verdict_hold_scope_idx", "symbol", "market"),)

    hold_key: Mapped[str] = mapped_column(Text, primary_key=True)
    symbol: Mapped[str] = mapped_column(Text, nullable=False)
    market: Mapped[str] = mapped_column(Text, nullable=False)
    # Serialized smc.hysteresis.HeldVerdict (snake_case; see repo.hold_to_json).
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
