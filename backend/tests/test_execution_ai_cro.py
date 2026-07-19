from typing import Any

import pytest

from app.execution.ai_cro import CRONarration, build_cro_context, build_cro_prompt


@pytest.fixture
def permit_dict() -> dict[str, Any]:
    return {
        "id": "permit-123",
        "status": "REJECTED",
        "reasons": ["BINDING_COOLDOWN_ACTIVE"],
        "quality_score": 75.5,
        "quality_components": [{"component": "trend", "points": 10.0, "detail": "good"}],
        "check_results": [
            {"check": "BINDING_COOLDOWN_ACTIVE", "passed": False, "detail": "revenge active"}
        ],
        "proposal_snapshot": {
            "symbol": "BTCUSDT",
            "side": "LONG",
            "entry_price": "100",
            "stop_price": "90",
            "take_profit_price": "120",
        },
        "account_state_snapshot": {
            "daily_realized_pnl_percent": "-2.5",
            "weekly_realized_pnl_percent": "1.0",
            "active_behavior_flags": ["revenge"],
        },
    }


def test_context_builder_only_uses_persisted_fields(permit_dict: dict[str, Any]) -> None:
    context = build_cro_context(permit_dict)
    assert context.permit_id == "permit-123"
    assert context.status == "REJECTED"
    assert context.proposed_rr == "2.00:1"
    assert "Today: -2.5%" in context.recent_pnl_summary
    assert context.behavior_flags == ["revenge"]


def test_ai_cro_schema_decision_is_not_model_output(permit_dict: dict[str, Any]) -> None:
    context = build_cro_context(permit_dict)
    narration = CRONarration(
        permit_id=context.permit_id,
        status=context.status,
        quality_score=context.quality_score,
        narration="This is the AI explanation.",
    )
    assert narration.status == "REJECTED"
    assert narration.permit_id == "permit-123"


def test_prompt_contains_decision_upfront(permit_dict: dict[str, Any]) -> None:
    context = build_cro_context(permit_dict)
    prompt = build_cro_prompt(context)
    assert "REJECTED" in prompt[:200]


def test_prompt_contains_prohibition(permit_dict: dict[str, Any]) -> None:
    context = build_cro_context(permit_dict)
    prompt = build_cro_prompt(context)
    assert "Do not try to approve or reject this trade" in prompt
    assert "that decision is final" in prompt


def test_context_has_ai_generated_label(permit_dict: dict[str, Any]) -> None:
    context = build_cro_context(permit_dict)
    assert context.ai_generated_label == "AI-generated"


def test_narration_has_ai_generated_label(permit_dict: dict[str, Any]) -> None:
    context = build_cro_context(permit_dict)
    narration = CRONarration(
        permit_id=context.permit_id,
        status=context.status,
        quality_score=context.quality_score,
        narration="Hello",
    )
    assert narration.ai_generated_label == "AI-generated"
