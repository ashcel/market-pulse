"""Canonical asset mapping: internal bare ticker ↔ provider-specific IDs.

Providers identify coins by their own IDs, and ticker strings collide across
projects — so calendar/market ingestion matches by provider ID, NEVER by raw
ticker text. This map is a code constant: a PR-reviewed ~50-entry table beats
a DB table that needs seeding and can drift silently. A unit test asserts
every WORKER_UNIVERSE ticker has an explicit entry; None is allowed but must
be deliberate. Provider coins that map to no entry are dropped at ingest —
high-signal over volume. Port of asset-ids.ts.
"""

from dataclasses import dataclass


@dataclass(slots=True)
class AssetIds:
    coingecko_id: str | None
    coinmarketcal_id: str | None


ASSET_IDS: dict[str, AssetIds] = {
    "BTC": AssetIds("bitcoin", "bitcoin"),
    "ETH": AssetIds("ethereum", "ethereum"),
    "SOL": AssetIds("solana", "solana"),
    "BNB": AssetIds("binancecoin", "binance-coin"),
    "XRP": AssetIds("ripple", "xrp"),
    "ADA": AssetIds("cardano", "cardano"),
    "AVAX": AssetIds("avalanche-2", "avalanche"),
    "SUI": AssetIds("sui", "sui"),
    "NEAR": AssetIds("near", "near-protocol"),
    "LINK": AssetIds("chainlink", "chainlink"),
    "UNI": AssetIds("uniswap", "uniswap"),
    "AAVE": AssetIds("aave", "aave"),
    "FET": AssetIds("artificial-superintelligence-alliance", "fetch-ai"),
    "RENDER": AssetIds("render-token", "render"),
    "TAO": AssetIds("bittensor", "bittensor"),
    "DOGE": AssetIds("dogecoin", "dogecoin"),
    "PEPE": AssetIds("pepe", "pepe"),
    "WIF": AssetIds("dogwifcoin", "dogwifhat"),
    "LTC": AssetIds("litecoin", "litecoin"),
    "BCH": AssetIds("bitcoin-cash", "bitcoin-cash"),
    "ETC": AssetIds("ethereum-classic", "ethereum-classic"),
    "DOT": AssetIds("polkadot", "polkadot"),
    "ATOM": AssetIds("cosmos", "cosmos"),
    "FIL": AssetIds("filecoin", "filecoin"),
    "APT": AssetIds("aptos", "aptos"),
    "ARB": AssetIds("arbitrum", "arbitrum"),
    "OP": AssetIds("optimism", "optimism"),
    "TRX": AssetIds("tron", "tron"),
    "XLM": AssetIds("stellar", "stellar"),
    "HBAR": AssetIds("hedera-hashgraph", "hedera"),
    "ICP": AssetIds("internet-computer", "internet-computer"),
    "TIA": AssetIds("celestia", "celestia"),
    "SEI": AssetIds("sei-network", "sei"),
    "ALGO": AssetIds("algorand", "algorand"),
    "STX": AssetIds("blockstack", "stacks"),
    "INJ": AssetIds("injective-protocol", "injective"),
    "LDO": AssetIds("lido-dao", "lido-dao"),
    "CRV": AssetIds("curve-dao-token", "curve-dao-token"),
    "RUNE": AssetIds("thorchain", "thorchain"),
    "ENA": AssetIds("ethena", "ethena"),
    "ONDO": AssetIds("ondo-finance", "ondo"),
    "JUP": AssetIds("jupiter-exchange-solana", "jupiter"),
    "ETHFI": AssetIds("ether-fi", "ether-fi"),
    "GRT": AssetIds("the-graph", "the-graph"),
    "WLD": AssetIds("worldcoin-wld", "worldcoin"),
    "AR": AssetIds("arweave", "arweave"),
    "SHIB": AssetIds("shiba-inu", "shiba-inu"),
    "BONK": AssetIds("bonk", "bonk"),
    "IMX": AssetIds("immutable-x", "immutable"),
    "ZEC": AssetIds("zcash", "zcash"),
}

# Reverse lookup: CoinMarketCal coin ID → canonical ticker.
TICKER_BY_COINMARKETCAL_ID: dict[str, str] = {
    ids.coinmarketcal_id: ticker
    for ticker, ids in ASSET_IDS.items()
    if ids.coinmarketcal_id is not None
}

# Every mapped CoinMarketCal ID — the ingest query's `coins=` filter.
COINMARKETCAL_IDS: list[str] = [
    ids.coinmarketcal_id for ids in ASSET_IDS.values() if ids.coinmarketcal_id is not None
]
