"""Every derived derivatives metric, computed server-side.

The rule this module exists to enforce: **never expose a raw metric alone**.
The API answers "what does this imply" — open interest arrives as an
expansion class, funding as a trend and a percentile, the long/short book as a
crowding band, and the whole read as a regime plus an Indonesian paragraph.
The frontend recomputes none of it.

Everything here is a pure function over a chronologically ascending list of
`SnapshotPoint`. No I/O, no clock reads except the one `now` a caller passes
in, so every classification is reproducible from the stored rows alone.

Two honesty rules run through the file:
  1. A missing feed yields `None`, never `0.0`. A composite renormalises over
     the components it actually has rather than scoring the gap as neutral.
  2. Squeeze output is **relative pressure, not prediction** — it says which
     side is more exposed right now, and its two numbers are capped to sum to
     100. It never claims a squeeze will happen.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, cast

from .constants import (
    AGGRESSION_STRONG,
    AGGRESSION_WEAK,
    CROWDING_BEARISH_MAX,
    CROWDING_BULLISH_MIN,
    CROWDING_LABELS,
    CROWDING_WEIGHTS,
    DELTA_WINDOWS_S,
    EXPANSION_EPS_PCT,
    EXPANSION_LABELS,
    EXPANSION_MOMENTUM,
    FUNDING_BOUND,
    HISTORY_WINDOWS_S,
    LOG_RATIO_BOUND,
    MOMENTUM_WEIGHTS,
    PREMIUM_BOUND,
    REGIME_LABELS,
    REGIME_MOMENTUM_STRONG_BEAR,
    REGIME_MOMENTUM_STRONG_BULL,
    REGIME_MOMENTUM_WEAK_BEAR,
    REGIME_MOMENTUM_WEAK_BULL,
    REGIME_OI_RISING_PCT,
    REGIME_TREND_PRICE_EPS_PCT,
    delta_tolerance_s,
)
from .schemas import (
    CrowdingBand,
    DerivativesIntelligence,
    DerivativesRaw,
    DerivativesSummary,
    Derived,
    FundingTrend,
    HistoryMetric,
    HistoryWindow,
    Intelligence,
    MarketRegime,
    OiExpansion,
    RegimeCount,
    Scores,
    SparkPoint,
    SqueezeScores,
    SummaryMomentumEntry,
    SummaryOiEntry,
    SummarySqueezeEntry,
)


@dataclass(frozen=True, slots=True)
class SnapshotPoint:
    """One stored row, floats only. The repo hydrates Decimals into this."""

    timestamp: datetime
    price: float | None = None
    open_interest: float | None = None
    open_interest_usd: float | None = None
    funding_rate: float | None = None
    long_short_ratio: float | None = None
    top_trader_accounts_ratio: float | None = None
    top_trader_positions_ratio: float | None = None
    taker_buy_volume: float | None = None
    taker_sell_volume: float | None = None
    basis: float | None = None
    premium: float | None = None
    oi_marketcap_ratio: float | None = None


Getter = Callable[[SnapshotPoint], float | None]


# --- small numeric helpers ----------------------------------------------


def _finite(value: float | None) -> float | None:
    """None-in/None-out, and NaN/inf are treated as missing rather than
    propagated into a score."""
    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _scale_0_100(value: float, bound: float) -> float:
    """Map a symmetric signed reading onto 0-100 with 0 landing on 50."""
    if bound <= 0:
        return 50.0
    return _clamp((value / bound + 1.0) / 2.0 * 100.0, 0.0, 100.0)


def _ratio_0_100(ratio: float | None) -> float | None:
    """Long/short ratios are multiplicative: 2.0 and 0.5 are equally lopsided,
    so the log is what gets scaled — a linear map would call 0.5 'nearly
    balanced' and 2.0 'extreme'."""
    ratio = _finite(ratio)
    if ratio is None or ratio <= 0:
        return None
    return _scale_0_100(math.log(ratio), LOG_RATIO_BOUND)


