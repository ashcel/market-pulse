"""Tests for the events read model's pure row -> response mappers.

No DB — the mappers take plain mappings (what SQLAlchemy's `.mappings()`
yields) plus an explicit `now`, so serve-time impact stamping is verified
without touching Postgres:

    cd backend && .venv/bin/python -m pytest tests/test_events_service.py -q

Covers: the additive `impact` / `direction` / `impact_version` fields on all
three event planes, verbatim pass-through of the stored columns (nothing
renamed or dropped), driver-shape tolerance (Decimal pct, jsonb as str or
dict), and the size-unknown-unlock degradation surviving to the response.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.events.impact import IMPACT_SCORE_VERSION
from app.events.service import (
    build_catalyst_event_response,
    build_economic_event_response,
    build_token_event_response,
)

_NOW = datetime(2026, 7, 23, 12, 0, tzinfo=UTC)


def _token_event_row(**overrides) -> dict:
    row = {
        "id": "5f0d2c9e-0000-0000-0000-000000000001",
        "symbol": "SOL",
        "kind": "security",
        "severity": "critical",
        "title": "Protocol X exploited for $40M",
        "body": "Attacker drained the bridge…",
        "source": "coindesk",
        "url": "https://example.com/a",
        "published_at": _NOW - timedelta(hours=2),
        "created_at": _NOW - timedelta(hours=1),
    }
    row.update(overrides)
    return row


def _catalyst_row(**overrides) -> dict:
    row = {
        "id": "5f0d2c9e-0000-0000-0000-000000000002",
        "symbol": "ARB",
        "kind": "unlock",
        "title": "ARB token unlock — 4.10% of supply (92.7M ARB)",
        "description": None,
        "occurs_at": _NOW + timedelta(hours=32),
        "source": "defillama",
        "source_id": "arbitrum",
        "url": "https://defillama.com/unlocks",
        "credibility": None,
        "percent_of_supply": Decimal("0.041"),
        "created_at": _NOW - timedelta(days=1),
        "updated_at": _NOW - timedelta(hours=6),
    }
    row.update(overrides)
    return row


def _econ_row(**overrides) -> dict:
    row = {
        "id": "5f0d2c9e-0000-0000-0000-000000000003",
        "title": "Core CPI m/m",
        "country": "USD",
        "impact": "high",
        "forecast": "0.3%",
        "previous": "0.2%",
        "occurs_at": _NOW + timedelta(hours=6),
        "source": "forexfactory",
        "created_at": _NOW - timedelta(days=2),
        "updated_at": _NOW - timedelta(days=1),
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# Additive impact fields on every plane
# ---------------------------------------------------------------------------


def test_token_event_gains_impact_fields() -> None:
    resp = build_token_event_response(_token_event_row(), _NOW)
    assert resp.impact == "high"
    assert resp.direction == "bearish"
    assert resp.impact_version == IMPACT_SCORE_VERSION
    assert len(resp.impact_components) == 3
    assert resp.impact_disclaimer


def test_catalyst_event_gains_impact_fields() -> None:
    resp = build_catalyst_event_response(_catalyst_row(), _NOW)
    assert resp.impact == "high"
    assert resp.direction == "bearish"
    assert resp.impact_version == IMPACT_SCORE_VERSION


def test_economic_event_gains_impact_fields() -> None:
    resp = build_economic_event_response(_econ_row(), _NOW)
    assert resp.impact == "high"
    assert resp.direction == "neutral"
    assert resp.impact_version == IMPACT_SCORE_VERSION


# ---------------------------------------------------------------------------
# Stored columns pass through verbatim (additive, nothing renamed/dropped)
# ---------------------------------------------------------------------------


def test_token_event_columns_pass_through() -> None:
    row = _token_event_row()
    dumped = build_token_event_response(row, _NOW).model_dump()
    for column in ("symbol", "kind", "severity", "title", "body", "source", "url"):
        assert dumped[column] == row[column]
    assert dumped["id"] == row["id"]
    assert dumped["published_at"] == row["published_at"]
    assert dumped["created_at"] == row["created_at"]


def test_catalyst_columns_pass_through_and_pct_is_float() -> None:
    resp = build_catalyst_event_response(_catalyst_row(), _NOW)
    assert resp.symbol == "ARB"
    assert resp.kind == "unlock"
    assert isinstance(resp.percent_of_supply, float)
    assert resp.percent_of_supply == 0.041


def test_econ_feed_tier_served_as_source_impact() -> None:
    resp = build_economic_event_response(_econ_row(impact="holiday"), _NOW)
    assert resp.source_impact == "holiday"  # feed tier, verbatim
    assert resp.impact == "low"  # computed banding, capped


# ---------------------------------------------------------------------------
# Degradations survive to the response
# ---------------------------------------------------------------------------


def test_size_unknown_unlock_response_is_scheduling_fact() -> None:
    resp = build_catalyst_event_response(_catalyst_row(percent_of_supply=None), _NOW)
    assert resp.percent_of_supply is None
    assert resp.impact == "low"
    assert resp.direction == "neutral"
    assert resp.impact_capped


def test_credibility_jsonb_tolerates_driver_shapes() -> None:
    as_dict = build_catalyst_event_response(
        _catalyst_row(credibility={"votes": 20, "confidencePct": 90, "hotScore": 1}), _NOW
    )
    assert as_dict.credibility == {"votes": 20, "confidencePct": 90, "hotScore": 1}

    as_str = build_catalyst_event_response(
        _catalyst_row(credibility='{"votes": 20, "confidencePct": 90, "hotScore": 1}'), _NOW
    )
    assert as_str.credibility == {"votes": 20, "confidencePct": 90, "hotScore": 1}

    malformed = build_catalyst_event_response(_catalyst_row(credibility="not json"), _NOW)
    assert malformed.credibility is None


def test_past_event_proximity_decays() -> None:
    fresh = build_token_event_response(_token_event_row(), _NOW)
    stale = build_token_event_response(
        _token_event_row(published_at=_NOW - timedelta(days=10)), _NOW
    )
    assert stale.impact_score < fresh.impact_score
