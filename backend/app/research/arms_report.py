"""The weekly arms report: what each pre-registered arm did, and whether that
is yet allowed to mean anything.

This module *applies* the gates in `smc.arms`. It does not invent a criterion
that fits the week, it does not rank arms that have not met their floor, and it
does not promote anything — a verdict here is an input to a human decision
recorded as an EDR, exactly as `research/arms-protocol.md` says.

Three things it exists to stop, all of which the record has already produced
once:

1. **Reading a week as a result.** A week is ~700 settled setups at an
   observation sd of ~1.4R, so a weekly mean carries a standard error near
   0.05R. Differences smaller than that are the tape. Every gate is therefore
   applied to the arm's **cumulative** sample since registration; the weekly
   numbers are shown because they are what changed, not because they decide.
2. **Counting a cost artifact as edge.** `structural_swing` once showed
   t=+2.82 against the control on net R at n=6, on a gross difference of
   exactly 0.000 — the entire "win" was a wider stop paying proportionally less
   fee. Gates are on **gross** R for that reason, and net is reported beside it
   so the arithmetic stays visible.
3. **Fifty-two chances a year to be fooled.** Every arm judged in a run goes
   through one Holm–Bonferroni family, so the family-wise error rate is the
   stated alpha rather than alpha per arm per week.

Pure stdlib by choice: no numpy, no scipy. The p-values use the normal
approximation to Student's t, which at the smallest registered floor (n=150) is
wrong in the fourth decimal — far below the resolution any decision here turns
on.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import statistics as st
import textwrap
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from smc.arms import ARMS, ARMS_VERSION, Arm
from smc.forward_test import SETTLED_STATUSES
from sqlalchemy import text

from app.database import SessionFactory
from app.research.recorder import STRATEGY_VERSION

#: The report's own version, so a stored report can be traced to the logic that
#: produced it independently of the registry it read.
REPORT_VERSION = "1.0.0"

Verdict = Literal["PASS", "RETIRE", "FAIL", "INSUFFICIENT", "NO DATA"]

#: Restated here only to price *scenarios* against the record. The live figures
#: are always read back off the row (`cost_r`, `realized_r`) rather than assumed
#: from these, so a config change cannot silently reprice the live column.
MAKER_FEE_PCT = 0.02
MAKER_SLIPPAGE_PCT = 0.01
TAKER_FEE_PCT = 0.05
TAKER_SLIPPAGE_PCT = 0.02


# ─────────────────────────────────────────────────────────────────────────────
# Statistics
# ─────────────────────────────────────────────────────────────────────────────


def _normal_sf(z: float) -> float:
    """P(Z > z) for the standard normal."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def two_sided_p(t: float) -> float:
    return 2.0 * _normal_sf(abs(t))


@dataclass(frozen=True, slots=True)
class Comparison:
    """One arm against the control on one measure."""

    n: int
    control_mean: float
    arm_mean: float
    edge: float
    se: float
    t: float
    p: float

    @property
    def ci95(self) -> tuple[float, float]:
        return (self.edge - 1.96 * self.se, self.edge + 1.96 * self.se)

    def n_for_significance(self) -> int | None:
        """How many observations the *observed* effect would need to clear
        t=2. `None` when the effect is zero or adverse — there is then no
        sample size that rescues it, and quoting one would imply otherwise."""
        if self.edge <= 0 or self.se <= 0 or self.n <= 1:
            return None
        sd = self.se * math.sqrt(self.n)
        return int((2.0 * sd / self.edge) ** 2) + 1


