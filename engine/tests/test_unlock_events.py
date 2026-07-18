"""DeFiLlama emissions → unlock catalyst normalization: cliff selection,
per-day aggregation, percent-of-supply, dust gate, size-unknown cap."""

from typing import Any

from smc.unlock_events import normalize_defillama_unlocks

NOW_MS = 1_784_030_400_000  # 2026-07-13T12:00:00Z
DAY_MS = 24 * 60 * 60_000


def payload(events: list[dict[str, Any]], max_supply: float | None = 1_000_000.0) -> dict[str, Any]:
    supply = {"maxSupply": max_supply} if max_supply is not None else {}
    return {"metadata": {"events": events}, "supplyMetrics": supply}


def cliff(days_ahead: float, tokens: float, unlock_type: str = "cliff") -> dict[str, Any]:
    return {
        "timestamp": (NOW_MS + days_ahead * DAY_MS) / 1000,
        "unlockType": unlock_type,
        "noOfTokens": [0, tokens],
    }


def test_selects_future_cliff_and_computes_percent() -> None:
    out = normalize_defillama_unlocks(payload([cliff(10, 50_000)]), "ARB", "arb-f", NOW_MS)
    assert len(out) == 1
    ev = out[0]
    assert ev.kind == "unlock"
    assert ev.source == "defillama"
    assert ev.percent_of_supply == 0.05  # 50k / 1M
    assert "5.00% of supply" in ev.title
    assert ev.dedup_key.startswith("defillama:arb-f:")


def test_aggregates_same_day_tranches() -> None:
    out = normalize_defillama_unlocks(
        payload([cliff(10, 30_000), cliff(10.3, 20_000)]), "ARB", "arb-f", NOW_MS
    )
    assert len(out) == 1
    assert out[0].percent_of_supply == 0.05  # (30k+20k)/1M, one day


def test_drops_past_out_of_horizon_and_linear() -> None:
    events = [
        cliff(-5, 90_000),  # past
        cliff(200, 90_000),  # beyond horizon
        cliff(10, 90_000, unlock_type="linear"),  # continuous drip, not a catalyst
    ]
    assert normalize_defillama_unlocks(payload(events), "X", "x", NOW_MS) == []


def test_dust_gate_when_supply_known() -> None:
    # 0.05% (500/1M) is below the 0.1% default gate.
    assert normalize_defillama_unlocks(payload([cliff(10, 500)]), "X", "x", NOW_MS) == []


def test_size_unknown_kept_but_capped() -> None:
    events = [cliff(d, 1_000) for d in (5, 10, 15, 20, 25)]
    out = normalize_defillama_unlocks(payload(events, max_supply=None), "X", "x", NOW_MS)
    assert len(out) == 3  # _SIZE_UNKNOWN_CAP
    assert all(e.percent_of_supply is None for e in out)
    assert all("size unknown" in e.title for e in out)


def test_shape_tolerance() -> None:
    assert normalize_defillama_unlocks(None, "X", "x", NOW_MS) == []
    assert normalize_defillama_unlocks({}, "X", "x", NOW_MS) == []
    assert normalize_defillama_unlocks({"metadata": {}}, "X", "x", NOW_MS) == []
