"""ForexFactory weekly economic calendar → economic_event normalization.

Pure and fixture-testable, mirroring catalyst_events.py: the worker's econ
pass fetches the keyless weekly JSON, this file decides the stored shape.

The feed (https://nfs.faireconomy.media/ff_calendar_thisweek.json) is a flat
list of items shaped:

    {"title": "Core CPI m/m", "country": "USD", "date": "2026-07-19T18:45:00-04:00",
     "impact": "High", "forecast": "0.3%", "previous": "0.2%"}

``country`` is the affected CURRENCY code (USD, EUR, GBP, JPY, ...), not a
nation; ``impact`` is one of High/Medium/Low/Holiday; ``date`` carries an
Eastern-time offset. These are market-wide macro facts with no ticker — the
downstream read model presents them as a scheduling/backdrop surface, never a
per-token signal.

Port target has no TS counterpart — this plane is Python-native.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

EconImpact = Literal["high", "medium", "low", "holiday"]

# The feed's impact strings, lowercased. Anything unexpected falls back to
# "low" so an odd row is stored (visible) rather than dropped.
_IMPACT_MAP: dict[str, EconImpact] = {
    "high": "high",
    "medium": "medium",
    "low": "low",
    "holiday": "holiday",
}


@dataclass(slots=True)
class EconEventInput:
    title: str
    # Affected currency code (USD, EUR, GBP, ...). Kept verbatim from the feed.
    country: str
    impact: EconImpact
    forecast: str | None
    previous: str | None
    # ISO-8601 UTC (…Z) instant the release/event is scheduled for.
    occurs_at: str
    source: str
    # One row per (source, country, title, feed-date) — re-ingestion is a no-op.
    dedup_key: str


def _as_str(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _parse_date_ms(value: str | None) -> float:
    """Feed dates carry an ET offset ('...-04:00'); fromisoformat handles that
    natively on 3.12. NaN when absent/unparseable so the caller drops the row."""
    if not value:
        return math.nan
    try:
        return datetime.fromisoformat(value).timestamp() * 1000
    except ValueError:
        return math.nan


def normalize_forexfactory_events(
    payload: object, source: str = "forexfactory"
) -> list[EconEventInput]:
    """Normalize one ForexFactory weekly-calendar JSON payload. A whole-payload
    shape surprise (not a list) returns [] — the caller records an ingest error
    only when the *fetch* failed; an empty/odd page is valid. Individual rows
    missing a title or a parseable date are skipped, never fatal."""
    if not isinstance(payload, list):
        return []
    out: list[EconEventInput] = []
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        title = _as_str(raw.get("title"))
        country = _as_str(raw.get("country"))
        date_raw = _as_str(raw.get("date"))
        occurs_ms = _parse_date_ms(date_raw)
        if not title or not country or not math.isfinite(occurs_ms):
            continue

        impact = _IMPACT_MAP.get((_as_str(raw.get("impact")) or "").lower(), "low")
        occurs_at = (
            datetime.fromtimestamp(occurs_ms / 1000, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        # The dedup key is built from the RAW feed date string, not the derived
        # UTC instant, so it stays byte-stable across re-ingests regardless of
        # any tz-normalization change here.
        out.append(
            EconEventInput(
                title=title,
                country=country,
                impact=impact,
                forecast=_as_str(raw.get("forecast")),
                previous=_as_str(raw.get("previous")),
                occurs_at=occurs_at,
                source=source,
                dedup_key=f"{source}:{country}:{title}:{date_raw}",
            )
        )
    return out