def paired(control: Sequence[float], arm: Sequence[float]) -> Comparison | None:
    """Arm minus control, on the same setups.

    Pairing is the whole reason this is affordable: the between-setup variance
    (sd ~1.4R) cancels, and the residual is only the disagreement between the
    two rules. On the standing record that took the sample needed to resolve
    `wide_trail` from ~13,000 observations to ~420.
    """
    if len(control) != len(arm) or len(control) < 2:
        return None
    diffs = [a - c for c, a in zip(control, arm, strict=True)]
    n = len(diffs)
    mean = st.mean(diffs)
    sd = st.stdev(diffs)
    se = sd / math.sqrt(n) if sd > 0 else 0.0
    t = mean / se if se > 0 else 0.0
    return Comparison(n, st.mean(control), st.mean(arm), mean, se, t, two_sided_p(t))


def unpaired(control: Sequence[float], arm: Sequence[float]) -> Comparison | None:
    """Welch's t for a subset against the rest of the population.

    Used only for detector arms, which cannot be paired: the arm's claim is
    that a *different set of setups* should have existed, so there is no
    matching observation to difference against. That is why their registered
    floors are so much higher than a settled arm's.
    """
    if len(control) < 2 or len(arm) < 2:
        return None
    mc, ma = st.mean(control), st.mean(arm)
    vc, va = st.variance(control), st.variance(arm)
    se = math.sqrt(vc / len(control) + va / len(arm))
    if se <= 0:
        return None
    t = (ma - mc) / se
    return Comparison(len(arm), mc, ma, ma - mc, se, t, two_sided_p(t))


def holm(pvalues: dict[str, float]) -> dict[str, float]:
    """Holm-Bonferroni adjusted p-values, one family per report run.

    Step-down and monotone: the adjusted values are forced non-decreasing so a
    later comparison can never be reported as more significant than an earlier,
    smaller raw p. Adjusted p is returned rather than a reject/accept flag
    precisely so no alpha is baked in here — each arm is compared against the
    alpha it was registered with.
    """
    if not pvalues:
        return {}
    ordered = sorted(pvalues.items(), key=lambda kv: kv[1])
    m = len(ordered)
    adjusted: dict[str, float] = {}
    running = 0.0
    for i, (name, p) in enumerate(ordered):
        value = min(1.0, (m - i) * p)
        running = max(running, value)
        adjusted[name] = running
    return adjusted


# ─────────────────────────────────────────────────────────────────────────────
# The record
# ─────────────────────────────────────────────────────────────────────────────

_SETTLED = tuple(sorted(SETTLED_STATUSES))

_ROWS_SQL = """
    SELECT id, mode, status, direction, combo, regime,
           detected_at, settled_at,
           entry_price, reference_entry, initial_invalidation,
           gross_r, realized_r, cost_r, exit_reason,
           strategy_version, variants, arm_flags
      FROM forward_test_setups
     WHERE status = ANY(:settled)
       AND settled_at IS NOT NULL
       AND settled_at >= :since
     ORDER BY settled_at
"""


@dataclass(frozen=True, slots=True)
class Row:
    """One settled setup, with whatever its arms did alongside it."""

    id: str
    mode: str
    status: str
    settled_at: datetime
    entry_price: float | None
    initial_invalidation: float
    gross_r: float
    realized_r: float
    cost_r: float
    exit_reason: str
    strategy_version: str
    variants: dict[str, Any]
    arm_flags: dict[str, Any]

    def arm(self, name: str) -> dict[str, Any] | None:
        """A settled arm's outcome, or `None` if it is absent or still open.

        Absent is common and correct — a plan arm records nothing when it had
        no alternative to offer — and it is not the same as a zero. Anything
        unsettled is excluded rather than marked at its current value, because
        a running position's R is not an outcome.
        """
        blob = self.variants.get(name)
        if not isinstance(blob, dict):
            return None
        if blob.get("status") not in SETTLED_STATUSES:
            return None
        return blob

    def detect_flag(self, name: str) -> bool | None:
        """Whether a detector arm would have taken this setup. `None` for rows
        written before the arm existed — dropped from its comparison, never
        counted as a rejection."""
        flags = self.arm_flags.get("detect")
        if not isinstance(flags, dict) or name not in flags:
            return None
        return bool(flags[name])


