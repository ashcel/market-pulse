from fastapi import APIRouter

from .schemas import (
    RallyReadResponse,
    RallyWatcherEvaluateEnvelope,
    RallyWatcherEvaluateRequest,
    RallyWatcherScanData,
    RallyWatcherScanEnvelope,
)
from .service import evaluate_rally_live, scan_rallies

router = APIRouter(prefix="/rally-watcher", tags=["rally-watcher"])


def _to_response(read) -> RallyReadResponse:  # noqa: ANN001 — smc.rally_watcher.RallyRead
    return RallyReadResponse(
        symbol=read.symbol,
        direction=read.direction,
        gain_pct=read.gain_pct,
        volume_mult=read.volume_mult,
        momentum_score=read.momentum_score,
        extended=read.extended,
        targets=read.targets,
        liquidity=read.liquidity,
        explanation=read.explanation,
        evaluated_at=read.evaluated_at,
        oi_available=read.oi_available,
        version=read.version,
    )


@router.post(
    "/scan",
    response_model=RallyWatcherScanEnvelope,
    summary="Live 15-minute rally scan over the dynamic perp universe (~60s server cache)",
)
async def post_scan() -> RallyWatcherScanEnvelope:
    result = await scan_rallies()
    return RallyWatcherScanEnvelope(
        data=RallyWatcherScanData(
            updated_at=result.updated_at,
            universe_size=result.universe_size,
            rallies=[_to_response(r) for r in result.rallies],
            scanning=result.scanning,
        )
    )


@router.post(
    "/evaluate",
    response_model=RallyWatcherEvaluateEnvelope,
    summary="Evaluate RALLY WATCHER live for one symbol",
)
async def post_evaluate(payload: RallyWatcherEvaluateRequest) -> RallyWatcherEvaluateEnvelope:
    read = await evaluate_rally_live(payload.symbol)
    if read is None:
        return RallyWatcherEvaluateEnvelope(data=None)
    return RallyWatcherEvaluateEnvelope(data=_to_response(read))
