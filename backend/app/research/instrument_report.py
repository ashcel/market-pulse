"""Does the edge belong to the pattern, or to the symbols the pattern found?

This is the question the arms report cannot ask. `arms_report` judges
pre-registered alternatives against frozen gates and returns verdicts; this
returns **no verdict about anything**, because every cut in it was chosen after
seeing the data. It exists to generate hypotheses precisely enough that one of
them can later be registered as an arm and paid for out of sample.

The finding that prompted it, on the first 264 settled setups:

    all 263      gross +0.093R   sum +24.5R
    ex-top-5     gross +0.019R   sum  +4.6R     t=+0.23
    displacement gross +0.408R   sum +23.6R  ← of which 101% came from six
                                                symbols holding eight trades

An edge carried by five symbols out of a hundred is not yet a pattern; it is an
instrument effect wearing a pattern's clothes, and no amount of extra sample on
the *pattern* will settle it. So the record now freezes what kind of instrument
each setup was found on (`SetupSnapshot`: quote volume, 24h change, trade rate,
the symbol's own noise band, listing age), and this module reads them back.

Three rules, all of them the same rule:

1. **No verdicts.** Nothing here says PASS, RETIRE or "use this filter". A cut
   that looks decisive is a candidate for `smc.arms`, and it becomes real by
   surviving a registered gate on rows collected *after* it was written down.
2. **Concentration is reported before every cut**, because a subset that looks
   good and a subset that contains LSK are hard to tell apart otherwise.
3. **Coverage is reported.** The instrument facts began being written on
   2026-08-15; rows before that have none, and are counted as unknown rather
   than being back-filled from today's ticker — which would stamp a later
   instant's fact onto an earlier detection.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import statistics as st
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text

from app.database import SessionFactory

REPORT_VERSION = "1.0.0"

#: Below this, a bucket is shown but never marked as separable from zero. The
#: threshold is not a power calculation — it is a floor under the arithmetic,
#: so a bucket cannot be marked on a spread it does not yet have.
MIN_N_FOR_A_CLAIM = 10

#: Buckets are fixed here rather than derived from the data, so a later run
#: cannot quietly move a boundary onto whichever side made a result.
LISTING_AGE_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("<7d", 0.0, 7.0),
    ("7-30d", 7.0, 30.0),
    ("30-90d", 30.0, 90.0),
    ("90-365d", 90.0, 365.0),
    (">=365d", 365.0, math.inf),
)

QUOTE_VOLUME_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("<10M", 0.0, 1e7),
    ("10-50M", 1e7, 5e7),
    ("50-200M", 5e7, 2e8),
    (">=200M", 2e8, math.inf),
)

#: How many of the symbol's own 1m noise bands the stop sits outside of. Below
#: 1.0 the "invalidation" is inside the range the symbol prints every minute.
STOP_NOISE_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("<1x (inside noise)", 0.0, 1.0),
    ("1-2x", 1.0, 2.0),
    ("2-4x", 2.0, 4.0),
    (">=4x", 4.0, math.inf),
)

CHANGE_24H_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("<-10%", -math.inf, -10.0),
    ("-10..0%", -10.0, 0.0),
    ("0..10%", 0.0, 10.0),
    ("10..30%", 10.0, 30.0),
    (">=30%", 30.0, math.inf),
)


# ─────────────────────────────────────────────────────────────────────────────
# Statistics — deliberately the same primitives as arms_report, no more
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Cell:
    """One bucket of settled setups."""

    label: str
    n: int
    gross_mean: float
    gross_se: float
    net_mean: float
    win_rate: float
    gross_sum: float
    #: The single largest symbol's signed contribution, in R.
    top_symbol_r: float
    #: That contribution as a share of the bucket's total *absolute* R flow.
    #: Deliberately not a share of the net sum: a bucket whose wins and losses
    #: nearly cancel has a near-zero denominator, and dividing by it produces
    #: figures like "+600%" that describe the arithmetic rather than the book.
    top_symbol_share: float
    top_symbol: str

    @property
    def t(self) -> float:
        return self.gross_mean / self.gross_se if self.gross_se else 0.0

    @property
    def ci(self) -> tuple[float, float]:
        half = 1.96 * self.gross_se
        return (self.gross_mean - half, self.gross_mean + half)

    @property
    def is_distinguishable(self) -> bool:
        """Whether the bucket's own mean is separable from zero at 95%.

        Not a verdict and not corrected for the number of cuts in this report —
        which is exactly why nothing may be promoted on it.

        A zero standard error is never treated as certainty. One observation
        has no spread to measure, and a handful that happen to share a value
        (three stops for exactly -1.000R) have no spread *yet* — in both cases
        the interval collapses to a point and would otherwise mark the bucket
        as a result. That is the report's own failure mode, not a finding.
        """
        if self.n < MIN_N_FOR_A_CLAIM or self.gross_se <= 0.0:
            return False
        low, high = self.ci
        return low > 0.0 or high < 0.0


def summarize(label: str, rows: Sequence[dict[str, Any]]) -> Cell:
    n = len(rows)
    if n == 0:
        return Cell(label, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, "")

    gross = [float(r["gross_r"]) for r in rows]
    net = [float(r["realized_r"]) for r in rows]
    mean = st.fmean(gross)
    sd = st.stdev(gross) if n > 1 else 0.0
    se = sd / math.sqrt(n) if n > 1 else 0.0

    by_symbol: dict[str, float] = {}
    for row in rows:
        by_symbol[row["symbol"]] = by_symbol.get(row["symbol"], 0.0) + float(row["gross_r"])
    total = sum(gross)
    flow = sum(abs(g) for g in gross)
    top_symbol, top_sum = max(by_symbol.items(), key=lambda kv: abs(kv[1]))

    return Cell(
        label=label,
        n=n,
        gross_mean=mean,
        gross_se=se,
        net_mean=st.fmean(net),
        win_rate=sum(1 for g in gross if g > 0) / n,
        gross_sum=total,
        top_symbol_r=top_sum,
        top_symbol_share=(abs(top_sum) / flow) if flow > 1e-9 else 0.0,
        top_symbol=top_symbol,
    )


def bucketed(
    rows: Sequence[dict[str, Any]],
    value: Callable[[dict[str, Any]], float | None],
    buckets: Sequence[tuple[str, float, float]],
) -> list[Cell]:
    """Rows split by fixed bounds, plus an explicit `unknown` cell.

    A row whose fact is missing lands in `unknown` and never in a numbered
    bucket: an absent input is not a zero, and silently treating it as one is
    how a coverage gap turns into a finding.
    """
    groups: dict[str, list[dict[str, Any]]] = {label: [] for label, _, _ in buckets}
    unknown: list[dict[str, Any]] = []

    for row in rows:
        v = value(row)
        if v is None:
            unknown.append(row)
            continue
        for label, low, high in buckets:
            if low <= v < high:
                groups[label].append(row)
                break
        else:
            unknown.append(row)

    cells = [summarize(label, groups[label]) for label, _, _ in buckets]
    cells.append(summarize("unknown", unknown))
    return [c for c in cells if c.n > 0]


# ─────────────────────────────────────────────────────────────────────────────
# Concentration
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Concentration:
    """How much of a book's result rests on how few symbols."""

    n: int
    symbols: int
    gross_sum: float
    top5_sum: float
    top5_share: float
    ex_top5: Cell
    #: Mean of each symbol's own mean — one vote per symbol, not per trade.
    equal_weight_mean: float
    median_symbol_mean: float
    #: Symbols needed to account for half the gross R, in rank order.
    symbols_for_half: int

    @property
    def is_concentrated(self) -> bool:
        """A book whose top five symbols carry most of it. Not a threshold
        anyone should trade on — a flag on the reading of every cut below."""
        return abs(self.top5_share) >= 0.5