async def load_rows(since: datetime) -> list[Row]:
    async with SessionFactory() as db:
        result = await db.execute(
            text(_ROWS_SQL), {"settled": list(_SETTLED), "since": since}
        )
        return [
            Row(
                id=str(r.id),
                mode=r.mode,
                status=r.status,
                settled_at=r.settled_at,
                entry_price=r.entry_price,
                initial_invalidation=r.initial_invalidation,
                gross_r=r.gross_r,
                realized_r=r.realized_r,
                cost_r=r.cost_r,
                exit_reason=r.exit_reason or "",
                strategy_version=r.strategy_version or "",
                variants=r.variants or {},
                arm_flags=r.arm_flags or {},
            )
            for r in result
        ]


# ─────────────────────────────────────────────────────────────────────────────
# Verdicts
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class ArmResult:
    arm: Arm
    gross: Comparison | None
    net: Comparison | None
    week_n: int
    verdict: Verdict = "NO DATA"
    p_holm: float = 1.0
    note: str = ""

    @property
    def n(self) -> int:
        return self.gross.n if self.gross else 0


def _judge(result: ArmResult) -> None:
    """Applies the arm's own pre-registered gate. Nothing here reads the data
    to choose a criterion — the criterion was chosen when the arm was
    registered, which is the entire point of registering it."""
    gate = result.arm.gate
    if result.gross is None:
        result.verdict = "NO DATA"
        result.note = "no settled pairs"
        return
    if result.n < gate.min_settled:
        result.verdict = "INSUFFICIENT"
        short = gate.min_settled - result.n
        result.note = f"{result.n}/{gate.min_settled} settled — {short} short"
        return
    significant = result.p_holm < gate.alpha
    if significant and result.gross.edge <= 0:
        result.verdict = "RETIRE"
        result.note = (
            f"beaten by the control: {result.gross.edge:+.3f}R gross, "
            f"Holm p={result.p_holm:.3f}"
        )
        return
    if significant and result.gross.edge >= gate.min_gross_edge_r:
        result.verdict = "PASS"
        result.note = (
            f"{result.gross.edge:+.3f}R gross vs control, Holm p={result.p_holm:.3f} "
            f"— gate met, promotion is a human decision"
        )
        return
    result.verdict = "FAIL"
    need = result.gross.n_for_significance()
    result.note = (
        f"{result.gross.edge:+.3f}R gross, Holm p={result.p_holm:.3f}"
        + (f" — would need n≈{need} at this effect" if need else " — no effect to grow")
    )


def _settled_arm_result(arm: Arm, rows: list[Row], week_rows: list[Row]) -> ArmResult:
    control_gross: list[float] = []
    control_net: list[float] = []
    arm_gross: list[float] = []
    arm_net: list[float] = []
    for row in rows:
        blob = row.arm(arm.name)
        if blob is None:
            continue
        control_gross.append(row.gross_r)
        control_net.append(row.realized_r)
        arm_gross.append(float(blob.get("gross_r", 0.0)))
        arm_net.append(float(blob.get("realized_r", 0.0)))
    week_n = sum(1 for row in week_rows if row.arm(arm.name) is not None)
    return ArmResult(
        arm=arm,
        gross=paired(control_gross, arm_gross),
        net=paired(control_net, arm_net),
        week_n=week_n,
    )


def _detect_arm_result(arm: Arm, rows: list[Row], week_rows: list[Row]) -> ArmResult:
    taken_gross: list[float] = []
    taken_net: list[float] = []
    rejected_gross: list[float] = []
    rejected_net: list[float] = []
    for row in rows:
        flag = row.detect_flag(arm.name)
        if flag is None:
            continue
        if flag:
            taken_gross.append(row.gross_r)
            taken_net.append(row.realized_r)
        else:
            rejected_gross.append(row.gross_r)
            rejected_net.append(row.realized_r)
    week_n = sum(1 for row in week_rows if row.detect_flag(arm.name))
    result = ArmResult(
        arm=arm,
        gross=unpaired(rejected_gross, taken_gross),
        net=unpaired(rejected_net, taken_net),
        week_n=week_n,
    )
    if result.gross is not None:
        kept = len(taken_gross)
        total = kept + len(rejected_gross)
        result.note = f"keeps {kept}/{total} setups"
    return result


