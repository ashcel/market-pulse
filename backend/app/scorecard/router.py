"""GET /api/v1/scorecard — the evidence Lab renders (Sprint 5 task 3).

Read-only over `source_scorecard`. Rows are served exactly as the nightly pass
stored them (per regime, per horizon); the coarser fold used by the Ideas feed
lives in `evidence_table_for` and is deliberately not what this returns — Lab
is the place where the slices are supposed to be visible.

`enabled` and `min_n` ride along in `meta` so the UI can say *why* a number is
missing ("cron off" vs "belum cukup data") without a second call.

The per-source headline is folded HERE rather than in the client, because the
served rows have `hit_rate` nulled below the threshold: folding those client
side would silently weight a sub-threshold regime slice as 0% even when the
slices together clear the threshold. The fold reads the raw stored numbers.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Query

from app.auth.dependencies import CurrentUserId, DbSession
from app.config import settings
from app.opportunities.service import EVIDENCE_MIN_N

from .models import SourceScorecard
from .service import list_scorecard

router = APIRouter(prefix="/scorecard", tags=["scorecard"])


def summarize_by_source(rows: list[SourceScorecard]) -> list[dict[str, Any]]:
    """One headline per source, n-weighted across regimes and horizons."""
    acc: dict[str, dict[str, Any]] = {}
    for row in rows:
        bucket = acc.setdefault(
            row.source,
            {
                "source": row.source,
                "n": 0,
                "_hr": 0.0,
                "_r": 0.0,
                "window_days": row.window_days,
                "horizons": set(),
                "versions": set(),
            },
        )
        bucket["n"] += row.n
        bucket["_hr"] += (row.hit_rate or 0.0) * row.n
        bucket["_r"] += (row.avg_r or 0.0) * row.n
        bucket["horizons"].add(row.horizon)
        bucket["versions"].add(row.source_version)

    out = []
    for bucket in acc.values():
        n = bucket["n"]
        ok = n >= EVIDENCE_MIN_N
        out.append(
            {
                "source": bucket["source"],
                "n": n,
                "hit_rate": (bucket["_hr"] / n) if ok and n else None,
                "avg_r": (bucket["_r"] / n) if ok and n else None,
                "status": "ok" if ok else "insufficient",
                "window_days": bucket["window_days"],
                "horizons": sorted(bucket["horizons"]),
                "versions": sorted(bucket["versions"]),
            }
        )
    return sorted(out, key=lambda item: (-item["n"], item["source"]))


@router.get("", summary="Source track record per regime and horizon")
async def get_scorecard(
    db: DbSession,
    _user_id: CurrentUserId,
    source: Annotated[str | None, Query(max_length=32)] = None,
) -> dict[str, Any]:
    rows = await list_scorecard(db, source=source)
    return {
        "data": [
            {
                "source": row.source,
                "source_version": row.source_version,
                "regime": row.regime,
                "horizon": row.horizon,
                "window_days": row.window_days,
                "n": row.n,
                # Same rule as the Ideas card: under the threshold there is no
                # number, not a small one (R3).
                "hit_rate": row.hit_rate if row.n >= EVIDENCE_MIN_N else None,
                "avg_r": row.avg_r if row.n >= EVIDENCE_MIN_N else None,
                "status": "ok" if row.n >= EVIDENCE_MIN_N else "insufficient",
                "computed_at": row.computed_at.isoformat() if row.computed_at else None,
            }
            for row in rows
        ],
        "meta": {
            "count": len(rows),
            "by_source": summarize_by_source(rows),
            "enabled": settings.SCORECARD_ENABLED,
            "min_n": EVIDENCE_MIN_N,
            "live_sources": list(settings.SIGNAL_SOURCES_LIVE),
        },
        "error": None,
    }
