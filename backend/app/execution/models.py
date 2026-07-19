import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TradingConstitution(Base):
    """Versioned per-account risk config (M9-T1 / EDR 0020 decision 2).

    Rows are insert-only — every edit creates a new row with `version`
    incremented, never an UPDATE of a prior row. The current config for a
    user is the row with the highest `version` (see `service.get_current_constitution`).
    Every insert here is paired, in the same transaction, with a
    `ConstitutionAudit` row.
    """

    __tablename__ = "trading_constitutions"
    __table_args__ = (
        sa.UniqueConstraint(
            "user_id", "version", name="trading_constitutions_user_id_version_key"
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    risk_per_trade_percent: Mapped[float] = mapped_column(Float, nullable=False)
    daily_loss_limit_percent: Mapped[float] = mapped_column(Float, nullable=False)
    weekly_loss_limit_percent: Mapped[float] = mapped_column(Float, nullable=False)
    max_leverage: Mapped[int] = mapped_column(Integer, nullable=False)
    max_concurrent_positions: Mapped[int] = mapped_column(Integer, nullable=False)
    max_correlated_exposure_percent: Mapped[float] = mapped_column(Float, nullable=False)
    min_risk_reward: Mapped[float] = mapped_column(Float, nullable=False)
    # JSON columns: list[str] / dict[str, bool] — see schemas.py for shape.
    allowed_sessions: Mapped[list[str]] = mapped_column(sa.JSON, nullable=False, default=list)
    allowed_symbols: Mapped[list[str]] = mapped_column(sa.JSON, nullable=False, default=list)
    binding_cooldowns: Mapped[dict[str, bool]] = mapped_column(
        sa.JSON, nullable=False, default=dict
    )

    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)


class ConstitutionAudit(Base):
    """One row per Trading Constitution create/edit: who, when, before/after
    snapshot. Never updated or deleted — the audit trail itself is immutable.
    """

    __tablename__ = "constitution_audits"
    __table_args__ = (
        sa.Index(
            "constitution_audits_user_id_version_idx", "user_id", "version"
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    constitution_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(20), nullable=False)  # "create" | "update"
    changed_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    before_snapshot: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    after_snapshot: Mapped[dict[str, Any]] = mapped_column(sa.JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)


class TradePermit(Base):
    """The Trade Permit record — M9-T5 (EDR 0020 decision 6): "Every
    execution attempt produces a persisted, immutable Trade Permit."

    **Insert-only. There is no UPDATE path for this table, by design:**
    `permit_service.py` exposes `create_permit` / `get_permit` /
    `list_permits` and deliberately no update/mutate function (asserted by
    `tests/test_execution_permit.py::test_no_update_path_exists`, which
    inspects the service module's public names). A permit is a point-in-time
    judgment snapshot — if the market or account state moves, a *new*
    permit is created against fresh inputs; the old one is never revised,
    only superseded and left to expire via `expires_at`.

    A DB-level `REVOKE UPDATE` grant would harden this further, but this
    migration is hand-written and intentionally never executed by this task
    (this VPS's `DATABASE_URL` is the live database — see CLAUDE.md
    "HARD CONSTRAINTS"). The immutability guarantee for now is enforced at
    the application layer (no update function exists) plus this comment
    documenting the intent for whoever wires the real migration run/grant
    later.

    Every field the EDR asks for is captured, and JSON-encoded where it's a
    structured snapshot rather than a scalar:

    - `proposal_snapshot` / `account_state_snapshot`: the full
      `TradeProposal`/`AccountState` the decision was judged against
      (Decimal fields serialized as strings so the JSON round-trips
      exactly).
    - `check_results`: every `PermitCheckResult` in `CHECK_ORDER`, not just
      the failing ones — the permit card can render the full board.
    - `reasons`: the failing subset, as `PermitCheck` enum values (typed,
      not free text) — redundant with `check_results` but this is the
      column callers filter/query on.
    - `quality_score` / `quality_components` / `quality_disclaimer`: the
      Trade Quality Score total, its per-component breakdown, and the
      disclaimer string shown alongside it (verbatim `SCORE_DISCLAIMER` at
      the time of evaluation — captured rather than joined live, since the
      record must stay reproducible even if the constant's wording changes
      later).
    - `status` / `reasons` / `evaluated_at` / `session`: copied straight
      from `PermitDecision` — never re-derived.
    - `expires_at`: the short TTL EDR 0020 decision 6 requires; see
      `is_expired()` in `permit_service.py`.
    """

    __tablename__ = "trade_permits"
    __table_args__ = (
        sa.Index("trade_permits_user_id_created_at_idx", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    # Denormalized from proposal_snapshot for cheap filtering/listing —
    # the snapshot below remains the source of truth for every other field.
    symbol: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    side: Mapped[str] = mapped_column(String(10), nullable=False)

    proposal_snapshot: Mapped[dict[str, Any]] = mapped_column(sa.JSON, nullable=False)
    account_state_snapshot: Mapped[dict[str, Any]] = mapped_column(sa.JSON, nullable=False)
    check_results: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON, nullable=False)

    # "APPROVED" | "REJECTED"
    status: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    reasons: Mapped[list[str]] = mapped_column(sa.JSON, nullable=False, default=list)

    quality_score: Mapped[float] = mapped_column(Float, nullable=False)
    quality_components: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON, nullable=False)
    quality_disclaimer: Mapped[str] = mapped_column(String(255), nullable=False)

    evaluated_at: Mapped[datetime] = mapped_column(nullable=False)
    session: Mapped[str] = mapped_column(String(20), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False, index=True)

    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(), nullable=False)
