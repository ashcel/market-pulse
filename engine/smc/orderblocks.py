"""True order blocks (port of orderblocks.ts) — the last opposing-close candle
before a displacement.

The final down candle before conviction buying (demand) or the final up candle
before conviction selling (supply). A sibling detector to zones' base zones,
not a replacement. Display-plane only (EDR 0013). Displacement thresholds
reuse zones' calibration deliberately — one set of conviction constants.
"""

from dataclasses import dataclass
from typing import Literal

from smc.mock_candles import TokenTimeframe
from smc.types import Candle
from smc.zones import SD_ZONE_TIMEFRAMES, atr_series

OrderBlockKind = Literal["demand", "supply"]

OB_TIMEFRAMES: tuple[TokenTimeframe, ...] = SD_ZONE_TIMEFRAMES

# Same conviction gate as zones departures: body >= 1.15x ATR14, body >= 55% of range.
_DISPLACEMENT_BODY_ATR = 1.15
_DISPLACEMENT_BODY_SHARE = 0.55
# Indecision candles the walkback may skip between displacement and OB candle.
OB_WALKBACK_MAX_SKIPS = 2
# A skippable candle's body cap — zones' indecision threshold.
_WALKBACK_BODY_ATR = 0.45
# Bars scanned behind the OB candle for the swept-extreme read.
OB_SWEEP_LOOKBACK = 20

_MAX_BLOCKS_PER_KIND = 2


@dataclass(slots=True)
class OrderBlock:
    # Bullish displacement -> the opposing candle is a demand OB; mirror for supply.
    kind: OrderBlockKind
    # Full range of the OB candle (body-only banding is an open EDR question).
    price_low: float
    price_high: float
    # The opposing candle itself.
    time: int
    # The displacement candle that validates it.
    displacement_time: int
    # Displacement body / ATR14 — a quality read for ranking and display.
    displacement_atr: float
    # The OB candle's wick took out the prior lookback extreme (sweep-origin OB).
    swept_swing: bool


def detect_order_blocks(candles: list[Candle]) -> list[OrderBlock]:
    """Every qualifying order block in the window, chronological by displacement time."""
    if len(candles) < 30:
        return []
    atr = atr_series(candles)
    out: list[OrderBlock] = []

    for i in range(15, len(candles)):
        ref = atr[i - 1]
        if ref is None or ref <= 0:
            continue

        displacement = candles[i]
        body = abs(displacement.close - displacement.open)
        range_ = displacement.high - displacement.low
        if (
            body < ref * _DISPLACEMENT_BODY_ATR
            or range_ <= 0
            or body < range_ * _DISPLACEMENT_BODY_SHARE
        ):
            continue

        bullish = displacement.close > displacement.open

        # Walk back to the last opposing-close candle, skipping only indecision
        # bars; a same-direction conviction candle means the leg was already
        # running — no order block, the displacement is continuation.
        ob_index = -1
        skips = 0
        j = i - 1
        while j > 0 and skips <= OB_WALKBACK_MAX_SKIPS:
            c = candles[j]
            opposing = c.close < c.open if bullish else c.close > c.open
            if opposing:
                ob_index = j
                break
            if abs(c.close - c.open) > ref * _WALKBACK_BODY_ATR:
                break
            skips += 1
            j -= 1
        if ob_index < 0:
            continue

        ob = candles[ob_index]
        window_start = max(0, ob_index - OB_SWEEP_LOOKBACK)
        prior = candles[window_start:ob_index]
        swept_swing = bool(prior) and (
            ob.low < min(c.low for c in prior) if bullish else ob.high > max(c.high for c in prior)
        )

        out.append(
            OrderBlock(
                kind="demand" if bullish else "supply",
                price_low=ob.low,
                price_high=ob.high,
                time=ob.time,
                displacement_time=displacement.time,
                displacement_atr=body / ref,
                swept_swing=swept_swing,
            )
        )

    return out


def select_order_blocks(blocks: list[OrderBlock]) -> list[OrderBlock]:
    """Ranked display candidates (preferred = [0]): most recent displacement
    first, stronger displacement breaking ties; overlapping same-kind
    duplicates dropped, capped per kind — the same curation stance as
    select_zones/select_fvgs."""
    ranked = sorted(blocks, key=lambda b: (-b.displacement_time, -b.displacement_atr))
    picked: list[OrderBlock] = []
    for block in ranked:
        if sum(1 for p in picked if p.kind == block.kind) >= _MAX_BLOCKS_PER_KIND:
            continue
        overlaps = any(
            p.kind == block.kind
            and block.price_low <= p.price_high
            and block.price_high >= p.price_low
            for p in picked
        )
        if not overlaps:
            picked.append(block)
    return picked
