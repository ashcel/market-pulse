"""Port of catalyst-events.test.ts — provider-ID mapping, credibility gate,
kind classification, and shape tolerance."""

from datetime import UTC, datetime, timedelta
from typing import Any

from smc.catalyst_events import normalize_coinmarketcal_events, passes_credibility_gate

NOW_MS = 1_784_030_400_000  # 2026-07-13T12:00:00Z


def days_ahead(d: float) -> str:
    return (
        (datetime.fromtimestamp(NOW_MS / 1000, tz=UTC) + timedelta(days=d))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def cmc_event(**overrides: object) -> dict[str, Any]:
    """Shape-faithful CoinMarketCal /v1/events entry."""
    event: dict[str, Any] = {
        "id": "123456",
        "title": {"en": "SOL token unlock"},
        "description": {"en": "Cliff unlock for team allocation"},
        "coins": [{"id": "solana", "symbol": "SOL", "fullname": "Solana"}],
        "date_event": days_ahead(3),
        "categories": [{"id": 5, "name": "Token Unlock"}],
        "proof": "https://coinmarketcal.com/proof/123456.png",
        "source": "https://example.com/announcement",
        "vote_count": 41,
        "percentage": 92,
    }
    event.update(overrides)
    return event


def normalize(events: list[dict[str, Any]]) -> list[Any]:
    return normalize_coinmarketcal_events({"body": events}, NOW_MS)


class TestNormalizeCoinMarketCalEvents:
    def test_well_formed_unlock_via_provider_id_mapping(self) -> None:
        event = normalize([cmc_event()])[0]
        assert event.symbol == "SOL"
        assert event.kind == "unlock"
        assert event.title == "SOL token unlock"
        assert event.source == "coinmarketcal"
        assert event.source_id == "123456"
        assert event.url == "https://coinmarketcal.com/proof/123456.png"
        assert event.credibility.votes == 41
        assert event.credibility.confidence_pct == 92
        assert event.percent_of_supply is None
        assert event.dedup_key == "coinmarketcal:123456:SOL"
        assert event.occurs_at == days_ahead(3)

    def test_maps_by_provider_id_never_ticker_text(self) -> None:
        events = normalize(
            [
                cmc_event(
                    coins=[
                        {"id": "solana", "symbol": "SOL"},
                        {"id": "some-obscure-fork", "symbol": "SOL"},  # collision: must not map
                    ]
                )
            ]
        )
        assert len(events) == 1
        assert events[0].symbol == "SOL"

    def test_fans_multi_coin_event_to_one_row_per_mapped_coin(self) -> None:
        events = normalize(
            [cmc_event(coins=[{"id": "bitcoin"}, {"id": "ethereum"}, {"id": "unmapped-coin"}])]
        )
        assert sorted(e.symbol for e in events) == ["BTC", "ETH"]
        # Distinct dedup keys per symbol.
        assert len({e.dedup_key for e in events}) == 2

    def test_classifies_categories_into_kinds(self) -> None:
        def kind_of(name: str) -> str:
            kind: str = normalize([cmc_event(categories=[{"name": name}])])[0].kind
            return kind

        assert kind_of("Token Unlock") == "unlock"
        assert kind_of("Exchange Listing") == "listing"
        assert kind_of("Hard Fork") == "fork"
        assert kind_of("Burn Event") == "burn"
        assert kind_of("Mainnet Release") == "upgrade"
        assert kind_of("AMA Session") == "other"

    def test_drops_events_failing_credibility_gate(self) -> None:
        no_cred = cmc_event(proof=None, source=None, vote_count=3, percentage=40)
        assert normalize([no_cred]) == []
        # Each leg of the gate is individually sufficient.
        assert passes_credibility_gate("https://x", None, None) is True
        assert passes_credibility_gate(None, 15, None) is True
        assert passes_credibility_gate(None, None, 80) is True
        assert passes_credibility_gate(None, 14, 79) is False

    def test_drops_past_events_but_tolerates_timezone_slack(self) -> None:
        assert normalize([cmc_event(date_event=days_ahead(-2))]) == []
        assert len(normalize([cmc_event(date_event=days_ahead(-0.5))])) == 1

    def test_returns_empty_on_shape_surprises(self) -> None:
        assert normalize_coinmarketcal_events(None, NOW_MS) == []
        assert normalize_coinmarketcal_events({"body": "nope"}, NOW_MS) == []
        assert normalize([{"title": None, "date_event": "garbage"}]) == []