def concentration(rows: Sequence[dict[str, Any]]) -> Concentration:
    by_symbol: dict[str, list[float]] = {}
    for row in rows:
        by_symbol.setdefault(row["symbol"], []).append(float(row["gross_r"]))

    total = sum(float(r["gross_r"]) for r in rows)
    ranked = sorted(by_symbol.items(), key=lambda kv: -abs(sum(kv[1])))
    top5 = {symbol for symbol, _ in ranked[:5]}
    top5_sum = sum(sum(v) for s, v in ranked[:5])

    running = 0.0
    needed = 0
    for _, values in sorted(by_symbol.items(), key=lambda kv: -sum(kv[1])):
        if total <= 0 or running >= total / 2.0:
            break
        running += sum(values)
        needed += 1

    means = [st.fmean(v) for v in by_symbol.values()]
    return Concentration(
        n=len(rows),
        symbols=len(by_symbol),
        gross_sum=total,
        top5_sum=top5_sum,
        top5_share=(top5_sum / total) if abs(total) > 1e-9 else 0.0,
        ex_top5=summarize("ex-top-5 symbols", [r for r in rows if r["symbol"] not in top5]),
        equal_weight_mean=st.fmean(means) if means else 0.0,
        median_symbol_mean=st.median(means) if means else 0.0,
        symbols_for_half=needed,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Reading
# ─────────────────────────────────────────────────────────────────────────────

SETTLED_SQL = """
    select symbol, gross_r, realized_r, cost_r, combo, tier, mode, direction,
           strategy_version, evidence, detected_at
      from forward_test_setups
     where settled_at is not null
       and ($1::text is null or strategy_version = $1::text)
"""


async def load_settled(strategy_version: str | None = None) -> list[dict[str, Any]]:
    query = text(
        "select symbol, gross_r, realized_r, cost_r, combo, tier, mode, direction, "
        "strategy_version, evidence, detected_at "
        "from forward_test_setups where settled_at is not null"
        + (" and strategy_version = :sv" if strategy_version else "")
    )
    params = {"sv": strategy_version} if strategy_version else {}
    async with SessionFactory() as db:
        result = await db.execute(query, params)
        return [dict(row) for row in result.mappings().all()]


def _fact(row: dict[str, Any], key: str) -> float | None:
    evidence = row.get("evidence") or {}
    value = evidence.get(key)
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def coverage(rows: Sequence[dict[str, Any]], key: str) -> tuple[int, int]:
    have = sum(1 for r in rows if _fact(r, key) is not None)
    return have, len(rows)


# ─────────────────────────────────────────────────────────────────────────────
# Rendering
# ─────────────────────────────────────────────────────────────────────────────


def _cell_row(cell: Cell) -> str:
    low, high = cell.ci
    flag = "•" if cell.is_distinguishable else ""
    return (
        f"| `{cell.label}` | {cell.n} | {cell.gross_mean:+.3f}R | "
        f"[{low:+.3f}, {high:+.3f}] | {cell.net_mean:+.3f}R | "
        f"{cell.win_rate * 100:.0f}% | {cell.top_symbol} {cell.top_symbol_r:+.1f}R "
        f"({cell.top_symbol_share * 100:.0f}% of flow) | {flag} |"
    )


def _table(title: str, cells: Sequence[Cell], note: str = "") -> list[str]:
    out = [f"### {title}", ""]
    if note:
        out += [note, ""]
    out += [
        "| bucket | n | gross | 95% CI | net | win | largest symbol | |",
        "|---|---|---|---|---|---|---|---|",
    ]
    out += [_cell_row(c) for c in cells]
    out.append("")
    return out


def render(rows: Sequence[dict[str, Any]], strategy_version: str | None) -> str:
    now = datetime.now(UTC)
    scope = strategy_version or "all strategy versions (pooled — read with care)"
    lines = [
        f"# Instrument effects — {now:%Y-%m-%d}",
        "",
        f"*report {REPORT_VERSION} · scope: {scope} · {len(rows)} settled*",
        "",
        "**Exploratory. No verdicts, no promotions.** Every cut below was chosen "
        "after seeing the data, none is corrected for the number of cuts, and a "
        "`•` marks only that a bucket's own mean excludes zero — not that it "
        "means anything. A cut earns belief by being registered in "
        "`smc.arms` and surviving its gate on rows collected afterwards.",
        "",
    ]

    if not rows:
        lines += ["No settled setups in scope.", ""]
        return "\n".join(lines)

    conc = concentration(rows)
    lines += [
        "## Concentration",
        "",
        f"- {conc.n} settled across **{conc.symbols} symbols**, gross **{conc.gross_sum:+.1f}R**",
        f"- top 5 symbols carry **{conc.top5_sum:+.1f}R** — "
        f"**{conc.top5_share * 100:.0f}%** of the total",
        f"- half the gross R comes from **{conc.symbols_for_half} symbol(s)**",
        f"- ex-top-5: {conc.ex_top5.n} settled, gross "
        f"**{conc.ex_top5.gross_mean:+.3f}R** (t={conc.ex_top5.t:+.2f}), "
        f"net {conc.ex_top5.net_mean:+.3f}R",
        f"- one vote per symbol: mean **{conc.equal_weight_mean:+.3f}R**, "
        f"median **{conc.median_symbol_mean:+.3f}R**",
        "",
    ]
    if conc.is_concentrated:
        lines += [
            "> The top five symbols carry most of this book. Until that is "
            "explained, every table below is at least as likely to be "
            "describing those symbols as the pattern they were found by.",
            "",
        ]

    lines += ["## Cuts by instrument", ""]

    for title, key, buckets, note in (
        (
            "Listing age at detection",
            "listing_age_days",
            LISTING_AGE_BUCKETS,
            "A perp that onboarded last week does not trade like one listed two "
            "years ago; if the edge lives in one bucket it is an instrument "
            "effect, not a pattern.",
        ),
        (
            "24h quote volume",
            "quote_volume_24h",
            QUOTE_VOLUME_BUCKETS,
            "Liquidity at detection. The most direct candidate for a "
            "'this symbol is untradeable' filter.",
        ),
        (
            "Stop width against the symbol's own noise",
            "stop_noise_ratio",
            STOP_NOISE_BUCKETS,
            "Below 1x the invalidation sits inside the range the symbol prints "
            "every minute, which makes the stop a coin flip rather than a "
            "structural level.",
        ),
        (
            "Where the symbol already was",
            "change_24h_pct",
            CHANGE_24H_BUCKETS,
            "Whether the setup was found on something already extended.",
        ),
    ):
        have, total = coverage(rows, key)
        cells = bucketed(rows, lambda r, k=key: _fact(r, k), buckets)
        header = f"{title} — coverage {have}/{total}"
        if have == 0:
            lines += [
                f"### {header}",
                "",
                "Not yet recorded on any settled row. Rows written before the "
                "instrument facts shipped carry none, and back-filling them "
                "from today's ticker would stamp a later instant's fact onto an "
                "earlier detection.",
                "",
            ]
            continue
        lines += _table(header, cells, note)

    lines += ["## Cuts by setup (for contrast)", ""]
    for title, field in (("Combo", "combo"), ("Mode", "mode"), ("Direction", "direction")):
        groups: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            groups.setdefault(str(row[field]), []).append(row)
        cells = sorted(
            (summarize(k, v) for k, v in groups.items()), key=lambda c: -c.n
        )
        lines += _table(title, cells)

    lines += [
        "---",
        "",
        "Nothing here changes the live detector. The next step for any cut worth "
        "believing is a registered arm in `engine/smc/arms.py` with a "
        "pre-registered gate — see `research/arms-protocol.md`.",
        "",
    ]
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────


async def _main(args: argparse.Namespace) -> int:
    rows = await load_settled(args.strategy_version)
    if args.since_days:
        cutoff = datetime.now(UTC) - timedelta(days=args.since_days)
        rows = [r for r in rows if r["detected_at"] and r["detected_at"] >= cutoff]

    document = render(rows, args.strategy_version)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(document)
    else:
        print(document)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
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
