from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CROContext:
    permit_id: str
    status: str
    reasons: list[str]
    quality_score: float
    quality_components: list[dict[str, Any]]
    check_results: list[dict[str, Any]]
    behavior_flags: list[str]
    recent_pnl_summary: str
    trade_count_summary: str
    proposed_symbol: str
    proposed_side: str
    proposed_rr: str
    ai_generated_label: str = "AI-generated"


def build_cro_context(
    permit_record: dict[str, Any],
    recent_pnl_summary: str = "",
    trade_count_summary: str = "",
) -> CROContext:
    proposal = permit_record.get("proposal_snapshot", {})

    # Calculate proposed RR from the proposal dict directly if possible
    stop_price = proposal.get("stop_price")
    take_profit_price = proposal.get("take_profit_price")
    entry_price = proposal.get("entry_price")
    side = proposal.get("side")

    proposed_rr = "N/A (no target set)"
    if stop_price and take_profit_price and entry_price:
        try:
            entry = float(entry_price)
            stop = float(stop_price)
            tp = float(take_profit_price)
            if side == "LONG":
                risk = entry - stop
                reward = tp - entry
            else:
                risk = stop - entry
                reward = entry - tp

            if risk > 0 and reward > 0:
                proposed_rr = f"{reward / risk:.2f}:1"
        except (ValueError, TypeError):
            pass

    account_state = permit_record.get("account_state_snapshot", {})
    behavior_flags = list(account_state.get("active_behavior_flags", []))

    if not recent_pnl_summary:
        daily = account_state.get("daily_realized_pnl_percent", "0")
        weekly = account_state.get("weekly_realized_pnl_percent", "0")
        recent_pnl_summary = f"Today: {daily}%, This week: {weekly}%"

    if not trade_count_summary:
        trade_count_summary = "N/A"

    return CROContext(
        permit_id=permit_record["id"],
        status=permit_record["status"],
        reasons=permit_record.get("reasons", []),
        quality_score=float(permit_record.get("quality_score", 0.0)),
        quality_components=permit_record.get("quality_components", []),
        check_results=permit_record.get("check_results", []),
        behavior_flags=behavior_flags,
        recent_pnl_summary=recent_pnl_summary,
        trade_count_summary=trade_count_summary,
        proposed_symbol=proposal.get("symbol", "UNKNOWN"),
        proposed_side=side or "UNKNOWN",
        proposed_rr=proposed_rr,
    )


def build_cro_prompt(context: CROContext) -> str:
    lines = [
        f"This trade has been {context.status} by the deterministic risk engine. "
        "Your role is explanation and advice only. "
        "Do not try to approve or reject this trade "
        "— that decision is final and shown above.",
        "",
        f"Symbol: {context.proposed_symbol}",
        f"Side: {context.proposed_side}",
        f"R:R: {context.proposed_rr}",
        f"Behavior Flags: "
        f"{', '.join(context.behavior_flags) if context.behavior_flags else 'None'}",
        f"Recent PnL: {context.recent_pnl_summary}",
        f"Trade Frequency: {context.trade_count_summary}",
        f"Quality Score: {context.quality_score}",
    ]
    if context.status == "REJECTED":
        lines.append(f"Reasons for rejection: {', '.join(context.reasons)}")

    lines.append("\nCheck Results:")
    for check in context.check_results:
        status = "PASSED" if check.get("passed") else "FAILED"
        lines.append(f"- {check.get('check')}: {status} ({check.get('detail')})")

    lines.append("\nQuality Components:")
    for comp in context.quality_components:
        lines.append(
            f"- {comp.get('component')}: "
            f"{comp.get('points')} pts ({comp.get('detail')})"
        )

    lines.append(
        "\nPlease provide a clear explanation of the decision, "
        "any advice on what would change it, "
        "and risk reminders or improvement suggestions."
    )
    return "\n".join(lines)


@dataclass(frozen=True)
class CRONarration:
    permit_id: str
    status: str
    quality_score: float
    narration: str
    ai_generated_label: str = "AI-generated"
