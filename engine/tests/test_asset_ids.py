"""Port of asset-ids.test.ts — the provider-ID table stays in lockstep with
the worker universe and collision-free."""

from smc.asset_ids import ASSET_IDS, COINMARKETCAL_IDS, TICKER_BY_COINMARKETCAL_ID
from smc.market import WORKER_UNIVERSE


class TestAssetIds:
    def test_explicit_entry_for_every_worker_universe_ticker(self) -> None:
        missing = [u.ticker for u in WORKER_UNIVERSE if u.ticker not in ASSET_IDS]
        assert missing == []

    def test_no_orphan_entries_for_departed_tickers(self) -> None:
        universe = {u.ticker for u in WORKER_UNIVERSE}
        orphans = [t for t in ASSET_IDS if t not in universe]
        assert orphans == []

    def test_provider_ids_are_unique(self) -> None:
        cmc = [v.coinmarketcal_id for v in ASSET_IDS.values() if v.coinmarketcal_id is not None]
        assert len(set(cmc)) == len(cmc)
        gecko = [v.coingecko_id for v in ASSET_IDS.values() if v.coingecko_id is not None]
        assert len(set(gecko)) == len(gecko)

    def test_reverse_map_and_id_list_consistent(self) -> None:
        for ticker, ids in ASSET_IDS.items():
            if ids.coinmarketcal_id is None:
                continue
            assert TICKER_BY_COINMARKETCAL_ID[ids.coinmarketcal_id] == ticker
            assert ids.coinmarketcal_id in COINMARKETCAL_IDS
