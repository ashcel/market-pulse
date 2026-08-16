"""Does `score` rank anything?

Every surfaced situation carries a score, the funnel gates on it
(`SituationConfig.min_score`), and the UI ranks by it. Nothing has ever checked
whether a higher score is followed by a better outcome. If it is not, the score
is decoration — an expensive one, because it decides what a human looks at.

The measurement is the **Information Coefficient**: the Spearman rank
correlation between the score known at detection and the return that followed
it, read across a set of horizons so the decay curve declares the score's honest
holding period (Strimpel, *Python for Algorithmic Trading Cookbook*, Ch. 5 & 8).
Rank correlation rather than Pearson because the score's scale is arbitrary —
only its ordering is ever used.

## Two different questions, and they are not interchangeable

* **IC against price.** Did the market move the way the setup claimed, over a
  fixed horizon, whether or not the trade was taken? This measures the *score*.
  Returns are direction-adjusted: a bearish setup's return is negated, so a
  positive number always means "the setup was right".
* **IC against realized R.** Did higher-scoring setups make more money once the
  entry, stop, trail and cost model had their say? This measures the *whole
  pipeline*, and it is conditional on a fill — `NO_FILL` rows have no R and are
  excluded, which is a selection the price-based IC does not suffer.

A score can rank price and not rank R (the plan throws the edge away), or rank
R and not price (the plan is doing the work). Both are reported, because the
difference is the finding.

## What this report cannot say

It emits **no verdicts**, for the same reason `instrument_report` does not: the
horizons, the modes and the cuts here are all read after the data exists, and
nothing is corrected for the number of them. A cut worth believing becomes a
registered arm with a gate fixed before it is evaluated — `research/arms-protocol.md`.

Two attenuation traps are reported rather than silently suffered:

1. **Range truncation.** Only situations above `min_score` are ever recorded, so
   the observed score range is a slice of the full one, and a rank correlation
   measured on a slice is biased toward zero. The score's dispersion is printed
   next to every IC so a near-zero IC on a near-constant score is not read as
   "the score does not work".
2. **Thin cross-sections.** A true IC is measured *within* one instant across
   many symbols, then averaged over instants. Detections arrive a few per hour,
   so most time buckets hold too few setups to rank at all. The sectional table
   reports how many buckets qualified; when that number is small the pooled
   number — which conflates cross-sectional with time-series variation — is all
   there is, and it says so.

Pure stdlib for the statistics, matching `arms_report`: p-values use the normal
approximation to Student's t, which is wrong in the fourth decimal at these
sample sizes and far below the resolution anything here turns on.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import statistics as st
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from smc.types import Candle
from sqlalchemy import text

from app.database import SessionFactory
from app.worker.binance import drop_unclosed_candle, fetch_klines_interval

REPORT_VERSION = "1.0.0"

#: The bar forward returns are measured on. One minute is the finest bar
#: Binance serves and the resolution the radar itself works at; anything
#: coarser would put the whole SCALP horizon inside two bars.
BASE_INTERVAL = "1m"
BAR_SECONDS = 60

#: Horizon label -> bars ahead. Spans a scalp's whole life: the mean SCALP hold
#: is ~10 minutes and `max_holding_seconds` is 2 hours, so the curve covers the
#: trade rather than sampling one point inside it.
HORIZONS: dict[str, int] = {
    "1m": 1,
    "3m": 3,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "2h": 120,
}

#: Below this many pairs an IC is printed but never marked. A rank correlation
#: on nine points is a picture of nine points.
MIN_N_FOR_A_CLAIM = 30

#: A cross-section needs at least this many simultaneous detections before the
#: ranking within it means anything.
MIN_SECTION = 5

#: How wide a cross-section's time bucket is, in seconds. Detections inside one
#: bucket are treated as simultaneous.
SECTION_SECONDS = 3_600


# ─────────────────────────────────────────────────────────────────────────────
# Statistics
# ─────────────────────────────────────────────────────────────────────────────


def _normal_sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def two_sided_p(t: float) -> float:
    return 2.0 * _normal_sf(abs(t))


def ranks(values: Sequence[float]) -> list[float]:
    """Fractional ranks, ties averaged.

    Ties are not rare here and must not be broken arbitrarily: the score is
    smoothed and quantised, so several setups genuinely share a value, and
    ordering them by their position in the list would manufacture a correlation
    out of arrival order.
    """
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        shared = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            out[order[k]] = shared
        i = j + 1
    return out


def pearson(xs: Sequence[float], ys: Sequence[float]) -> float | None:
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    mx, my = st.mean(xs), st.mean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        # One side is constant. Undefined, not zero — and the difference
        # matters, because a constant score is a fact about the funnel rather
        # than evidence about the score.
        return None
    return sxy / math.sqrt(sxx * syy)


def spearman(xs: Sequence[float], ys: Sequence[float]) -> float | None:
    """Rank correlation. The score's scale is arbitrary; only order is used."""
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    return pearson(ranks(xs), ranks(ys))