@dataclass
class CostScenario:
    """What the control's record looks like under a different cost assumption.

    Re-derived from stored geometry, never re-run: cost in R is
    `entry * round_trip_pct / 100 / |entry - invalidation|`, and every term is
    already on the row. A scenario, explicitly not an arm — no gate reads it,
    because nothing has shown these fills are actually reachable.
    """

    label: str
    round_trip_pct: float
    n: int
    mean_net: float
    mean_cost: float


def costed_rows(rows: list[Row], strategy_version: str = STRATEGY_VERSION) -> list[Row]:
    """The rows any cost scenario may be computed over.

    One population for every scenario, or the scenarios are not comparable —
    which is the mistake this function exists to make impossible. `cost_r > 0`
    is part of the filter because a filled row with no cost was settled before
    costs were recorded at all; that is a missing measurement, not a free trade,
    and letting it into one scenario but not another moved the live number by
    0.05R once already.

    Restricted to one `strategy_version` for the same reason. The live column
    reads `realized_r` straight off the row, and generation 6 changed how that
    number is computed — pooling it with generation 5's would report a mean
    net R that no single cost model ever produced. Gross R is unaffected by
    that boundary, which is why the arm comparisons above still read every row.
    """
    eligible = []
    for row in rows:
        if strategy_version and row.strategy_version != strategy_version:
            continue
        entry = row.entry_price
        if not entry or entry <= 0 or row.cost_r <= 0:
            continue
        if abs(entry - row.initial_invalidation) <= 0:
            continue
        eligible.append(row)
    return eligible


def cost_scenario(rows: list[Row], label: str, round_trip_pct: float) -> CostScenario | None:
    """Re-derives net R under a different round trip. `rows` must already be
    `costed_rows` — this does not filter, so every caller shares one
    denominator."""
    nets: list[float] = []
    costs: list[float] = []
    for row in rows:
        entry = row.entry_price or 0.0
        risk = abs(entry - row.initial_invalidation)
        cost = (entry * round_trip_pct / 100.0) / risk
        costs.append(cost)
        nets.append(row.gross_r - cost)
    if not nets:
        return None
    return CostScenario(label, round_trip_pct, len(nets), st.mean(nets), st.mean(costs))


def legacy_taker_scenario(rows: list[Row]) -> CostScenario | None:
    """What generation 5 would have charged these rows: both legs as takers.

    Kept after the generation-6 cutover so the transition stays legible. The
    live model now prices each leg for what it does — the entry is a resting
    order in the entry zone that fills when price trades into it and settles
    `NO_FILL` when it never arrives, which is a maker by construction, and a
    target exit is the same on the other side. Charging both legs a taker's fee
    and adverse slippage priced a crossing that half of them never performed.

    This row is the size of that correction, re-derived on the same population
    as every other scenario. It is history, not an alternative: no gate reads
    it, and nothing here is proposing to go back.
    """
    return cost_scenario(
        rows,
        "taker both legs (generation 5 pricing)",
        2.0 * (TAKER_FEE_PCT + TAKER_SLIPPAGE_PCT),
    )


@dataclass
class Report:
    generated_at: datetime
    window_days: int
    week_rows: int
    total_rows: int
    control_week_r: float
    control_total_r: float
    results: list[ArmResult] = field(default_factory=list)
    scenarios: list[CostScenario] = field(default_factory=list)

    @property
    def headline(self) -> str:
        passing = [r for r in self.results if r.verdict == "PASS"]
        retiring = [r for r in self.results if r.verdict == "RETIRE"]
        if passing:
            return f"{len(passing)} arm(s) met their gate — decision needed"
        if retiring:
            return f"{len(retiring)} arm(s) failed against the control"
        return "no arm met its gate — keep running"


