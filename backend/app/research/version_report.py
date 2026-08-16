"""What each recorded cohort actually contains, beside what it claims to be.

`smc.version_archive` declares the cohorts. This joins that declaration to the
record and prints both together, because either half alone misleads:

* the archive alone says generation 5 and 6 pool on gross R, without saying that
  one of them holds 215 rows and the other eleven;
* the record alone gives a tidy `GROUP BY generation` that invites averaging
  columns nothing licenses averaging.

It reports **no verdicts**. Every mean here is descriptive — the gates that turn
a number into a decision live in `smc.arms` and are applied by `arms_report`.

Read it with:

    python -m app.research.version_report [--format markdown] [--out PATH]
"""

from __future__ import annotations

import argparse
import asyncio
import statistics as st
from dataclasses import dataclass, field
from datetime import datetime

from smc.forward_test import SETTLED_STATUSES
from smc.version_archive import (
    ARCHIVE,
    LIVE,
    METRICS,
    UNSTAMPED,
    VERSION_ARCHIVE_VERSION,
    Metric,
    Release,
    pooled_generations,
    release_for,
)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionFactory

#: This module's own version, so a stored report traces to the logic that made
#: it independently of the archive it read.
REPORT_VERSION = "1.0.0"

_SETTLED = tuple(sorted(SETTLED_STATUSES))

# `versions` is JSONB and `generation` is a number in it, so the cast is
# explicit. A row written before the stamp existed yields NULL and is bucketed
# separately rather than being folded into the first cohort.
_ROWS_SQL = """
    SELECT (versions->>'generation')::int AS generation,
           strategy_version,
           status,
           detected_at,
           entered_at,
           settled_at,
           gross_r,
           realized_r,
           cost_r
      FROM forward_test_setups
     ORDER BY detected_at
"""


@dataclass(frozen=True, slots=True)
class Row:
    generation: int | None
    strategy_version: str
    status: str
    detected_at: datetime
    entered: bool
    settled: bool
    gross_r: float
    realized_r: float
    cost_r: float


@dataclass
class Cohort:
    """One generation as the record actually holds it."""

    generation: int | None
    release: Release | None
    #: Every `strategy_version` seen on its rows. Normally one. More than one
    #: means the stamp and the archive disagree, which is worth seeing rather
    #: than averaging away.
    versions: set[str] = field(default_factory=set)
    detected: int = 0
    filled: int = 0
    settled: int = 0
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    gross: list[float] = field(default_factory=list)
    net: list[float] = field(default_factory=list)
    cost: list[float] = field(default_factory=list)

    @property
    def label(self) -> str:
        return UNSTAMPED if self.generation is None else str(self.generation)

    @property
    def mean_gross(self) -> float | None:
        return st.fmean(self.gross) if self.gross else None

    @property
    def mean_net(self) -> float | None:
        return st.fmean(self.net) if self.net else None

    @property
    def mean_cost(self) -> float | None:
        return st.fmean(self.cost) if self.cost else None


@dataclass(frozen=True)
class Pool:
    """A set of cohorts one metric may legitimately be averaged across."""

    metric: Metric
    generations: tuple[int, ...]
    n: int
    mean: float | None
    #: Cohorts in the archive that this pool excludes. Named, because "which
    #: rows am I throwing away" is the question a pooling rule has to answer.
    excluded: tuple[int, ...]


@dataclass(frozen=True)
class VersionReport:
    generated_at: datetime
    cohorts: tuple[Cohort, ...]
    pools: tuple[Pool, ...]
    total_rows: int


# ─────────────────────────────────────────────────────────────────────────────
# Building
# ─────────────────────────────────────────────────────────────────────────────


async def load_rows(db: AsyncSession | None = None) -> list[Row]:
    """Reads the whole table. It is a few hundred rows and the report is a
    cohort census — sampling it would defeat the point.

    Takes an optional session so the API route can reuse the request's rather
    than opening a second connection alongside it; the CLI passes nothing and
    gets its own.
    """
    if db is None:
        async with SessionFactory() as owned:
            return await load_rows(owned)

    result = await db.execute(text(_ROWS_SQL))
    return [
        Row(
            generation=r.generation,
            strategy_version=r.strategy_version or "",
            status=r.status,
            detected_at=r.detected_at,
            entered=r.entered_at is not None,
            settled=r.settled_at is not None and r.status in _SETTLED,
            gross_r=float(r.gross_r or 0.0),
            realized_r=float(r.realized_r or 0.0),
            cost_r=float(r.cost_r or 0.0),
        )
        for r in result.mappings().all()
    ]


def build_cohorts(rows: list[Row]) -> list[Cohort]:
    """Group the record by generation, archive entry attached.

    Cohorts the archive declares but the record has never produced are kept with
    zero counts. An empty cohort is a fact — it is how you see that a release
    shipped and then wrote nothing, which has happened here once already.
    """
    cohorts: dict[int | None, Cohort] = {
        release.generation: Cohort(generation=release.generation, release=release)
        for release in ARCHIVE
    }

    for row in rows:
        key = row.generation
        cohort = cohorts.get(key)
        if cohort is None:
            cohort = Cohort(generation=key, release=release_for(key))
            cohorts[key] = cohort

        cohort.detected += 1
        cohort.versions.add(row.strategy_version)
        if cohort.first_seen is None or row.detected_at < cohort.first_seen:
            cohort.first_seen = row.detected_at
        if cohort.last_seen is None or row.detected_at > cohort.last_seen:
            cohort.last_seen = row.detected_at
        if row.entered:
            cohort.filled += 1
        if row.settled:
            cohort.settled += 1
            # Only filled-and-settled rows carry an R. A NO_FILL settled with no
            # position is a real outcome of the plan, but averaging its 0.0 into
            # a per-trade mean would dilute every cohort by however often price
            # never arrived.
            if row.entered:
                cohort.gross.append(row.gross_r)
                cohort.net.append(row.realized_r)
                cohort.cost.append(row.cost_r)

    ordered = sorted(
        cohorts.values(),
        key=lambda c: (c.generation is None, c.generation or 0),
    )
    return ordered