@dataclass(frozen=True, slots=True)
class PooledIC:
    """One Spearman correlation over every observation at one horizon."""

    horizon: str
    n: int
    ic: float
    t: float
    p: float
    score_sd: float
    score_span: tuple[float, float]
    unique_scores: int

    @property
    def marked(self) -> bool:
        """Whether this row may carry a `•`. Not a verdict and not corrected
        for the number of horizons tested — it marks only that this one
        interval excludes zero."""
        return self.n >= MIN_N_FOR_A_CLAIM and self.p < 0.05


def pooled_ic(
    scores: Sequence[float], returns: Sequence[float], horizon: str
) -> PooledIC | None:
    ic = spearman(scores, returns)
    if ic is None:
        return None
    n = len(scores)
    # t for a correlation coefficient. A perfect |r| = 1 divides by zero, so
    # the denominator is floored rather than special-cased to t=0 — which would
    # report a flawless ranking as the least significant result in the table.
    # The floor makes t enormous and p zero, and `MIN_N_FOR_A_CLAIM` is what
    # stops a perfect correlation over four points from being marked.
    denom = max(1.0 - ic * ic, 1e-12)
    t = ic * math.sqrt((n - 2) / denom) if n > 2 else 0.0
    return PooledIC(
        horizon=horizon,
        n=n,
        ic=ic,
        t=t,
        p=two_sided_p(t),
        score_sd=st.stdev(scores) if len(set(scores)) > 1 else 0.0,
        score_span=(min(scores), max(scores)),
        unique_scores=len(set(scores)),
    )


@dataclass(frozen=True, slots=True)
class SectionalIC:
    """The IC statistics table: one correlation per cross-section, then the
    distribution of those. This is the number a factor is normally judged on —
    `mean / std` is the risk-adjusted IC, and it answers "how reliably", not
    just "how much"."""

    horizon: str
    sections: int
    observations: int
    mean_ic: float
    sd_ic: float
    risk_adjusted: float
    t: float
    p: float

    @property
    def marked(self) -> bool:
        return self.sections >= 10 and self.p < 0.05


def sectional_ic(
    sections: Sequence[tuple[Sequence[float], Sequence[float]]], horizon: str
) -> SectionalIC | None:
    """Mean IC across cross-sections. `sections` are already filtered to those
    large enough to rank; a section whose score is constant yields no IC and is
    dropped rather than counted as zero."""
    per_section = [ic for scores, rets in sections if (ic := spearman(scores, rets)) is not None]
    if len(per_section) < 2:
        return None
    used = [len(s) for s, _ in sections]
    mean = st.mean(per_section)
    sd = st.stdev(per_section)
    se = sd / math.sqrt(len(per_section)) if sd > 0 else 0.0
    t = mean / se if se > 0 else 0.0
    return SectionalIC(
        horizon=horizon,
        sections=len(per_section),
        observations=sum(used),
        mean_ic=mean,
        sd_ic=sd,
        risk_adjusted=mean / sd if sd > 0 else 0.0,
        t=t,
        p=two_sided_p(t),
    )


