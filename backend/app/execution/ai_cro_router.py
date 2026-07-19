"""AI CRO narration router — M9-T12 (EDR 0020 decision 2 AI clause).

POST /execution/permits/{permit_id}/cro-narration

The AI CRO explains permit decisions but never determines them. The response
schema carries decision fields COPIED from the permit — the model output cannot
alter status, reasons, or quality_score.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db

from .ai_cro import CRONarration, build_cro_context, build_cro_prompt
from .permit_service import get_permit

router = APIRouter(prefix="/execution/permits", tags=["execution"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


class CRONarrationRequest(BaseModel):
    api_key: str
    api_provider: str = "openai"


@router.post(
    "/{permit_id}/cro-narration",
    response_model=CRONarration,
    summary="AI CRO narration for a permit (BYOK — key is used in-request, never stored)",
)
async def get_cro_narration(
    permit_id: str,
    request: CRONarrationRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> CRONarration:
    """Return an AI CRO narration for the given permit.

    The AI explains the decision — it does not determine it.  Status,
    quality_score, and reasons are copied from the persisted permit record,
    never from the model output.

    Note: the api_key is used within this request and never stored.
    """
    permit = await get_permit(db, permit_id)
    if permit.user_id != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    permit_dict = {
        "id": permit.id,
        "status": permit.status,
        "reasons": permit.reasons,
        "quality_score": permit.quality_score,
        "quality_components": permit.quality_components,
        "check_results": permit.check_results,
        "proposal_snapshot": permit.proposal_snapshot,
        "account_state_snapshot": permit.account_state_snapshot,
    }

    context = build_cro_context(permit_dict)
    _prompt = build_cro_prompt(context)

    # BYOK stub — real LLM call wired when the user provides a valid key.
    # The `request.api_key` would be passed to litellm/OpenAI/Anthropic here.
    # The narration text is the ONLY model-generated field; decision fields below
    # are ALL copied from the permit (never from model output).
    narration_text = (
        f"[AI-generated] Decision explanation for permit {context.permit_id}: "
        f"Status is {context.status}. "
        f"Provider: {request.api_provider} (key redacted). "
        f"Quality score: {context.quality_score:.1f}. "
        f"No live LLM call made (BYOK key not yet wired)."
    )

    # Critical invariant: status, permit_id, quality_score are COPIED from context
    # (which was derived from the persisted permit), not from model output.
    return CRONarration(
        permit_id=context.permit_id,
        status=context.status,
        quality_score=context.quality_score,
        narration=narration_text,
    )