def build_pools(cohorts: list[Cohort]) -> list[Pool]:
    """For each metric, what today's cohort may be averaged with."""
    by_generation = {c.generation: c for c in cohorts}
    declared = {r.generation for r in ARCHIVE}

    pools: list[Pool] = []
    for metric in METRICS:
        generations = pooled_generations(LIVE.generation, metric)
        values: list[float] = []
        n = 0
        for generation in generations:
            cohort = by_generation.get(generation)
            if cohort is None:
                continue
            if metric == "population":
                n += cohort.detected
            elif metric == "gross_r":
                values.extend(cohort.gross)
            else:
                values.extend(cohort.net)
        if metric != "population":
            n = len(values)
        pools.append(
            Pool(
                metric=metric,
                generations=generations,
                n=n,
                mean=st.fmean(values) if values else None,
                excluded=tuple(sorted(declared - set(generations))),
            )
        )
    return pools


async def build_report(db: AsyncSession | None = None) -> VersionReport:
    rows = await load_rows(db)
    cohorts = build_cohorts(rows)
    return VersionReport(
        generated_at=datetime.now(),
        cohorts=tuple(cohorts),
        pools=tuple(build_pools(cohorts)),
        total_rows=len(rows),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Rendering
# ─────────────────────────────────────────────────────────────────────────────


def _r(value: float | None) -> str:
    return "—" if value is None else f"{value:+.3f}R"


def _day(value: datetime | None) -> str:
    return "—" if value is None else value.date().isoformat()


def _flag(ok: bool) -> str:
    return "yes" if ok else "**no**"


def render_markdown(report: VersionReport) -> str:
    lines: list[str] = [
        "# Forward-test version archive",
        "",
        f"*archive {VERSION_ARCHIVE_VERSION} · report {REPORT_VERSION} · "
        f"{report.total_rows} rows · live generation {LIVE.generation} "
        f"({LIVE.strategy_version})*",
        "",
        "Descriptive only. No gate reads this file; a mean here is what the "
        "cohort contains, never a verdict on it.",
        "",
        "## Cohorts",
        "",
        "| gen | version | opened | last row | detected | filled | settled | gross | net | cost |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]

    for cohort in report.cohorts:
        versions = ", ".join(sorted(v for v in cohort.versions if v)) or (
            cohort.release.strategy_version if cohort.release else "—"
        )
        lines.append(
            f"| {cohort.label} | {versions} | {_day(cohort.first_seen)} | "
            f"{_day(cohort.last_seen)} | {cohort.detected} | {cohort.filled} | "
            f"{cohort.settled} | {_r(cohort.mean_gross)} | {_r(cohort.mean_net)} | "
            f"{_r(cohort.mean_cost)} |"
        )

    lines += [
        "",
        "Gross, net and cost are means over rows that both **filled and "
        "settled** — a NO_FILL is a real outcome of the plan but has no "
        "per-trade R, and averaging a zero in would dilute a cohort by however "
        "often price never arrived.",
        "",
        "## What each generation changed",
        "",
    ]

    for release in ARCHIVE:
        lines.append(
            f"### Generation {release.generation} — {release.summary} "
            f"(`{release.forward_test_version}`, opened {release.opened.isoformat()})"
        )
        lines.append("")
        for change in release.changed:
            lines.append(f"- {change}")
        lines.append("")
        if release is ARCHIVE[0]:
            lines.append("Nothing precedes it, so it pools with nothing.")
        else:
            lines.append(
                f"Pools with generation {release.generation - 1} on — "
                f"gross: {_flag(release.gross_comparable)} · "
                f"net: {_flag(release.net_comparable)} · "
                f"population: {_flag(release.population_comparable)}"
            )
        if release.note:
            lines += ["", release.note]
        lines.append("")

    lines += [
        "## What today's numbers may pool",
        "",
        "| metric | generations | n | mean | excluded |",
        "|---|---|---|---|---|",
    ]
    for pool in report.pools:
        generations = ", ".join(str(g) for g in pool.generations) or "—"
        excluded = ", ".join(str(g) for g in pool.excluded) or "none"
        mean = "—" if pool.metric == "population" else _r(pool.mean)
        lines.append(
            f"| `{pool.metric}` | {generations} | {pool.n} | {mean} | {excluded} |"
        )

    lines += [
        "",
        f"Unstamped rows are excluded from every pool. They read `{UNSTAMPED}` "
        "because a missing provenance stamp is not a known value, and mapping "
        "it onto the oldest cohort would be a guess wearing a number's clothes.",
        "",
    ]
    return "\n".join(lines)


async def _main() -> None:
    parser = argparse.ArgumentParser(
        description="What each recorded forward-test cohort contains"
    )
    parser.add_argument("--format", choices=("markdown",), default="markdown")
    parser.add_argument("--out", help="write to this path instead of stdout")
    args = parser.parse_args()

    report = await build_report()
    rendered = render_markdown(report)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(rendered + "\n")
    else:
        print(rendered)


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
