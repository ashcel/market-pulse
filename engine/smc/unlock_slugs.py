"""Ticker → DeFiLlama emissions slug resolution for the unlock calendar.

DeFiLlama keys emissions data by a descriptive protocol slug (ARB lives under
`arbitrum-foundation`, ENA under `ethena`), so a ticker can't index it directly
and there is no reverse index endpoint. The reliable join key is `gecko_id`:
every emissions file carries one, and ASSET_IDS already holds each ticker's
canonical CoinGecko id. Fuzzy name matching alone produces dangerous false
positives (XRP→near, ZEC→solana were both observed), so resolution ALWAYS
confirms by exact gecko_id equality — `candidate_slugs` only narrows which
files are worth fetching, it never decides the mapping.

`UNLOCK_SLUG_BY_TICKER` is a PR-reviewed seed for the tracked universe, built
by that exact-join process (see the resolver in worker/unlock_pass.py). Tokens
with no DeFiLlama unlock schedule are simply absent. Out-of-universe tokens the
user opens are resolved at runtime the same way and cached in Postgres.
"""

from __future__ import annotations

import re

# Seed: WORKER_UNIVERSE tickers with a DeFiLlama unlock schedule, resolved by
# exact gecko_id join. Absent tickers (ETH, BTC-likes, most L1s) have no
# emissions/unlock data — that is a correct "no upcoming unlocks", not a gap.
UNLOCK_SLUG_BY_TICKER: dict[str, str] = {
    "AAVE": "aave",
    "APT": "aptos",
    "ARB": "arbitrum-foundation",
    "AVAX": "avalanche",
    "BTC": "bitcoin",
    "CRV": "curve-finance",
    "DOGE": "dogecoin",
    "DOT": "polkadot-treasury",
    "ENA": "ethena",
    "ETHFI": "ether.fi",
    "FIL": "filecoin",
    "GRT": "the-graph",
    "HBAR": "hedera",
    "ICP": "internet-computer",
    "IMX": "immutablex",
    "INJ": "injective-orderbook",
    "JUP": "jupiter",
    "LDO": "lido",
    "LINK": "chainlink",
    "LTC": "litecoin",
    "NEAR": "near",
    "ONDO": "ondo-finance",
    "OP": "optimism-foundation",
    "RUNE": "thorchain-dex",
    "SEI": "sei",
    "SOL": "solana",
    "SUI": "sui-foundation",
    "TAO": "bittensor",
    "TIA": "celestia",
    "TRX": "tron",
    "UNI": "uniswap",
    "WLD": "worldcoin",
}


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def candidate_slugs(
    ticker: str,
    coingecko_id: str | None,
    name: str | None,
    slugs: list[str],
) -> list[str]:
    """Emissions slugs worth fetching to test for `ticker`, shortest first.

    Narrowing only — the caller MUST confirm each candidate by exact gecko_id
    equality before accepting it. Matches a slug when its normalized form shares
    the gecko-id stem, the token-name stem, or equals the bare ticker.
    """
    ncg = _norm(coingecko_id)
    nnm = _norm(name)
    ntk = ticker.lower()
    out: list[str] = []
    for s in slugs:
        ns = _norm(s)
        if (
            (ncg and (ncg in ns or ns in ncg))
            or ns == ntk
            or (nnm and (nnm in ns or ns.startswith(nnm)))
        ):
            out.append(s)
    return sorted(out, key=len)
