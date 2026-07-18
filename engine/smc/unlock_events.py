"""DeFiLlama emissions → catalyst_event (unlock) normalization. Pure and
fixture-testable: the worker's unlock pass fetches per-protocol emissions files
and resolves tickers; this file decides which upcoming token unlocks qualify as
calendar catalysts.

Why DeFiLlama (replacing CoinMarketCal, retired 2026-07-18):
- Free and keyless (the dataset CDN), where CoinMarketCal now needs a paid key.
- Ships `supplyMetrics.maxSupply`, so an unlock's percent-of-supply is KNOWN
  here — the old free tier left it null. When maxSupply is absent (0/None) we
  still fall back to the "size unknown → scheduling fact" convention.

Filtering philosophy (high-signal over volume):
- Only `metadata.events` of type "cliff" (discrete releases) — linear
  rate-change rows are continuous drip, not a datable catalyst.
- Same-day cliffs for one token are aggregated into a single event (a day's
  total release is the thing a holder reacts to, not each tranche).
- A dust gate drops sub-threshold cliffs when supply is known; size-unknown
  cliffs are kept but capped, so a missing maxSupply can't flood the calendar.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from smc.catalyst_events import CatalystEventInput

# A cliff releasing less than this share of max supply is noise for a calendar
# overlay (DeFiLlama models some daily vesting as a stream of tiny cliffs).
_DEFAULT_MIN_PCT = 0.001  # 0.1% of supply
# How far ahead to surface unlocks. Unlocks cluster monthly, so a 7-day window
# would usually be empty; the read model widens its `upcoming` gate to match.
_DEFAULT_HORIZON_DAYS = 45
# When supply is unknown we can't dust-filter, so cap how many size-unknown
# cliffs one token may contribute — a data gap must not swamp the overlay.
_SIZE_UNKNOWN_CAP = 3


@dataclass(slots=True)
class _DayCliff:
    day_ms: int
    tokens: float


def _iso(day_ms: int) -> str:
    return (
        datetime.fromtimestamp(day_ms / 1000, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _fmt_tokens(n: float) -> str:
    """Compact human token count: 56,125,000 → '56.1M', 1_200 → '1.2K'."""
    for unit, div in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if abs(n) >= div:
            return f"{n / div:.1f}{unit}"
    return f"{n:.0f}"


def _day_floor_ms(timestamp_s: float) -> int:
    """Round a unix-seconds timestamp down to its UTC day (ms)."""
    d = datetime.fromtimestamp(timestamp_s, tz=UTC).date()
    return int(datetime(d.year, d.month, d.day, tzinfo=UTC).timestamp() * 1000)


def normalize_defillama_unlocks(
    payload: object,
    symbol: str,
    slug: str,
    now_ms: float,
    *,
    horizon_days: int = _DEFAULT_HORIZON_DAYS,
    min_pct: float = _DEFAULT_MIN_PCT,
) -> list[CatalystEventInput]:
    """One protocol's emissions payload → upcoming unlock catalysts for `symbol`.

    A payload-shape surprise returns [] (the caller records the fetch error
    separately — an empty schedule is valid, e.g. a fully-unlocked token).
    """
    if not isinstance(payload, dict):
        return []
    metadata = payload.get("metadata")
    events = metadata.get("events") if isinstance(metadata, dict) else None
    if not isinstance(events, list):
        return []

    supply_metrics = payload.get("supplyMetrics")
    max_supply = 0.0
    if isinstance(supply_metrics, dict):
        raw = supply_metrics.get("maxSupply")
        if isinstance(raw, (int, float)) and raw > 0:
            max_supply = float(raw)

    horizon_ms = now_ms + horizon_days * 24 * 60 * 60_000

    # Sum every future cliff into its UTC day (multiple tranches, one catalyst).
    by_day: dict[int, float] = defaultdict(float)
    for ev in events:
        if not isinstance(ev, dict):
            continue
        # "cliff" is a discrete release; None appears on data-gap protocols and
        # is treated as a release too. "linear" rows are drip — skipped.
        if ev.get("unlockType") not in ("cliff", None):
            continue
        ts = ev.get("timestamp")
        if not isinstance(ts, (int, float)):
            continue
        ts_ms = float(ts) * 1000
        if ts_ms <= now_ms or ts_ms > horizon_ms:
            continue
        tokens = ev.get("noOfTokens")
        amount = 0.0
        if isinstance(tokens, list) and tokens:
            last = tokens[-1]
            if isinstance(last, (int, float)):
                amount = float(last)
        if amount <= 0:
            continue
        by_day[_day_floor_ms(float(ts))] += amount

    cliffs = [_DayCliff(day_ms=d, tokens=t) for d, t in by_day.items()]
    cliffs.sort(key=lambda c: c.day_ms)

    out: list[CatalystEventInput] = []
    size_unknown_used = 0
    for cliff in cliffs:
        pct = cliff.tokens / max_supply if max_supply > 0 else None
        if pct is not None:
            if pct < min_pct:
                continue  # dust
        else:
            # Size unknown: keep a few, then stop — never flood on a data gap.
            if size_unknown_used >= _SIZE_UNKNOWN_CAP:
                continue
            size_unknown_used += 1

        pct_str = f"{pct * 100:.2f}% of supply" if pct is not None else "size unknown"
        title = f"{symbol} token unlock — {pct_str} ({_fmt_tokens(cliff.tokens)} {symbol})"
        out.append(
            CatalystEventInput(
                symbol=symbol,
                kind="unlock",
                title=title,
                description=None,
                occurs_at=_iso(cliff.day_ms),
                source="defillama",
                source_id=slug,
                url="https://defillama.com/unlocks",
                credibility=None,
                percent_of_supply=pct,
                # Day-stable key: a rescheduled cliff lands as a new row and the
                # stale one prunes out once past — same lifecycle as calendar.
                dedup_key=f"defillama:{slug}:{cliff.day_ms}:{symbol}",
            )
        )
    return out
