"""Holder concentration + bubble-map layout.

Turns a raw top-holder list into the two things the token page needs: the
concentration numbers the screener scores on, and a deterministic bubble
layout the client can draw without doing any physics of its own.

The one judgement call in here is **what counts as a holder**. A liquidity
pool, a burn address, a bridge or a staking contract routinely sits in the
top 5 by balance, and counting those as whales makes every honest token look
like a rug. They are classified out, and the classification is reported per
bubble so the map can still show them — greyed, labelled — instead of
silently dropping supply and leaving percentages that do not add up.

Layout is a deterministic spiral pack, not a force simulation: same input,
same picture, every render and every client. Coordinates come out in a
[-1, 1] box so the UI scales them to whatever viewport it has.

Pure. No I/O, no version bump — a research/discovery read like
`listing_score.py`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

HOLDER_MAP_VERSION = "1.0.0"

HolderKind = Literal["wallet", "pool", "burn", "contract", "exchange", "team"]

# Addresses that are supply sinks, not owners. Lowercased, chain-agnostic.
BURN_ADDRESSES = frozenset(
    {
        "0x0000000000000000000000000000000000000000",
        "0x000000000000000000000000000000000000dead",
        "0x00000000000000000000000000000000000000dead",
        "11111111111111111111111111111111",
        "1nc1nerator11111111111111111111111111111111",
    }
)

# Substrings in an indexer's address tags that identify a non-wallet holder.
_POOL_TAGS = ("lp", "pool", "pair", "amm", "uniswap", "pancake", "curve", "raydium", "meteora")
_EXCHANGE_TAGS = ("binance", "okx", "bybit", "kucoin", "gate.io", "coinbase", "kraken", "exchange")
_TEAM_TAGS = ("team", "treasury", "foundation", "vesting", "reserve", "ecosystem")
_BRIDGE_TAGS = ("bridge", "wormhole", "layerzero", "stargate")


@dataclass(slots=True)
class RawHolder:
    """One row as an indexer returns it."""

    address: str
    balance: float
    is_contract: bool = False
    # Free-text labels from the indexer, e.g. ["PancakeSwap V3: KII-WBNB"].
    tags: tuple[str, ...] = ()


@dataclass(slots=True)
class Bubble:
    address: str
    label: str
    kind: HolderKind
    balance: float
    # Share of total supply, 0..1.
    pct: float
    # Layout, in a [-1, 1] box. `r` is in the same units.
    x: float
    y: float
    r: float
    # Whether this bubble counts toward concentration.
    counted: bool


@dataclass(slots=True)
class HolderMap:
    symbol: str
    total_supply: float
    # Concentration over *counted* holders only (pools/burns excluded).
    top10_pct: float | None
    top50_pct: float | None
    largest_holder_pct: float | None
    # Herfindahl index over counted holders — 0 is perfectly dispersed, 1 is
    # one wallet owning everything. Comparable across tokens, unlike top-N.
    hhi: float | None
    holders_counted: int
    pool_pct: float
    burn_pct: float
    bubbles: list[Bubble] = field(default_factory=list)
    version: str = HOLDER_MAP_VERSION
    # Set when no indexer covers the chain; bubbles will be empty.
    unavailable_reason: str | None = None


def _is_zero_address(address: str) -> bool:
    """An all-zero EVM address, however many digits it is written with.

    `lstrip("0x")` is not usable here: it strips a *character set*, so "0x0"
    reduces to the empty string and an empty set is a subset of anything —
    which would classify short addresses as burns.
    """
    body = address[2:] if address.startswith("0x") else address
    return len(body) >= 8 and set(body) == {"0"}


def classify(holder: RawHolder) -> HolderKind:
    address = holder.address.strip().lower()
    if address in BURN_ADDRESSES or _is_zero_address(address):
        return "burn"

    joined = " ".join(holder.tags).lower()
    if any(tag in joined for tag in _POOL_TAGS):
        return "pool"
    if any(tag in joined for tag in _EXCHANGE_TAGS):
        return "exchange"
    if any(tag in joined for tag in _TEAM_TAGS):
        return "team"
    if any(tag in joined for tag in _BRIDGE_TAGS):
        return "pool"
    if holder.is_contract:
        return "contract"
    return "wallet"


def _label(holder: RawHolder) -> str:
    if holder.tags:
        return holder.tags[0]
    address = holder.address
    if len(address) > 12:
        return f"{address[:6]}…{address[-4:]}"
    return address


# Kinds excluded from concentration math. A contract that is not a recognised
# pool still counts: an unlabelled contract holding 30% is exactly the risk
# this map exists to show.
_UNCOUNTED: frozenset[HolderKind] = frozenset({"pool", "burn"})


def _spiral_layout(sizes: list[float]) -> list[tuple[float, float, float]]:
    """Deterministic pack: biggest bubble at the centre, the rest spiralling
    out with a radius that keeps neighbours from overlapping.

    A phyllotaxis spiral (golden angle) gives an even fill for any count
    without iterating, which is what makes this reproducible and cheap.
    """
    if not sizes:
        return []

    total = sum(sizes) or 1.0
    # Radius proportional to sqrt(share) so bubble *area* encodes the share.
    radii = [math.sqrt(size / total) for size in sizes]
    scale = 0.42 / (max(radii) or 1.0)
    radii = [r * scale for r in radii]

    golden = math.pi * (3.0 - math.sqrt(5.0))
    placed: list[tuple[float, float, float]] = []
    for index, radius in enumerate(radii):
        if index == 0:
            placed.append((0.0, 0.0, radius))
            continue
        angle = index * golden
        # Distance grows with sqrt(index) to keep density even, plus the
        # running radius so bigger bubbles push the ring outward.
        distance = 0.28 * math.sqrt(index) + radius * 0.6
        placed.append((math.cos(angle) * distance, math.sin(angle) * distance, radius))

    # Normalize into [-1, 1] including each bubble's own radius.
    extent = max((abs(x) + r, abs(y) + r) for x, y, r in placed)
    span = max(max(extent), 1e-6)
    return [(x / span, y / span, r / span) for x, y, r in placed]


def build_holder_map(
    symbol: str,
    holders: list[RawHolder],
    *,
    total_supply: float | None = None,
    max_bubbles: int = 60,
    unavailable_reason: str | None = None,
) -> HolderMap:
    """Fold an indexer's top-holder list into concentration + layout.

    `total_supply` should be the token's real supply. When it is missing the
    percentages are taken over the sum of the rows supplied, which is only
    correct if the list covers the whole float — so that fallback is recorded
    by leaving concentration relative and is why the caller should pass it.
    """
    if unavailable_reason is not None or not holders:
        return HolderMap(
            symbol=symbol,
            total_supply=total_supply or 0.0,
            top10_pct=None,
            top50_pct=None,
            largest_holder_pct=None,
            hhi=None,
            holders_counted=0,
            pool_pct=0.0,
            burn_pct=0.0,
            unavailable_reason=unavailable_reason or "no_holder_rows",
        )

    ranked = sorted((h for h in holders if h.balance > 0), key=lambda h: -h.balance)
    supply = total_supply if total_supply and total_supply > 0 else sum(h.balance for h in ranked)
    if supply <= 0:
        return HolderMap(
            symbol=symbol,
            total_supply=0.0,
            top10_pct=None,
            top50_pct=None,
            largest_holder_pct=None,
            hhi=None,
            holders_counted=0,
            pool_pct=0.0,
            burn_pct=0.0,
            unavailable_reason="zero_supply",
        )

    kinds = [classify(h) for h in ranked]
    pool_pct = sum(h.balance for h, k in zip(ranked, kinds, strict=True) if k == "pool") / supply
    burn_pct = sum(h.balance for h, k in zip(ranked, kinds, strict=True) if k == "burn") / supply

    counted = [
        (h, k) for h, k in zip(ranked, kinds, strict=True) if k not in _UNCOUNTED
    ]
    # Concentration is expressed against *circulating-ish* supply: what a burn
    # address holds is gone, and what a pool holds is the market itself.
    effective_supply = supply * (1.0 - pool_pct - burn_pct)
    if effective_supply <= 0:
        effective_supply = supply

    counted_shares = [h.balance / effective_supply for h, _ in counted]
    top10 = sum(counted_shares[:10]) if counted_shares else None
    top50 = sum(counted_shares[:50]) if counted_shares else None
    largest = counted_shares[0] if counted_shares else None
    hhi = sum(share * share for share in counted_shares) if counted_shares else None

    shown = ranked[:max_bubbles]
    shown_kinds = kinds[:max_bubbles]
    layout = _spiral_layout([h.balance for h in shown])

    bubbles = [
        Bubble(
            address=holder.address,
            label=_label(holder),
            kind=kind,
            balance=holder.balance,
            pct=holder.balance / supply,
            x=round(x, 4),
            y=round(y, 4),
            r=round(r, 4),
            counted=kind not in _UNCOUNTED,
        )
        for holder, kind, (x, y, r) in zip(shown, shown_kinds, layout, strict=True)
    ]

    return HolderMap(
        symbol=symbol,
        total_supply=supply,
        top10_pct=min(1.0, top10) if top10 is not None else None,
        top50_pct=min(1.0, top50) if top50 is not None else None,
        largest_holder_pct=min(1.0, largest) if largest is not None else None,
        hhi=round(hhi, 5) if hhi is not None else None,
        holders_counted=len(counted),
        pool_pct=round(pool_pct, 5),
        burn_pct=round(burn_pct, 5),
        bubbles=bubbles,
    )