async def build_report(window_days: int = 7, history_days: int = 3650) -> Report:
    now = datetime.now(UTC)
    rows = await load_rows(now - timedelta(days=history_days))
    cutoff = now - timedelta(days=window_days)
    week_rows = [r for r in rows if r.settled_at >= cutoff]

    results: list[ArmResult] = []
    for arm in ARMS:
        if not arm.active:
            continue
        if arm.axis == "detect":
            results.append(_detect_arm_result(arm, rows, week_rows))
        else:
            results.append(_settled_arm_result(arm, rows, week_rows))

    # One Holm family per run, across every arm that produced a comparison.
    family = {r.arm.name: r.gross.p for r in results if r.gross is not None}
    adjusted = holm(family)
    for result in results:
        result.p_holm = adjusted.get(result.arm.name, 1.0)
        _judge(result)

    scenarios: list[CostScenario] = []
    costed = costed_rows(rows)
    if costed:
        # The live assumption is read back off the record rather than restated
        # as a constant here: a copy of the profile's fee would drift out of
        # step with it silently, and every scenario would then be measured
        # against a cost nothing actually paid.
        scenarios.append(
            CostScenario(
                "per-leg (live)",
                0.0,
                len(costed),
                st.mean([r.realized_r for r in costed]),
                st.mean([r.cost_r for r in costed]),
            )
        )
        # One row back and one row forward: what the previous generation
        # charged, and the floor no execution can actually reach.
        legacy = legacy_taker_scenario(costed)
        if legacy:
            scenarios.append(legacy)
        maker = cost_scenario(
            costed,
            "maker (both legs — unreachable)",
            2.0 * (MAKER_FEE_PCT + MAKER_SLIPPAGE_PCT),
        )
        if maker:
            scenarios.append(maker)

    return Report(
        generated_at=now,
        window_days=window_days,
        week_rows=len(week_rows),
        total_rows=len(rows),
        control_week_r=st.mean([r.realized_r for r in week_rows]) if week_rows else 0.0,
        control_total_r=st.mean([r.realized_r for r in rows]) if rows else 0.0,
        results=results,
        scenarios=scenarios,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Rendering
# ─────────────────────────────────────────────────────────────────────────────

_VERDICT_MARK = {
    "PASS": "PASS",
    "RETIRE": "RETIRE",
    "FAIL": "no",
    "INSUFFICIENT": "wait",
    "NO DATA": "—",
}


def render_markdown(report: Report) -> str:
    lines = [
        f"# Forward-test arms — week ending {report.generated_at:%Y-%m-%d}",
        "",
        f"*registry {ARMS_VERSION} · report {REPORT_VERSION} · "
        f"{report.window_days}d window*",
        "",
        f"**{report.headline}.**",
        "",
        f"- settled this week: **{report.week_rows}** "
        f"(mean {report.control_week_r:+.3f}R net)",
        f"- settled all-time: **{report.total_rows}** "
        f"(mean {report.control_total_r:+.3f}R net)",
        "",
    ]
    for axis in ("exit", "plan", "detect"):
        arms = [r for r in report.results if r.arm.axis == axis]
        if not arms:
            continue
        lines += [
            f"## Axis: {axis}",
            "",
            "| arm | n | week | gross vs control | net vs control | Holm p | verdict |",
            "|---|---|---|---|---|---|---|",
        ]
        for r in arms:
            g = f"{r.gross.edge:+.3f}R" if r.gross else "—"
            n = f"{r.net.edge:+.3f}R" if r.net else "—"
            p = f"{r.p_holm:.3f}" if r.gross else "—"
            lines.append(
                f"| `{r.arm.name}` | {r.n} | {r.week_n} | {g} | {n} | {p} | "
                f"**{r.verdict}** |"
            )
        lines.append("")
        for r in arms:
            lines += [
                f"**`{r.arm.name}`** — {r.arm.hypothesis}",
                "",
                f"- gate: {r.arm.gate.describe()} (registered {r.arm.registered})",
                f"- {r.note or 'no note'}",
            ]
            if r.gross:
                lo, hi = r.gross.ci95
                lines.append(
                    f"- gross 95% CI [{lo:+.3f}, {hi:+.3f}] · "
                    f"control {r.gross.control_mean:+.3f}R, arm {r.gross.arm_mean:+.3f}R"
                )
            lines.append("")
    if report.scenarios:
        lines += [
            "## Cost scenarios (control only, re-derived — not an arm)",
            "",
            "| assumption | n | mean cost | mean net |",
            "|---|---|---|---|",
        ]
        for s in report.scenarios:
            lines.append(
                f"| {s.label} | {s.n} | {s.mean_cost:.3f}R | {s.mean_net:+.3f}R |"
            )
        lines.append("")
    else:
        lines += [
            "## Cost scenarios (control only, re-derived — not an arm)",
            "",
            f"No settled rows at `{STRATEGY_VERSION}` yet. Scenarios are "
            "restricted to one strategy version because the live column reads "
            "`realized_r` off the row, and generation 6 changed how that number "
            "is computed — an empty section is the correct output here, not a "
            "missing one.",
            "",
        ]
    lines += [
        "---",
        "",
        "No arm here changes the live detector. A PASS is permission to open the "
        "decision, and the decision is an EDR plus a version bump — see "
        "`research/arms-protocol.md`.",
    ]
    return "\n".join(lines)


#: Kept narrow so nothing soft-wraps on a phone. Enforced by test.
_TELEGRAM_WIDTH = 72


def render_telegram(report: Report) -> str:
    """Compact enough to read on a phone. Same verdicts, no tables."""
    lines = [
        f"Forward-test arms — {report.generated_at:%Y-%m-%d}",
        report.headline,
        "",
        f"week: {report.week_rows} settled, {report.control_week_r:+.3f}R avg",
        f"all:  {report.total_rows} settled, {report.control_total_r:+.3f}R avg",
        "",
    ]
    for axis in ("exit", "plan", "detect"):
        arms = [r for r in report.results if r.arm.axis == axis]
        if not arms:
            continue
        lines.append(f"[{axis}]")
        for r in arms:
            edge = f"{r.gross.edge:+.3f}R" if r.gross else "—"
            lines.append(
                f"  {_VERDICT_MARK[r.verdict]:>6}  {r.arm.name}  "
                f"n={r.n} gross {edge}"
            )
            # Wrapped here rather than left to the client: a Telegram line that
            # soft-wraps on a phone loses its indent and stops reading as a
            # sub-point of the arm above it.
            lines += textwrap.wrap(
                r.note, width=_TELEGRAM_WIDTH, initial_indent=" " * 10,
                subsequent_indent=" " * 10,
            )
        lines.append("")
    for s in report.scenarios:
        lines.append(f"cost {s.label}: {s.mean_cost:.3f}R -> net {s.mean_net:+.3f}R")
    lines.append("")
    lines.append("Nothing changed automatically. Full report in research/weekly/.")
    return "\n".join(lines)


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Weekly forward-test arms report")
    parser.add_argument("--window-days", type=int, default=7)
    parser.add_argument("--format", choices=("markdown", "telegram"), default="markdown")
    parser.add_argument("--out", help="write to this path instead of stdout")
    args = parser.parse_args()

    report = await build_report(window_days=args.window_days)
    text_out = (
        render_markdown(report) if args.format == "markdown" else render_telegram(report)
    )
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text_out + "\n")
    else:
        print(text_out)


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
