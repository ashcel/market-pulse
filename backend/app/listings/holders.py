"""Top-holder collection, routed by chain.

There is no single provider that covers every chain an Alpha token lives on,
and the free ones each cover a slice:

| Chain              | Provider                          | Key needed |
|--------------------|-----------------------------------|------------|
| Solana             | public Solana RPC                 | no         |
| Ethereum, Base     | Blockscout v2                     | no         |
| BSC and the rest   | Etherscan V2 multichain           | yes (paid) |

BSC is the majority of the Alpha universe and has no keyless holder source
that this host can reach — public BSC RPCs reject `eth_getLogs` outright, so
folding Transfer events is not an option either. Rather than fake a
distribution or silently show an empty map, an uncovered chain returns
`unavailable_reason` and the UI says so, and `listing_score` drops the
distribution component instead of scoring the token as well-distributed.
Setting `ETHERSCAN_API_KEY` to a plan with BSC coverage lights it up with no
other change.

Failure convention as everywhere in this plane: never raise, always degrade.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from smc.holder_map import HolderMap, RawHolder, build_holder_map

from app.config import settings

from .sources import _get_json, http_client

logger = logging.getLogger("listings")

SOLANA_RPC = "https://api.mainnet-beta.solana.com"
BLOCKSCOUT_HOSTS: dict[str, str] = {
    "Ethereum": "https://eth.blockscout.com",
    "Base": "https://base.blockscout.com",
}
ETHERSCAN_V2 = "https://api.etherscan.io/v2/api"
# Etherscan V2 chain ids for the chains Alpha tokens actually live on.
ETHERSCAN_CHAIN_IDS: dict[str, int] = {
    "Ethereum": 1,
    "BSC": 56,
    "Base": 8453,
    "Arbitrum": 42161,
    "Polygon": 137,
    "opBNB": 204,
}

TOP_HOLDER_LIMIT = 50


async def _rpc(url: str, method: str, params: list[Any]) -> Any | None:
    try:
        response = await http_client().post(
            url,
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            headers={"content-type": "application/json"},
        )
        if response.status_code != 200:
            return None
        payload = response.json()
        if not isinstance(payload, dict) or "error" in payload:
            return None
        return payload.get("result")
    except Exception as exc:
        logger.warning("listings: rpc %s failed: %s", method, exc)
        return None


async def _solana_holders(mint: str) -> tuple[list[RawHolder], float | None, str | None]:
    """Top token accounts, resolved to their owning wallets.

    `getTokenLargestAccounts` returns *token accounts*, not owners — two
    accounts can belong to one wallet, which would understate concentration.
    One batched `getMultipleAccounts` resolves the owners, and balances are
    folded per owner before any concentration math happens.
    """
    largest = await _rpc(SOLANA_RPC, "getTokenLargestAccounts", [mint])
    if not isinstance(largest, dict):
        return [], None, "solana_rpc_unavailable"
    values = largest.get("value")
    if not isinstance(values, list) or not values:
        return [], None, "no_holder_rows"

    supply_result = await _rpc(SOLANA_RPC, "getTokenSupply", [mint])
    supply: float | None = None
    if isinstance(supply_result, dict):
        amount = (supply_result.get("value") or {}).get("uiAmount")
        if isinstance(amount, (int, float)):
            supply = float(amount)

    addresses = [
        row.get("address") for row in values if isinstance(row, dict) and row.get("address")
    ]
    owners: dict[str, str] = {}
    if addresses:
        parsed = await _rpc(
            SOLANA_RPC, "getMultipleAccounts", [addresses, {"encoding": "jsonParsed"}]
        )
        if isinstance(parsed, dict):
            accounts = parsed.get("value")
            if isinstance(accounts, list):
                for address, account in zip(addresses, accounts, strict=False):
                    if not isinstance(account, dict):
                        continue
                    info = (((account.get("data") or {}).get("parsed") or {}).get("info")) or {}
                    owner = info.get("owner")
                    if isinstance(owner, str):
                        owners[address] = owner

    folded: dict[str, float] = {}
    for row in values:
        if not isinstance(row, dict):
            continue
        address = row.get("address")
        amount = (row.get("uiAmount") if "uiAmount" in row else None) or row.get("uiAmountString")
        try:
            balance = float(amount) if amount is not None else 0.0
        except (TypeError, ValueError):
            balance = 0.0
        if balance <= 0 or not isinstance(address, str):
            continue
        owner = owners.get(address, address)
        folded[owner] = folded.get(owner, 0.0) + balance

    holders = [RawHolder(address=owner, balance=balance) for owner, balance in folded.items()]
    return holders, supply, None if holders else "no_holder_rows"


def _blockscout_rows(items: list[Any], decimals_fallback: int) -> list[RawHolder]:
    holders: list[RawHolder] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        address_block = item.get("address") or {}
        address = address_block.get("hash")
        if not isinstance(address, str):
            continue
        try:
            raw_value = float(item.get("value") or 0)
        except (TypeError, ValueError):
            continue
        token = item.get("token") or {}
        try:
            decimals = int(token.get("decimals") or decimals_fallback)
        except (TypeError, ValueError):
            decimals = decimals_fallback
        balance = raw_value / (10**decimals) if decimals else raw_value
        if balance <= 0:
            continue

        metadata = address_block.get("metadata") or {}
        tags = tuple(
            str(tag.get("name"))
            for tag in (metadata.get("tags") or [])
            if isinstance(tag, dict) and tag.get("name")
        )
        name = address_block.get("name")
        if name and not tags:
            tags = (str(name),)
        holders.append(
            RawHolder(
                address=address,
                balance=balance,
                is_contract=bool(address_block.get("is_contract")),
                tags=tags,
            )
        )
    return holders


async def _blockscout_holders(
    chain: str, contract: str, decimals: int
) -> tuple[list[RawHolder], float | None, str | None]:
    host = BLOCKSCOUT_HOSTS.get(chain)
    if host is None:
        return [], None, "chain_not_covered"
    payload = await _get_json(f"{host}/api/v2/tokens/{contract}/holders")
    if not isinstance(payload, dict):
        return [], None, "blockscout_unavailable"
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        return [], None, "no_holder_rows"
    return _blockscout_rows(items, decimals), None, None


async def _etherscan_holders(
    chain: str, contract: str, decimals: int
) -> tuple[list[RawHolder], float | None, str | None]:
    key = settings.ETHERSCAN_API_KEY
    if not key:
        return [], None, "no_indexer_key_for_chain"
    chain_id = ETHERSCAN_CHAIN_IDS.get(chain)
    if chain_id is None:
        return [], None, "chain_not_covered"

    payload = await _get_json(
        ETHERSCAN_V2,
        {
            "chainid": chain_id,
            "module": "token",
            "action": "tokenholderlist",
            "contractaddress": contract,
            "page": 1,
            "offset": TOP_HOLDER_LIMIT,
            "apikey": key,
        },
    )
    if not isinstance(payload, dict):
        return [], None, "etherscan_unavailable"
    if str(payload.get("status")) != "1":
        message = str(payload.get("result") or payload.get("message") or "")[:120]
        logger.info("listings: etherscan holders unavailable for %s: %s", chain, message)
        return [], None, "indexer_plan_lacks_chain"

    rows = payload.get("result")
    if not isinstance(rows, list) or not rows:
        return [], None, "no_holder_rows"

    holders: list[RawHolder] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        address = row.get("TokenHolderAddress")
        try:
            quantity = float(row.get("TokenHolderQuantity") or 0)
        except (TypeError, ValueError):
            continue
        if not isinstance(address, str) or quantity <= 0:
            continue
        holders.append(RawHolder(address=address, balance=quantity / (10**decimals)))
    return holders, None, None if holders else "no_holder_rows"


async def fetch_holder_map(
    symbol: str,
    *,
    chain: str | None,
    contract_address: str | None,
    total_supply: float | None = None,
    decimals: int = 18,
) -> HolderMap:
    """Top-holder distribution for one token, or a map that says why not."""
    if not contract_address or not chain:
        return build_holder_map(symbol, [], unavailable_reason="no_contract_address")

    try:
        if chain == "Solana":
            holders, supply, reason = await _solana_holders(contract_address)
            total_supply = supply or total_supply
        elif chain in BLOCKSCOUT_HOSTS:
            holders, _, reason = await _blockscout_holders(chain, contract_address, decimals)
            if reason in {"blockscout_unavailable", "no_holder_rows"}:
                # Blockscout's hosted instances are best-effort; fall through
                # to a configured indexer rather than reporting "no data".
                fallback, _, fallback_reason = await _etherscan_holders(
                    chain, contract_address, decimals
                )
                if fallback:
                    holders, reason = fallback, None
                else:
                    reason = reason or fallback_reason
        else:
            holders, _, reason = await _etherscan_holders(chain, contract_address, decimals)
    except Exception as exc:
        logger.warning("listings: holder fetch failed for %s: %s", symbol, exc)
        return build_holder_map(symbol, [], unavailable_reason="provider_error")

    if not holders:
        return build_holder_map(symbol, [], unavailable_reason=reason or "no_holder_rows")

    return build_holder_map(
        symbol,
        holders,
        total_supply=total_supply,
        max_bubbles=TOP_HOLDER_LIMIT,
    )


async def fetch_holder_maps(
    targets: list[tuple[str, str | None, str | None, float | None]],
    *,
    concurrency: int = 4,
) -> dict[str, HolderMap]:
    """Bounded-concurrency fan-out. Public RPCs rate-limit hard, so this stays
    deliberately small — the pass has a whole universe to get through."""
    semaphore = asyncio.Semaphore(concurrency)

    async def one(symbol: str, chain: str | None, contract: str | None, supply: float | None):
        async with semaphore:
            return symbol, await fetch_holder_map(
                symbol, chain=chain, contract_address=contract, total_supply=supply
            )

    results = await asyncio.gather(
        *(one(*target) for target in targets), return_exceptions=True
    )
    out: dict[str, HolderMap] = {}
    for result in results:
        if isinstance(result, BaseException):
            continue
        symbol, holder_map = result
        out[symbol] = holder_map
    return out