# ─────────────────────────────────────────────────────────────────────────────
# The record
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class Detection:
    """One setup as the scorer saw it, plus what followed.

    `forward` is filled in afterwards from klines. It is keyed by horizon label
    and already direction-adjusted, so a positive value always means the setup
    was right.
    """

    id: str
    symbol: str
    mode: str
    direction: str
    detected_at: datetime
    score: float
    tier: str
    combo: str
    status: str
    gross_r: float
    realized_r: float
    forward: dict[str, float] = field(default_factory=dict)

    @property
    def settled(self) -> bool:
        return self.status in {"TARGET_HIT", "INVALIDATED", "EXPIRED"}


async def load_detections(
    strategy_version: str | None = None, since_days: int = 0
) -> list[Detection]:
    """Every captured setup, settled or not.

    Deliberately not restricted to settled rows: the price-based IC does not
    need a fill, and filtering to fills first would measure the score only on
    the setups the entry model happened to catch — a selection that has nothing
    to do with whether the score ranks.
    """
    sql = (
        "SELECT id, symbol, mode, direction, detected_at, score, tier, combo, "
        "status, gross_r, realized_r FROM forward_test_setups "
        "WHERE detected_at IS NOT NULL"
        + (" AND strategy_version = :sv" if strategy_version else "")
        + (" AND detected_at >= :since" if since_days else "")
        + " ORDER BY detected_at"
    )
    params: dict[str, Any] = {}
    if strategy_version:
        params["sv"] = strategy_version
    if since_days:
        params["since"] = datetime.now(UTC) - timedelta(days=since_days)

    async with SessionFactory() as db:
        result = await db.execute(text(sql), params)
        return [
            Detection(
                id=str(r.id),
                symbol=r.symbol,
                mode=r.mode,
                direction=r.direction,
                detected_at=r.detected_at,
                score=float(r.score),
                tier=r.tier or "",
                combo=r.combo or "",
                status=r.status,
                gross_r=float(r.gross_r or 0.0),
                realized_r=float(r.realized_r or 0.0),
            )
            for r in result
        ]


# ─────────────────────────────────────────────────────────────────────────────
# Forward returns
# ─────────────────────────────────────────────────────────────────────────────

Fetcher = Callable[[str, int, int], Awaitable[list[Candle]]]


async def _fetch_perp_1m(symbol: str, limit: int, end_time_ms: int) -> list[Candle]:
    return await fetch_klines_interval(
        symbol, BASE_INTERVAL, limit=limit, market="perp", end_time=end_time_ms
    )


async def fetch_window(
    symbol: str, start: datetime, end: datetime, fetch: Fetcher
) -> list[Candle]:
    """Closed 1m candles covering `[start, end]`, ascending and de-duplicated.

    Binance serves at most 1000 bars a call and pages backward from `endTime`,
    so a multi-day window takes several. Paging stops as soon as a page fails to
    reach further back, which is what a delisted or newly-listed symbol looks
    like — the caller gets a short series rather than an infinite loop.
    """
    start_s = int(start.timestamp())
    end_s = int(end.timestamp())
    by_time: dict[int, Candle] = {}
    cursor_ms = (end_s + BAR_SECONDS) * 1000

    for _ in range(32):
        page = drop_unclosed_candle(await fetch(symbol, 1000, cursor_ms))
        if not page:
            break
        fresh = [c for c in page if c.time not in by_time]
        for candle in page:
            by_time[candle.time] = candle
        earliest = min(c.time for c in page)
        if earliest <= start_s or not fresh:
            break
        cursor_ms = earliest * 1000

    return [by_time[t] for t in sorted(by_time) if start_s <= t <= end_s + BAR_SECONDS * 130]


def forward_returns_at(
    candles: Sequence[Candle], detected_at: datetime, direction: str
) -> dict[str, float]:
    """Direction-adjusted return from the last close knowable at detection.

    The anchor is the newest bar whose **close** had already happened when the
    setup was detected. `Candle.time` labels the bar's *open* and is a second
    epoch, so a bar anchors detection only once `time + BAR_SECONDS` has passed
    — the same arithmetic `app.evidence.forward_returns` documents, applied at
    an event instead of swept across a series. Using the bar that contained the
    detection would read a close from the future.
    """
    if not candles:
        return {}
    at = int(detected_at.timestamp())
    anchor = -1
    for i, candle in enumerate(candles):
        if candle.time + BAR_SECONDS <= at:
            anchor = i
        else:
            break
    if anchor < 0 or candles[anchor].close <= 0:
        return {}

    base = candles[anchor].close
    sign = -1.0 if direction == "bearish" else 1.0
    out: dict[str, float] = {}
    for label, bars in HORIZONS.items():
        ahead = anchor + bars
        if ahead >= len(candles):
            # The future this row would describe has not happened yet, or the
            # series has a hole in it. Nothing is interpolated.
            continue
        forward = candles[ahead].close
        if forward <= 0:
            continue
        out[label] = sign * (forward / base - 1.0) * 100.0
    return out