def _epoch(moment: datetime) -> float:
    return (moment if moment.tzinfo else moment.replace(tzinfo=UTC)).timestamp()


def _weighted(parts: dict[str, float | None], weights: dict[str, float]) -> float | None:
    """Weighted mean over the components that have data, renormalised.

    Absent components are dropped rather than scored 50: a feed that failed
    must not masquerade as a neutral reading.
    """
    total_weight = 0.0
    total = 0.0
    for key, value in parts.items():
        if value is None:
            continue
        weight = weights.get(key, 0.0)
        if weight <= 0:
            continue
        total += value * weight
        total_weight += weight
    if total_weight <= 0:
        return None
    return total / total_weight


# --- series access -------------------------------------------------------


def pick_at(
    series: Sequence[SnapshotPoint],
    target_ts: float,
    tolerance_s: float,
    getter: Getter,
) -> SnapshotPoint | None:
    """Closest point to `target_ts` that actually carries the metric.

    Nearest-within-tolerance rather than last-before: a worker that missed the
    exact slot by 40 s should still answer a 1h delta, but a table that only
    reaches back three hours must NOT answer a 24h one.
    """
    best: SnapshotPoint | None = None
    best_gap = math.inf
    for point in series:
        if _finite(getter(point)) is None:
            continue
        gap = abs(_epoch(point.timestamp) - target_ts)
        if gap < best_gap:
            best, best_gap = point, gap
    if best is None or best_gap > tolerance_s:
        return None
    return best


def _latest_with(series: Sequence[SnapshotPoint], getter: Getter) -> SnapshotPoint | None:
    for point in reversed(series):
        if _finite(getter(point)) is not None:
            return point
    return None


def pct_delta(series: Sequence[SnapshotPoint], getter: Getter, window_s: int) -> float | None:
    """Percent change of `getter` across `window_s`, anchored on the newest
    sample that has the metric (not on wall-clock now — a stale table must
    report a stale delta, not a fabricated fresh one)."""
    newest = _latest_with(series, getter)
    if newest is None:
        return None
    current = _finite(getter(newest))
    if current is None:  # pragma: no cover — `_latest_with` only returns finite points
        return None

    target = _epoch(newest.timestamp) - window_s
    past = pick_at(series, target, delta_tolerance_s(window_s), getter)
    if past is None or past is newest:
        return None
    before = _finite(getter(past))
    if before is None or before == 0:
        return None
    return (current - before) / abs(before) * 100.0


def _delta_map(series: Sequence[SnapshotPoint], getter: Getter) -> dict[str, float | None]:
    return {label: pct_delta(series, getter, w) for label, w in DELTA_WINDOWS_S.items()}


def _reference_delta(deltas: dict[str, float | None]) -> float | None:
    """The window an expansion/regime rule reads. 1h is the intended scale;
    the shorter windows are fallbacks for a table that only just started."""
    for label in ("1h", "15m", "5m"):
        value = deltas.get(label)
        if value is not None:
            return value
    return None


# --- individual metrics --------------------------------------------------


def buyer_aggression(point: SnapshotPoint) -> float | None:
    """taker_buy / (taker_buy + taker_sell), 0-1. Who crossed the spread."""
    buy = _finite(point.taker_buy_volume)
    sell = _finite(point.taker_sell_volume)
    if buy is None or sell is None:
        return None
    total = buy + sell
    if total <= 0:
        return None
    return _clamp(buy / total, 0.0, 1.0)


