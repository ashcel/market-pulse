"""Ground numeric forensic claims in an AI memo against persisted measurements."""

import math
import re
from collections.abc import Mapping
from typing import Any

_NUMBER_RE = re.compile(r"(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?")
_CLAIM_RE = re.compile(r"[^\n]+")
_FIELDS_BY_TERM = {
    "mae": ("mae_price", "mae_percent", "mae_r"),
    "maximum adverse excursion": ("mae_price", "mae_percent", "mae_r"),
    "mfe": ("mfe_price", "mfe_percent", "mfe_r"),
    "maximum favorable excursion": ("mfe_price", "mfe_percent", "mfe_r"),
    "efficiency": ("exit_efficiency",),
    "slippage": ("slippage_adverse", "slippage_adverse_r"),
    "past stop": ("violation_depth_r",),
    "violation depth": ("violation_depth_r",),
    "realized r": ("realized_r",),
    "re-entry": ("reentry_latency_seconds",),
    "reentry": ("reentry_latency_seconds",),
    "notional": ("sizing_notional",),
    "size ratio": ("sizing_size_ratio",),
    "median size": ("sizing_median",),
}


def _metrics(forensics: object) -> Mapping[str, Any]:
    if isinstance(forensics, Mapping):
        raw = forensics.get("metrics")
    else:
        raw = getattr(forensics, "metrics", None)
    return raw if isinstance(raw, Mapping) else {}


def _get(forensics: object, field: str) -> Any:
    """Only an *available* measurement can ground a claim — an unavailable
    metric carries `value: null` and must never back a number in the memo."""
    metric = _metrics(forensics).get(field)
    if isinstance(metric, Mapping):
        return metric.get("value") if metric.get("available") else None
    return getattr(metric, "value", None) if getattr(metric, "available", False) else None


def _matches(claimed: float, actual: float) -> bool:
    """Allow normal memo rounding while rejecting materially different values."""
    return math.isclose(claimed, actual, rel_tol=0.005, abs_tol=0.01) or any(
        math.isclose(claimed, round(actual, digits), abs_tol=10 ** (-digits) / 2)
        for digits in range(3)
    )


def check_memo(memo_text: str, forensics: object) -> list[str]:
    """Return forensic numeric claims unsupported by the supplied row."""
    unsupported: list[str] = []
    for raw_claim in _CLAIM_RE.findall(memo_text):
        claim = raw_claim.strip()
        lower = claim.lower()
        fields = {
            field
            for term, term_fields in _FIELDS_BY_TERM.items()
            if term in lower
            for field in term_fields
        }
        if not fields:
            continue
        expected = [
            float(value)
            for field in fields
            if isinstance((value := _get(forensics, field)), (int, float))
        ]
        numbers = [float(match.replace(",", "")) for match in _NUMBER_RE.findall(claim)]
        if numbers and (
            not expected
            or any(not any(_matches(number, value) for value in expected) for number in numbers)
        ):
            unsupported.append(claim)
    return unsupported
