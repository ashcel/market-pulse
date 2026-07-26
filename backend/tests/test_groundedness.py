from app.review.groundedness import check_memo


def _metric(value: float | None, available: bool = True) -> dict[str, object]:
    return {
        "available": available,
        "value": value,
        "unit": "percent_of_entry",
        "reason": None if available else "no_stop_on_record",
        "flags": [],
        "forensics_version": "1.0.0",
    }


def test_accepts_available_forensic_number_with_rounding() -> None:
    forensics = {
        "metrics": {
            "mae_percent": _metric(3.397),
            "mfe_percent": _metric(8.0),
            "exit_efficiency": _metric(75.0),
        }
    }
    assert check_memo("MAE was 3.40%. Exit efficiency was 75%.", forensics) == []


def test_rejects_unsupported_forensic_number() -> None:
    forensics = {"metrics": {"mae_percent": _metric(3.4)}}
    assert check_memo("MAE was 9.2%.", forensics) == ["MAE was 9.2%."]


def test_ignores_non_forensic_numbers() -> None:
    assert check_memo("Execution score: 7. Entry price was 50000.", {"metrics": {}}) == []


def test_unavailable_metric_cannot_ground_a_claim() -> None:
    """An R value with no evidenced stop is unavailable — the memo may not cite one."""
    forensics = {"metrics": {"mae_r": _metric(None, available=False)}}
    assert check_memo("MAE was 0.90R.", forensics) == ["MAE was 0.90R."]