def funding_trend(series: Sequence[SnapshotPoint]) -> FundingTrend:
    """Current rate, its absolute move over 15m and 1h, and where it sits in
    the last 24h of its own distribution.

    The deltas are absolute (rate minus rate), not percent: funding crosses
    zero routinely, and a percent change through zero is noise.
    """

    def getter(point: SnapshotPoint) -> float | None:
        return point.funding_rate

    newest = _latest_with(series, getter)
    if newest is None:
        return FundingTrend(current=None, delta_15m=None, delta_1h=None, percentile_24h=None)
    current = _finite(newest.funding_rate)
    if current is None:  # pragma: no cover — `_latest_with` only returns finite points
        return FundingTrend(current=None, delta_15m=None, delta_1h=None, percentile_24h=None)

    anchor = _epoch(newest.timestamp)

    def absolute_delta(window_s: int) -> float | None:
        past = pick_at(series, anchor - window_s, delta_tolerance_s(window_s), getter)
        if past is None or past is newest:
            return None
        before = _finite(past.funding_rate)
        return None if before is None else current - before

    cutoff = anchor - DELTA_WINDOWS_S["24h"]
    window_values = [
        value
        for point in series
        if _epoch(point.timestamp) >= cutoff and (value := _finite(point.funding_rate)) is not None
    ]
    percentile: float | None = None
    if len(window_values) >= 2:
        at_or_below = sum(1 for value in window_values if value <= current)
        percentile = at_or_below / len(window_values) * 100.0

    return FundingTrend(
        current=current,
        delta_15m=absolute_delta(DELTA_WINDOWS_S["15m"]),
        delta_1h=absolute_delta(DELTA_WINDOWS_S["1h"]),
        percentile_24h=percentile,
    )


def classify_oi_expansion(price_delta_pct: float | None, oi_delta_pct: float | None) -> OiExpansion:
    """Price x OI is the one question open interest can actually answer:
    is new money arriving, or are existing positions closing?

      price ↑ OI ↑ — new longs opening ....... bullish expansion
      price ↑ OI ↓ — shorts buying back ...... short covering
      price ↓ OI ↑ — new shorts opening ...... bearish expansion
      price ↓ OI ↓ — longs closing out ....... long capitulation

    Below `EXPANSION_EPS_PCT` on both axes the tape is flat and gets its own
    class rather than being forced into one of the four.
    """
    if price_delta_pct is None or oi_delta_pct is None:
        return "neutral"
    if abs(price_delta_pct) < EXPANSION_EPS_PCT or abs(oi_delta_pct) < EXPANSION_EPS_PCT:
        return "neutral"
    if price_delta_pct > 0:
        return "bullish_expansion" if oi_delta_pct > 0 else "short_covering"
    return "bearish_expansion" if oi_delta_pct > 0 else "long_capitulation"


def crowding_score(point: SnapshotPoint) -> float | None:
    """0-100. How one-sided the book is — 0 = shorts crowded, 100 = longs
    crowded, 50 = balanced. Funding, the global long/short account ratio and
    the top-trader ratios, each normalised onto the same scale first."""
    top_parts = [
        _ratio_0_100(point.top_trader_accounts_ratio),
        _ratio_0_100(point.top_trader_positions_ratio),
    ]
    available = [value for value in top_parts if value is not None]
    top_trader = sum(available) / len(available) if available else None

    funding = _finite(point.funding_rate)
    return _weighted(
        {
            "funding": None if funding is None else _scale_0_100(funding, FUNDING_BOUND),
            "long_short_ratio": _ratio_0_100(point.long_short_ratio),
            "top_trader": top_trader,
        },
        CROWDING_WEIGHTS,
    )


def crowding_band(score: float | None) -> CrowdingBand:
    if score is None:
        return "unknown"
    if score < CROWDING_BEARISH_MAX:
        return "bearish_crowded"
    if score > CROWDING_BULLISH_MIN:
        return "bullish_crowded"
    return "balanced"


def momentum_score(
    expansion: OiExpansion,
    aggression: float | None,
    funding: float | None,
    premium: float | None,
    *,
    has_expansion_evidence: bool,
) -> float | None:
    """0-100: OI expansion 40% · buyer aggression 35% · funding 15% · basis 10%.

    `has_expansion_evidence` is False when the expansion class is only
    "neutral" because a delta was missing — scoring that as a real 50 would
    hand a confident-looking number to a symbol we know nothing about.
    """
    funding = _finite(funding)
    premium = _finite(premium)
    return _weighted(
        {
            "oi_expansion": EXPANSION_MOMENTUM[expansion] if has_expansion_evidence else None,
            "buyer_aggression": None if aggression is None else aggression * 100.0,
            "funding": None if funding is None else _scale_0_100(funding, FUNDING_BOUND),
            "basis": None if premium is None else _scale_0_100(premium, PREMIUM_BOUND),
        },
        MOMENTUM_WEIGHTS,
    )