async def attach_forward_returns(
    detections: Sequence[Detection], fetch: Fetcher = _fetch_perp_1m
) -> tuple[int, int]:
    """Fills `Detection.forward` in place. Returns (symbols fetched, covered).

    One window per symbol rather than one per detection: a symbol with fifteen
    setups over four days is fifteen lookups into one series, not fifteen
    fetches. Failures are silent by design — a symbol whose history is gone
    contributes no rows and is reported as missing coverage, which is a
    different claim from a zero return.
    """
    by_symbol: dict[str, list[Detection]] = {}
    for detection in detections:
        by_symbol.setdefault(detection.symbol, []).append(detection)

    covered = 0
    for symbol, rows in by_symbol.items():
        start = min(r.detected_at for r in rows) - timedelta(minutes=5)
        end = max(r.detected_at for r in rows) + timedelta(
            minutes=max(HORIZONS.values()) + 5
        )
        candles = await fetch_window(symbol, start, end, fetch)
        for row in rows:
            row.forward = forward_returns_at(candles, row.detected_at, row.direction)
            if row.forward:
                covered += 1
    return len(by_symbol), covered


# ─────────────────────────────────────────────────────────────────────────────
# Assembly
# ─────────────────────────────────────────────────────────────────────────────


def sections_for(
    detections: Sequence[Detection], horizon: str, bucket_seconds: int = SECTION_SECONDS
) -> list[tuple[list[float], list[float]]]:
    """Detections grouped into time buckets, keeping only buckets big enough to
    rank. The bucket is the closest thing this record has to "one instant
    across many symbols"."""
    buckets: dict[int, list[Detection]] = {}
    for detection in detections:
        if horizon not in detection.forward:
            continue
        key = int(detection.detected_at.timestamp()) // bucket_seconds
        buckets.setdefault(key, []).append(detection)
    out = []
    for key in sorted(buckets):
        rows = buckets[key]
        if len(rows) < MIN_SECTION:
            continue
        out.append(([r.score for r in rows], [r.forward[horizon] for r in rows]))
    return out


#: A symbol needs this many detections before its own IC is worth printing.
MIN_PER_SYMBOL = 5


@dataclass(frozen=True, slots=True)
class Influence:
    """How much of a horizon's IC rests on one symbol."""

    symbol: str
    n: int
    ic_without: float
    drop: float


def jackknife_symbols(
    detections: Sequence[Detection], horizon: str, top: int = 5
) -> tuple[float, list[Influence]] | None:
    """Recompute the IC with each symbol removed in turn.

    The direct test of the question `instrument_report` exists for, applied to a
    correlation instead of a mean: if dropping one symbol out of a hundred
    collapses the IC, the IC was that symbol. Returns the full-sample IC and the
    symbols whose removal lowers it most.
    """
    usable = [d for d in detections if horizon in d.forward]
    full = spearman([d.score for d in usable], [d.forward[horizon] for d in usable])
    if full is None:
        return None

    influences: list[Influence] = []
    for symbol in {d.symbol for d in usable}:
        rest = [d for d in usable if d.symbol != symbol]
        without = spearman([d.score for d in rest], [d.forward[horizon] for d in rest])
        if without is None:
            continue
        influences.append(
            Influence(
                symbol=symbol,
                n=sum(1 for d in usable if d.symbol == symbol),
                ic_without=without,
                drop=full - without,
            )
        )
    influences.sort(key=lambda i: i.drop, reverse=True)
    return full, influences[:top]


