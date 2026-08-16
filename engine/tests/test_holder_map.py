"""Holder map — classification, concentration math, and layout determinism.

The classification tests matter most: counting a liquidity pool as a whale
makes every honest token look like a rug, which would poison the screener's
single highest-weighted risk component.
"""

from smc.holder_map import (
    BURN_ADDRESSES,
    RawHolder,
    build_holder_map,
    classify,
)


def wallet(address: str, balance: float, **kwargs) -> RawHolder:
    return RawHolder(address=address, balance=balance, **kwargs)


class TestClassification:
    def test_burn_addresses(self) -> None:
        for address in BURN_ADDRESSES:
            assert classify(wallet(address, 100)) == "burn"

    def test_zero_address_variants(self) -> None:
        assert classify(wallet("0x0000000000000000000000000000000000000000", 1)) == "burn"

    def test_pool_tags(self) -> None:
        assert classify(wallet("0xabc", 1, tags=("PancakeSwap V3: KII-WBNB",))) == "pool"
        assert classify(wallet("0xabc", 1, tags=("Uniswap V2 Pair",))) == "pool"
        assert classify(wallet("So1", 1, tags=("Raydium AMM",))) == "pool"

    def test_bridges_count_as_pools(self) -> None:
        assert classify(wallet("0xabc", 1, tags=("Wormhole Bridge",))) == "pool"

    def test_exchange_and_team_tags(self) -> None:
        assert classify(wallet("0xabc", 1, tags=("Binance Hot Wallet",))) == "exchange"
        assert classify(wallet("0xabc", 1, tags=("Team Vesting",))) == "team"

    def test_unlabelled_contract_stays_a_contract(self) -> None:
        assert classify(wallet("0xabc", 1, is_contract=True)) == "contract"

    def test_plain_wallet(self) -> None:
        assert classify(wallet("0xdeadbeefcafe", 1)) == "wallet"


class TestConcentration:
    def test_pools_and_burns_are_excluded_from_concentration(self) -> None:
        """The whole point: a pool holding 40% is liquidity, not a whale."""
        holders = [
            wallet("0xpool", 400, tags=("PancakeSwap V3 Pair",)),
            wallet("0x000000000000000000000000000000000000dead", 100),
            *[wallet(f"0xholder{i}", 50) for i in range(10)],
        ]
        result = build_holder_map("TEST", holders, total_supply=1000)

        assert result.pool_pct == 0.4
        assert result.burn_pct == 0.1
        assert result.holders_counted == 10
        # 10 wallets x 50 = 500, over an effective supply of 1000 - 400 - 100.
        assert result.top10_pct is not None
        assert abs(result.top10_pct - 1.0) < 1e-6

    def test_a_dominant_wallet_is_reported(self) -> None:
        holders = [wallet("0xwhale", 700), *[wallet(f"0x{i}", 30) for i in range(10)]]
        result = build_holder_map("TEST", holders, total_supply=1000)
        assert result.largest_holder_pct is not None
        assert result.largest_holder_pct > 0.65

    def test_hhi_separates_dispersed_from_concentrated(self) -> None:
        dispersed = build_holder_map(
            "A", [wallet(f"0x{i}", 10) for i in range(50)], total_supply=500
        )
        concentrated = build_holder_map(
            "B", [wallet("0xwhale", 450), *[wallet(f"0x{i}", 1) for i in range(50)]],
            total_supply=500,
        )
        assert dispersed.hhi is not None and concentrated.hhi is not None
        assert concentrated.hhi > dispersed.hhi

    def test_unavailable_reason_short_circuits(self) -> None:
        result = build_holder_map("TEST", [], unavailable_reason="no_indexer_key_for_chain")
        assert result.unavailable_reason == "no_indexer_key_for_chain"
        assert result.bubbles == []
        assert result.top10_pct is None

    def test_empty_holder_list_is_not_a_perfect_distribution(self) -> None:
        result = build_holder_map("TEST", [])
        assert result.top10_pct is None
        assert result.unavailable_reason is not None


class TestLayout:
    def test_layout_is_deterministic(self) -> None:
        holders = [wallet(f"0x{i}", 100 - i) for i in range(20)]
        first = build_holder_map("TEST", holders, total_supply=2000)
        second = build_holder_map("TEST", holders, total_supply=2000)
        assert [(b.x, b.y, b.r) for b in first.bubbles] == [
            (b.x, b.y, b.r) for b in second.bubbles
        ]

    def test_bubbles_stay_inside_the_unit_box(self) -> None:
        holders = [wallet(f"0x{i}", (i + 1) * 7) for i in range(40)]
        result = build_holder_map("TEST", holders, total_supply=10_000)
        for bubble in result.bubbles:
            assert -1.0 <= bubble.x <= 1.0
            assert -1.0 <= bubble.y <= 1.0
            assert bubble.r > 0

    def test_bubble_area_tracks_share(self) -> None:
        holders = [wallet("0xbig", 800), wallet("0xsmall", 200)]
        result = build_holder_map("TEST", holders, total_supply=1000)
        big, small = result.bubbles[0], result.bubbles[1]
        assert big.r > small.r
        assert big.pct == 0.8

    def test_bubble_count_is_capped(self) -> None:
        holders = [wallet(f"0x{i}", 100) for i in range(200)]
        result = build_holder_map("TEST", holders, total_supply=20_000, max_bubbles=25)
        assert len(result.bubbles) == 25
        # Capping the *drawing* must not cap the math.
        assert result.holders_counted == 200

    def test_pool_bubbles_are_marked_uncounted(self) -> None:
        holders = [wallet("0xpool", 500, tags=("Uniswap Pair",)), wallet("0xa", 500)]
        result = build_holder_map("TEST", holders, total_supply=1000)
        by_address = {b.address: b for b in result.bubbles}
        assert by_address["0xpool"].counted is False
        assert by_address["0xa"].counted is True