def squeeze_scores(
    crowding: float | None,
    oi_delta_pct: float | None,
    price_acceleration_pct: float | None,
) -> SqueezeScores:
    """RELATIVE squeeze pressure — deliberately NOT a prediction.

    A squeeze needs three things: a crowded side, fuel, and a move against it.
    So crowding splits the exposure between the two sides, rising OI says the
    crowd is still adding, and price accelerating *against* a side is what
    would actually force it out.

    Both sides carry their own number because the same tape can be mildly
    dangerous for shorts while being very dangerous for longs — collapsing
    that to one signed figure would throw the second half away.

    `long + short <= 100` holds by construction (the two crowd shares sum to
    100 and every modifier is <= 1), which is why nothing is renormalised
    afterwards. The pair is a comparison, never "a 73% chance of a squeeze".
    """
    if crowding is None:
        return SqueezeScores(long=0.0, short=0.0)

    crowded_long = _clamp(crowding, 0.0, 100.0)
    crowded_short = 100.0 - crowded_long

    oi_fuel = 0.0 if oi_delta_pct is None else _clamp(oi_delta_pct, 0.0, 5.0) / 5.0
    accel = 0.0 if price_acceleration_pct is None else price_acceleration_pct
    against_longs = _clamp(-accel, 0.0, 2.0) / 2.0
    against_shorts = _clamp(accel, 0.0, 2.0) / 2.0

    long_raw = crowded_long * (0.4 + 0.3 * oi_fuel + 0.3 * against_longs)
    short_raw = crowded_short * (0.4 + 0.3 * oi_fuel + 0.3 * against_shorts)
    return SqueezeScores(long=round(long_raw, 1), short=round(short_raw, 1))


def classify_regime(
    *,
    expansion: OiExpansion,
    price_delta_pct: float | None,
    oi_delta_pct: float | None,
    crowding: float | None,
    momentum: float | None,
) -> MarketRegime:
    """Nine regimes, resolved in a fixed order — squeezes first (they are
    specific pricexOI signatures), then the two flat-price accumulation /
    distribution cases, then trend strength by momentum. First match wins, so
    the ordering IS the rule; anything unmatched is honestly `neutral`."""
    price = price_delta_pct
    oi = oi_delta_pct

    # 1-2. Squeezes: a crowd being forced out, visible as OI falling while
    # price runs the other way.
    if (
        expansion == "short_covering"
        and price is not None
        and price > REGIME_TREND_PRICE_EPS_PCT
        and (crowding is None or crowding < 50.0)
    ):
        return "short_squeeze"
    if (
        expansion == "long_capitulation"
        and price is not None
        and price < -REGIME_TREND_PRICE_EPS_PCT
        and (crowding is None or crowding > 50.0)
    ):
        return "long_squeeze"

    # 3-4. Flat price while OI builds: someone is loading up. Which side is
    # loading is what separates distribution from accumulation.
    flat_price = price is not None and abs(price) <= REGIME_TREND_PRICE_EPS_PCT
    oi_rising = oi is not None and oi > REGIME_OI_RISING_PCT
    if flat_price and oi_rising and crowding is not None:
        if crowding > CROWDING_BULLISH_MIN:
            return "distribution"
        if crowding < CROWDING_BEARISH_MAX:
            return "accumulation"

    # 5-8. Trend strength, graded by momentum and signed by price.
    if momentum is not None and price is not None:
        if price > 0:
            if momentum >= REGIME_MOMENTUM_STRONG_BULL:
                return "strong_bull_trend"
            if momentum >= REGIME_MOMENTUM_WEAK_BULL:
                return "weak_bull_trend"
        if price < 0:
            if momentum <= REGIME_MOMENTUM_STRONG_BEAR:
                return "strong_bear_trend"
            if momentum <= REGIME_MOMENTUM_WEAK_BEAR:
                return "weak_bear_trend"

    # 9. No rule fired. Saying so beats inventing a trend.
    return "neutral"