def ex_top_symbols_ic(
    detections: Sequence[Detection], horizon: str, drop: Sequence[str]
) -> PooledIC | None:
    """The IC with a set of symbols removed altogether.

    Read this as an **adversarial floor, not an estimate**. The symbols passed
    in were chosen *because* they support the result, so removing them is the
    maximum of a hundred-odd comparisons and is guaranteed to lower the IC even
    on data with no concentration at all. It answers "how bad could this look
    if the five most helpful names had never traded", which is worth knowing and
    is not the same question as "is this IC concentrated".

    The per-symbol jackknife above is the unbiased read: it removes one symbol
    at a time, so every symbol gets the same treatment.
    """
    rest = [d for d in detections if horizon in d.forward and d.symbol not in set(drop)]
    if len(rest) < 3:
        return None
    return pooled_ic([d.score for d in rest], [d.forward[horizon] for d in rest], horizon)


def per_symbol_ic(
    detections: Sequence[Detection], horizon: str, min_n: int = MIN_PER_SYMBOL
) -> list[tuple[str, int, float]]:
    """One IC per symbol, for symbols with enough detections to rank.

    One vote per symbol rather than per trade. A pooled IC can be carried by a
    handful of heavily-detected names; this asks whether the *typical* symbol
    shows the same ordering.
    """
    by_symbol: dict[str, list[Detection]] = {}
    for detection in detections:
        if horizon in detection.forward:
            by_symbol.setdefault(detection.symbol, []).append(detection)
    out: list[tuple[str, int, float]] = []
    for symbol, rows in sorted(by_symbol.items()):
        if len(rows) < min_n:
            continue
        ic = spearman([r.score for r in rows], [r.forward[horizon] for r in rows])
        if ic is not None:
            out.append((symbol, len(rows), ic))
    return out


@dataclass
class Concentration:
    horizon: str
    full_ic: float
    influences: list[Influence]
    ex_top: PooledIC | None
    per_symbol: list[tuple[str, int, float]]


@dataclass
class Report:
    generated_at: datetime
    strategy_version: str | None
    total: int
    symbols: int
    covered: int
    price_ic: list[PooledIC] = field(default_factory=list)
    sectional: list[SectionalIC] = field(default_factory=list)
    by_mode: dict[str, list[PooledIC]] = field(default_factory=dict)
    outcome_ic: list[tuple[str, PooledIC | None]] = field(default_factory=list)
    concentration: list[Concentration] = field(default_factory=list)


def build(
    detections: Sequence[Detection],
    symbols: int,
    covered: int,
    strategy_version: str | None,
    now: datetime | None = None,
) -> Report:
    report = Report(
        generated_at=now or datetime.now(UTC),
        strategy_version=strategy_version,
        total=len(detections),
        symbols=symbols,
        covered=covered,
    )

    for label in HORIZONS:
        usable = [d for d in detections if label in d.forward]
        if len(usable) >= 3:
            result = pooled_ic([d.score for d in usable], [d.forward[label] for d in usable], label)
            if result:
                report.price_ic.append(result)
        sectional = sectional_ic(sections_for(detections, label), label)
        if sectional:
            report.sectional.append(sectional)

    # Split by mode, because pooling SCALP and INTRADAY has already hidden one
    # effect in this record (the `htf_aligned` registration) and the two read
    # different windows for both score and context.
    for mode in sorted({d.mode for d in detections}):
        rows: list[PooledIC] = []
        for label in HORIZONS:
            usable = [d for d in detections if d.mode == mode and label in d.forward]
            if len(usable) < 3:
                continue
            result = pooled_ic(
                [d.score for d in usable], [d.forward[label] for d in usable], label
            )
            if result:
                rows.append(result)
        if rows:
            report.by_mode[mode] = rows

    # Concentration is checked only where the pooled IC is worth checking:
    # running it on a horizon whose IC is already noise would print five
    # columns of nothing. The horizons chosen are fixed here rather than picked
    # from whichever ones looked best this run.
    for label in ("1m", "5m", "15m"):
        jack = jackknife_symbols(detections, label)
        if jack is None:
            continue
        full, influences = jack
        report.concentration.append(
            Concentration(
                horizon=label,
                full_ic=full,
                influences=influences,
                ex_top=ex_top_symbols_ic(detections, label, [i.symbol for i in influences]),
                per_symbol=per_symbol_ic(detections, label),
            )
        )

    settled = [d for d in detections if d.settled]
    for label, values in (
        ("gross R", [d.gross_r for d in settled]),
        ("net R", [d.realized_r for d in settled]),
    ):
        report.outcome_ic.append(
            (label, pooled_ic([d.score for d in settled], values, label) if settled else None)
        )
    return report


