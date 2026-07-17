"""market.py has no market.test.ts counterpart — these pin the port's
snapshot invariants and the universe contract (cf. worker-universe.test.ts).
"""

from dataclasses import replace

from smc.market import (
    SECTOR_ORDER,
    UNIVERSE,
    WORKER_UNIVERSE,
    build_demo_snapshot,
    tradingview_symbol,
)


def test_universe_tickers_are_unique_and_worker_universe_is_a_superset() -> None:
    tickers = [u.ticker for u in WORKER_UNIVERSE]
    assert len(tickers) == len(set(tickers))
    assert len(UNIVERSE) == 18
    assert WORKER_UNIVERSE[: len(UNIVERSE)] == UNIVERSE
    assert all(u.sector for u in WORKER_UNIVERSE)


def test_tradingview_symbol() -> None:
    assert tradingview_symbol("sol") == "BINANCE:SOLUSDT"


def test_demo_snapshot_is_deterministic_up_to_its_timestamp() -> None:
    a = build_demo_snapshot()
    b = build_demo_snapshot()
    a_stamped = replace(a, updated_at="")
    b_stamped = replace(b, updated_at="")
    assert a_stamped == b_stamped


def test_demo_snapshot_invariants() -> None:
    snapshot = build_demo_snapshot()
    assert snapshot.source == "demo"

    # Every UNIVERSE asset present, ranked best-score first.
    assert len(snapshot.assets) == len(UNIVERSE)
    assert {a.ticker for a in snapshot.assets} == {u.ticker for u in UNIVERSE}
    for i in range(1, len(snapshot.assets)):
        assert snapshot.assets[i - 1].score >= snapshot.assets[i].score

    for asset in snapshot.assets:
        for score in (
            asset.momentum,
            asset.strength,
            asset.volume,
            asset.technical,
            asset.confidence,
            asset.score,
        ):
            assert 0 <= score <= 100
        # Relative read is attached to every scored asset (BTC included: 0 vs itself).
        assert asset.rs_btc24h is not None
        assert len(asset.spark) == 48

    btc = next(a for a in snapshot.assets if a.ticker == "BTC")
    assert btc.rs_btc24h == 0
    assert btc.corr_btc7d == 1

    # Signals exist per asset and always lead with the decision row.
    assert set(snapshot.asset_signals) == {u.ticker for u in UNIVERSE}
    for signals in snapshot.asset_signals.values():
        assert signals.signals[0].label == "Decision"
        assert 0 <= signals.confidence <= 100

    # Regime read model shape.
    assert snapshot.regime.regime in ("Risk On", "Risk Off", "Neutral")
    assert [p.label for p in snapshot.regime.pillars] == [
        "Trend",
        "Breadth",
        "Volatility",
        "Momentum",
        "Participation",
    ]
    assert 45 <= snapshot.regime.confidence <= 97

    # Rotation orders sectors losers → winners over the curated sector list.
    assert set(snapshot.rotation.flow) <= set(SECTOR_ORDER)
    assert len(snapshot.rotation.legs) == len(snapshot.rotation.flow) - 1
    for i, leg in enumerate(snapshot.rotation.legs):
        assert leg.from_sector == snapshot.rotation.flow[i]
        assert leg.to_sector == snapshot.rotation.flow[i + 1]
        assert 0 <= leg.strength <= 100
    assert snapshot.rotation.winning == snapshot.rotation.flow[-1]
    assert snapshot.rotation.losing == snapshot.rotation.flow[0]
    assert len(snapshot.sectors) == len(UNIVERSE)

    # Sentiment falls back to the internal proxy without a Fear & Greed value.
    assert snapshot.sentiment.source == "proxy"
    assert 0 <= snapshot.sentiment.fear_greed <= 100

    assert snapshot.volatility.label in ("Low", "Medium", "High")
    assert len(snapshot.volatility.spark) > 0


def test_snapshot_marks_source_as_given() -> None:
    # build_snapshot trusts the caller's provenance label (the fetch layer
    # decides live vs demo); the demo builder always says demo.
    assert build_demo_snapshot().source == "demo"