# --- Indonesian narration ------------------------------------------------


def _pct(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "-"
    return f"{value:+.{digits}f}%"


def _funding_label(current: float | None, percentile: float | None) -> str:
    if current is None:
        return "Belum ada data"
    if current > FUNDING_BOUND:
        base = "Sangat positif — long bayar short"
    elif current > FUNDING_BOUND / 5:
        base = "Positif"
    elif current < -FUNDING_BOUND:
        base = "Sangat negatif — short bayar long"
    elif current < -FUNDING_BOUND / 5:
        base = "Negatif"
    else:
        base = "Netral"
    if percentile is None:
        return base
    if percentile >= 90:
        return f"{base} · tertinggi 24 jam"
    if percentile <= 10:
        return f"{base} · terendah 24 jam"
    return base


def _oi_label(oi_delta_pct: float | None) -> str:
    if oi_delta_pct is None:
        return "Belum ada data"
    if oi_delta_pct > REGIME_OI_RISING_PCT:
        return f"Menebal {_pct(oi_delta_pct)}"
    if oi_delta_pct < -REGIME_OI_RISING_PCT:
        return f"Menipis {_pct(oi_delta_pct)}"
    return f"Datar {_pct(oi_delta_pct)}"


def _aggression_label(aggression: float | None) -> str:
    if aggression is None:
        return "Belum ada data"
    percent = aggression * 100.0
    if aggression >= AGGRESSION_STRONG:
        return f"{percent:.0f}% · Buyer kuat"
    if aggression <= AGGRESSION_WEAK:
        return f"{percent:.0f}% · Seller kuat"
    return f"{percent:.0f}% · Seimbang"


def _squeeze_label(squeeze: SqueezeScores) -> str:
    if squeeze.long <= 0 and squeeze.short <= 0:
        return "Tidak ada sisi yang padat"
    if squeeze.long > squeeze.short:
        return f"Long lebih rentan ({squeeze.long:.0f} vs {squeeze.short:.0f})"
    if squeeze.short > squeeze.long:
        return f"Short lebih rentan ({squeeze.short:.0f} vs {squeeze.long:.0f})"
    return "Kedua sisi sama rentan"


_EXPANSION_SENTENCE: dict[OiExpansion, str] = {
    "bullish_expansion": "Uang baru masuk ke sisi long.",
    "short_covering": "Short menutup posisi, bukan uang baru.",
    "bearish_expansion": "Uang baru masuk ke sisi short.",
    "long_capitulation": "Long menutup posisi, bukan short baru.",
    "neutral": "Belum ada arah yang jelas dari open interest.",
}

_REGIME_SENTENCE: dict[MarketRegime, str] = {
    "strong_bull_trend": "Probabilitas kelanjutan tren naik tinggi.",
    "weak_bull_trend": "Tren naik ada tapi tipis — jangan kejar harga.",
    "strong_bear_trend": "Probabilitas kelanjutan tren turun tinggi.",
    "weak_bear_trend": "Tren turun ada tapi tipis — jangan kejar harga.",
    "short_squeeze": "Kenaikan ini didorong short yang tertekan keluar, bukan permintaan baru.",
    "long_squeeze": "Penurunan ini didorong long yang tertekan keluar, bukan pasokan baru.",
    "distribution": "Posisi menumpuk di sisi long sementara harga diam — waspada distribusi.",
    "accumulation": "Posisi menumpuk di sisi short sementara harga diam — waspada akumulasi.",
    "neutral": "Belum ada kondisi yang cukup jelas untuk disimpulkan.",
}


def build_intelligence(
    *,
    regime: MarketRegime,
    expansion: OiExpansion,
    oi_delta_pct: float | None,
    price_delta_pct: float | None,
    aggression: float | None,
    funding: FundingTrend,
    crowding: float | None,
    squeeze: SqueezeScores,
    sample_count: int,
) -> Intelligence:
    """Rule-based templated narration. Deterministic — the same snapshot
    always produces the same paragraph, which is what makes it reviewable."""
    sentences: list[str] = []

    if oi_delta_pct is not None and price_delta_pct is not None:
        sentences.append(f"OI {_pct(oi_delta_pct)} sementara harga {_pct(price_delta_pct)}.")
    elif oi_delta_pct is not None:
        sentences.append(f"OI {_pct(oi_delta_pct)}.")
    sentences.append(_EXPANSION_SENTENCE[expansion])

    if aggression is not None:
        percent = aggression * 100.0
        if aggression >= AGGRESSION_STRONG:
            sentences.append(f"Buyer aggression di atas {percent:.0f}%.")
        elif aggression <= AGGRESSION_WEAK:
            sentences.append(f"Seller mendominasi, buyer aggression cuma {percent:.0f}%.")
        else:
            sentences.append(f"Buyer aggression {percent:.0f}% — seimbang.")

    if funding.current is not None:
        label = _funding_label(funding.current, funding.percentile_24h).lower()
        sentences.append(f"Funding {label}.")

    band = crowding_band(crowding)
    if band == "bullish_crowded":
        sentences.append("Buku posisi padat di sisi long — risiko long squeeze naik.")
    elif band == "bearish_crowded":
        sentences.append("Buku posisi padat di sisi short — risiko short squeeze naik.")

    sentences.append(_REGIME_SENTENCE[regime])

    if sample_count < 4:
        sentences.append("Catatan: sampel masih sedikit, baca sebagai indikasi awal.")

    return Intelligence(
        summary=" ".join(sentences),
        regime_label=REGIME_LABELS[regime],
        crowding_label=CROWDING_LABELS[band],
        expansion_label=EXPANSION_LABELS[expansion],
        funding_label=_funding_label(funding.current, funding.percentile_24h),
        oi_label=_oi_label(oi_delta_pct),
        aggression_label=_aggression_label(aggression),
        squeeze_label=_squeeze_label(squeeze),
    )


# --- assembly ------------------------------------------------------------


def _price_acceleration(price_deltas: dict[str, float | None]) -> float | None:
    """Recent pace minus the hour's average pace, both per 15 minutes.

    Velocity alone would call a steady grind "accelerating"; what matters for
    a squeeze is whether the last quarter hour is faster than the hour was.
    """
    recent = price_deltas.get("15m")
    hourly = price_deltas.get("1h")
    if recent is None:
        return None
    if hourly is None:
        return recent
    return recent - hourly / 4.0


def derive(symbol: str, series: Sequence[SnapshotPoint]) -> DerivativesIntelligence | None:
    """The one read model. `series` must be ascending by timestamp; the newest
    point is the raw snapshot, everything else is context for the deltas.

    Returns None for an empty series — the router turns that into a 404, which
    is the honest answer for a symbol nothing has ever been collected for.
    """
    if not series:
        return None
    latest = series[-1]

    oi_delta = _delta_map(series, lambda p: p.open_interest)
    price_delta = _delta_map(series, lambda p: p.price)
    reference_oi = _reference_delta(oi_delta)
    reference_price = _reference_delta(price_delta)

    expansion = classify_oi_expansion(reference_price, reference_oi)
    has_expansion_evidence = reference_price is not None and reference_oi is not None

    aggression = buyer_aggression(latest)
    funding = funding_trend(series)
    crowding = crowding_score(latest)
    momentum = momentum_score(
        expansion,
        aggression,
        latest.funding_rate,
        latest.premium,
        has_expansion_evidence=has_expansion_evidence,
    )
    squeeze = squeeze_scores(crowding, reference_oi, _price_acceleration(price_delta))
    regime = classify_regime(
        expansion=expansion,
        price_delta_pct=reference_price,
        oi_delta_pct=reference_oi,
        crowding=crowding,
        momentum=momentum,
    )

    span = _epoch(latest.timestamp) - _epoch(series[0].timestamp)

    return DerivativesIntelligence(
        raw=DerivativesRaw(
            symbol=symbol,
            timestamp=latest.timestamp,
            open_interest=latest.open_interest,
            open_interest_usd=latest.open_interest_usd,
            funding_rate=latest.funding_rate,
            long_short_ratio=latest.long_short_ratio,
            top_trader_accounts_ratio=latest.top_trader_accounts_ratio,
            top_trader_positions_ratio=latest.top_trader_positions_ratio,
            taker_buy_volume=latest.taker_buy_volume,
            taker_sell_volume=latest.taker_sell_volume,
            basis=latest.basis,
            premium=latest.premium,
            oi_marketcap_ratio=latest.oi_marketcap_ratio,
            price=latest.price,
        ),
        derived=Derived(
            oi_delta=oi_delta,
            price_delta=price_delta,
            funding_trend=funding,
            buyer_aggression=aggression,
            oi_expansion=expansion,
            crowding_score=None if crowding is None else round(crowding, 1),
            crowding_band=crowding_band(crowding),
            momentum_score=None if momentum is None else round(momentum, 1),
            squeeze=squeeze,
            sample_count=len(series),
            history_span_s=span,
        ),
        regime=regime,
        intelligence=build_intelligence(
            regime=regime,
            expansion=expansion,
            oi_delta_pct=reference_oi,
            price_delta_pct=reference_price,
            aggression=aggression,
            funding=funding,
            crowding=crowding,
            squeeze=squeeze,
            sample_count=len(series),
        ),
        scores=Scores(
            momentum=None if momentum is None else round(momentum, 1),
            crowding=None if crowding is None else round(crowding, 1),
            squeeze=squeeze,
        ),
    )


def _momentum_at(series: Sequence[SnapshotPoint], index: int) -> float | None:
    """Momentum as it would have read at `index`, using only points up to it —
    a sparkline that peeked at the future would be a backtest, not a history."""
    window = series[: index + 1]
    point = window[-1]
    oi_reference = _reference_delta(_delta_map(window, lambda p: p.open_interest))
    price_reference = _reference_delta(_delta_map(window, lambda p: p.price))
    expansion = classify_oi_expansion(price_reference, oi_reference)
    return momentum_score(
        expansion,
        buyer_aggression(point),
        point.funding_rate,
        point.premium,
        has_expansion_evidence=price_reference is not None and oi_reference is not None,
    )


def _squeeze_at(
    series: Sequence[SnapshotPoint], index: int, side: Literal["long", "short"]
) -> float | None:
    """Squeeze score as it would have read at `index`, same up-to-here rule as
    `_momentum_at` — a sparkline built from future crowding would be a
    backtest, not a history."""
    window = series[: index + 1]
    point = window[-1]
    crowding = crowding_score(point)
    oi_reference = _reference_delta(_delta_map(window, lambda p: p.open_interest))
    price_reference = _delta_map(window, lambda p: p.price)
    squeeze = squeeze_scores(crowding, oi_reference, _price_acceleration(price_reference))
    return squeeze.long if side == "long" else squeeze.short


def history_series(
    series: Sequence[SnapshotPoint], metric: HistoryMetric, window: HistoryWindow
) -> list[SparkPoint]:
    """Sparkline points for one metric over one lookback window.

    Computed here, exactly like the card values, so a sparkline can never
    disagree with the number printed above it.
    """
    if not series:
        return []
    cutoff = _epoch(series[-1].timestamp) - HISTORY_WINDOWS_S[window]

    points: list[SparkPoint] = []
    for index, point in enumerate(series):
        if _epoch(point.timestamp) < cutoff:
            continue
        value: float | None
        if metric == "oi":
            value = _finite(point.open_interest)
        elif metric == "funding":
            value = _finite(point.funding_rate)
        elif metric == "buyer_aggression":
            value = buyer_aggression(point)
        elif metric == "squeeze_long":
            value = _squeeze_at(series, index, "long")
        elif metric == "squeeze_short":
            value = _squeeze_at(series, index, "short")
        else:
            value = _momentum_at(series, index)
        if value is None:
            continue
        points.append(SparkPoint(t=int(_epoch(point.timestamp)), v=round(value, 8)))
    return points


# --- cross-symbol summary --------------------------------------------------


def build_summary(
    intelligences: Sequence[DerivativesIntelligence], *, top_n: int = 5
) -> DerivativesSummary:
    """One pass over already-derived reads — never recomputes a score, only
    ranks and counts what `derive()` already produced for each symbol.

    Every list is honestly empty rather than padded: a symbol without a
    momentum score is dropped from that ranking, and squeeze entries where
    neither side carries any pressure (`long == short == 0`, the `crowding is
    None` case) are dropped rather than shown as a fake 0-vs-0 tie.
    """
    with_momentum = [i for i in intelligences if i.scores.momentum is not None]
    momentum_ranked = sorted(
        with_momentum, key=lambda i: cast(float, i.scores.momentum), reverse=True
    )[:top_n]

    squeezed = [i for i in intelligences if max(i.scores.squeeze.long, i.scores.squeeze.short) > 0]
    squeeze_ranked = sorted(
        squeezed, key=lambda i: max(i.scores.squeeze.long, i.scores.squeeze.short), reverse=True
    )[:top_n]

    with_oi = [
        (i, i.derived.oi_delta.get("24h"))
        for i in intelligences
        if i.derived.oi_delta.get("24h") is not None
    ]
    oi_ranked = sorted(with_oi, key=lambda pair: cast(float, pair[1]), reverse=True)
    oi_gainers = [pair for pair in oi_ranked if cast(float, pair[1]) > 0][:top_n]
    oi_losers = [pair for pair in reversed(oi_ranked) if cast(float, pair[1]) < 0][:top_n]

    regime_counts: dict[MarketRegime, int] = {}
    for i in intelligences:
        regime_counts[i.regime] = regime_counts.get(i.regime, 0) + 1

    return DerivativesSummary(
        top_momentum=[
            SummaryMomentumEntry(
                symbol=i.raw.symbol,
                momentum=cast(float, i.scores.momentum),
                regime=i.regime,
                regime_label=REGIME_LABELS[i.regime],
            )
            for i in momentum_ranked
        ],
        top_squeeze=[
            SummarySqueezeEntry(
                symbol=i.raw.symbol,
                squeeze=i.scores.squeeze,
                dominant_side=(
                    "long" if i.scores.squeeze.long >= i.scores.squeeze.short else "short"
                ),
                squeeze_label=_squeeze_label(i.scores.squeeze),
            )
            for i in squeeze_ranked
        ],
        top_oi_gainers=[
            SummaryOiEntry(
                symbol=i.raw.symbol,
                oi_delta_pct=cast(float, delta),
                regime=i.regime,
                regime_label=REGIME_LABELS[i.regime],
            )
            for i, delta in oi_gainers
        ],
        top_oi_losers=[
            SummaryOiEntry(
                symbol=i.raw.symbol,
                oi_delta_pct=cast(float, delta),
                regime=i.regime,
                regime_label=REGIME_LABELS[i.regime],
            )
            for i, delta in oi_losers
        ],
        regime_distribution=[
            RegimeCount(regime=regime, regime_label=REGIME_LABELS[regime], count=count)
            for regime, count in sorted(regime_counts.items(), key=lambda kv: kv[1], reverse=True)
        ],
        symbols_covered=len(intelligences),
    )