# ─────────────────────────────────────────────────────────────────────────────
# Rendering
# ─────────────────────────────────────────────────────────────────────────────


def _mark(marked: bool) -> str:
    return " •" if marked else ""


def render(report: Report) -> str:
    scope = report.strategy_version or "all strategy versions (pooled — read with care)"
    lines = [
        f"# Information coefficient — {report.generated_at:%Y-%m-%d}",
        "",
        f"*report {REPORT_VERSION} · {BASE_INTERVAL} bars · scope: {scope}*",
        "",
        f"- detections: **{report.total}** across {report.symbols} symbols",
        f"- with forward returns: **{report.covered}**"
        + (f" ({report.covered / report.total:.0%})" if report.total else ""),
        "",
        "A `•` marks only that one interval excludes zero. Nothing here is "
        "corrected for the number of horizons, modes or cuts tested, and "
        "nothing here is a verdict.",
        "",
    ]

    if report.price_ic:
        lines += [
            "## Score vs forward price (pooled)",
            "",
            "Direction-adjusted: positive means the setup was right. Pooled "
            "across time, so this conflates cross-sectional with time-series "
            "variation — read the sectional table below before believing it.",
            "",
            "| horizon | n | IC | t | p | score sd | score range | distinct |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for row in report.price_ic:
            lines.append(
                f"| {row.horizon} | {row.n} | {row.ic:+.3f}{_mark(row.marked)} | "
                f"{row.t:+.2f} | {row.p:.3f} | {row.score_sd:.1f} | "
                f"{row.score_span[0]:.0f}..{row.score_span[1]:.0f} | {row.unique_scores} |"
            )
        peak = max(report.price_ic, key=lambda r: abs(r.ic))
        lines += [
            "",
            f"|IC| peaks at **{peak.horizon}** ({peak.ic:+.3f}). That is the "
            "horizon the score is best at, which is not the same as a horizon "
            "worth trading — cost is not in this number.",
            "",
        ]

    lines += ["## Score vs forward price (cross-sectional)", ""]
    if report.sectional:
        lines += [
            f"One IC per {SECTION_SECONDS // 60}-minute bucket holding at least "
            f"{MIN_SECTION} simultaneous detections, then the distribution of "
            "those. `mean/sd` is the risk-adjusted IC: how *reliably* the score "
            "ranks, not just how much.",
            "",
            "| horizon | sections | obs | mean IC | sd | mean/sd | t | p |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for row in report.sectional:
            lines.append(
                f"| {row.horizon} | {row.sections} | {row.observations} | "
                f"{row.mean_ic:+.3f}{_mark(row.marked)} | {row.sd_ic:.3f} | "
                f"{row.risk_adjusted:+.2f} | {row.t:+.2f} | {row.p:.3f} |"
            )
        lines.append("")
    else:
        lines += [
            f"**No cross-section reached {MIN_SECTION} simultaneous detections.** "
            "The detector surfaces a few situations an hour across ~600 markets, "
            "which is the funnel working as designed and also the reason a true "
            "cross-sectional IC is not yet measurable. Only the pooled number "
            "above exists, and it carries the weaker claim.",
            "",
        ]

    if report.by_mode:
        lines += [
            "## By mode",
            "",
            "SCALP and INTRADAY read different event windows and different "
            "context timeframes. Pooling them has hidden an effect in this "
            "record before.",
            "",
        ]
        for mode, rows in report.by_mode.items():
            lines += [f"**{mode}**", "", "| horizon | n | IC | p |", "|---|---|---|---|"]
            for row in rows:
                lines.append(
                    f"| {row.horizon} | {row.n} | {row.ic:+.3f}{_mark(row.marked)} | "
                    f"{row.p:.3f} |"
                )
            lines.append("")

    if report.concentration:
        lines += [
            "## Is the IC carried by a few symbols?",
            "",
            "The question `instrument_report` exists for, asked of a "
            "correlation. Each symbol is removed in turn and the IC recomputed; "
            "a headline that collapses when one name out of a hundred leaves was "
            "that name, not the score.",
            "",
        ]
        for block in report.concentration:
            lines += [
                f"**{block.horizon}** — full-sample IC {block.full_ic:+.3f}",
                "",
                "| symbol removed | its n | IC without | drop |",
                "|---|---|---|---|",
            ]
            for influence in block.influences:
                lines.append(
                    f"| {influence.symbol} | {influence.n} | "
                    f"{influence.ic_without:+.3f} | {influence.drop:+.3f} |"
                )
            if block.ex_top:
                lines += [
                    "",
                    f"Adversarial floor — removing all {len(block.influences)} "
                    f"together: **{block.ex_top.ic:+.3f}** on n={block.ex_top.n} "
                    f"(p={block.ex_top.p:.3f}). These names were selected *for* "
                    "supporting the result, so this is the maximum of a hundred "
                    "comparisons and falls even on unconcentrated data. It is a "
                    "worst case, not an estimate.",
                ]
            if block.per_symbol:
                ics = [ic for _, _, ic in block.per_symbol]
                positive = sum(1 for ic in ics if ic > 0)
                # An IC over n points has sd ~ 1/sqrt(n-1) under the null. At
                # five or six detections per symbol that is ~0.45, so a median
                # this far from zero is not resolvable and the reader has to be
                # told rather than left to infer it.
                noise = st.mean([1.0 / math.sqrt(n - 1) for _, n, _ in block.per_symbol])
                lines += [
                    "",
                    f"One vote per symbol, for the {len(ics)} symbols with "
                    f"{MIN_PER_SYMBOL}+ detections: median IC "
                    f"**{st.median(ics):+.3f}**, {positive}/{len(ics)} positive — "
                    f"against a per-symbol noise sd of ~{noise:.2f} at these "
                    "sample sizes. Read the sign, not the number, and only when "
                    "it repeats across horizons.",
                ]
            else:
                lines += [
                    "",
                    f"No symbol has {MIN_PER_SYMBOL} detections at this horizon, "
                    "so there is no per-symbol view — the detector spreads thin "
                    "across the universe, which is the funnel working and also "
                    "the reason this cut cannot be made yet.",
                ]
            lines.append("")

    lines += [
        "## Score vs realized outcome",
        "",
        "Conditional on a fill, so this is the whole pipeline — score, entry "
        "zone, stop, trail and cost — not the score alone.",
        "",
        "| measure | n | IC | t | p |",
        "|---|---|---|---|---|",
    ]
    for label, row in report.outcome_ic:
        if row is None:
            lines.append(f"| {label} | 0 | — | — | — |")
        else:
            lines.append(
                f"| {label} | {row.n} | {row.ic:+.3f}{_mark(row.marked)} | "
                f"{row.t:+.2f} | {row.p:.3f} |"
            )

    lines += [
        "",
        "---",
        "",
        "An IC near zero on a score with little dispersion is a statement about "
        "the funnel, not about the score: everything below `min_score` was "
        "already discarded, and a rank correlation on a truncated range is "
        "biased toward zero. An IC near zero on a *wide* range is the finding.",
        "",
        "Nothing here changes the live detector. A cut worth believing becomes a "
        "registered arm in `engine/smc/arms.py` with a gate fixed before it is "
        "evaluated — `research/arms-protocol.md`.",
        "",
    ]
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────


async def _main(args: argparse.Namespace) -> int:
    detections = await load_detections(args.strategy_version, args.since_days)
    if not detections:
        print("no detections in scope")
        return 1
    symbols, covered = await attach_forward_returns(detections)
    report = build(detections, symbols, covered, args.strategy_version)
    document = render(report)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(document)
        print(f"wrote {args.out}")
    else:
        print(document)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Information coefficient of the situation score")
    parser.add_argument(
        "--strategy-version",
        default=None,
        help="restrict to one strategy_version; omitted pools every one",
    )
    parser.add_argument("--since-days", type=int, default=0)
    parser.add_argument("--out", default=None)
    return asyncio.run(_main(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
