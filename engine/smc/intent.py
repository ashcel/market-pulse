"""Per-objective trade assessments — the verdict plane's entry point.

The trader's objective decides the answer: the same chart legitimately
produces different verdicts for a scalp, an intraday, a swing, and a trend
position. Each intent pairs a context timeframe (which way is the tide?) with
an execution timeframe (is there a trigger right now?). Ported verbatim from
the TS engine's ``intent.ts``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Literal

from smc.equilibrium import classify_price
from smc.liquidity import LiquidityPool
from smc.location import LocationRead, LocationZones, grade_location
from smc.mock_candles import TokenTimeframe
from smc.objectives import resolve_objectives
from smc.perp import PerpRead
from smc.poi import AnticipatoryPlan, build_anticipatory_plan
from smc.quant import (
    MarketRegime,
    RiskRewardPlan,
    SignalEvaluation,
    TradeDirection,
    directional_lean,
)
from smc.sessions import SessionLevel
from smc.zones import BaseZone

# Fresh supply/demand zones per timeframe, for location grading + confluence.
ZonesByTimeframe = dict[TokenTimeframe, list[BaseZone]]

TradingIntent = Literal["scalp", "intraday", "swing", "position"]

# How the assistant answers "should I take this kind of trade?"
# - favored: context and execution agree and the setup is confirmed
# - caution: tradable, but against the higher-timeframe trend — reduced size
# - wait: right idea, but confirmation is still missing — not yet
# - avoid: wrong direction or the market doesn't suit this objective
IntentVerdict = Literal["favored", "caution", "wait", "avoid"]


@dataclass(slots=True)
class IntentDefinition:
    intent: TradingIntent
    label: str
    horizon: str
    context_timeframe: TokenTimeframe
    execution_timeframe: TokenTimeframe
    description: str


INTENTS: tuple[IntentDefinition, ...] = (
    IntentDefinition(
        intent="scalp",
        label="Scalp",
        horizon="minutes–hours",  # noqa: RUF001 — en dash matches the TS copy
        context_timeframe="1H",
        execution_timeframe="15M",
        description="Quick in-and-out trades riding short bursts of momentum.",
    ),
    IntentDefinition(
        intent="intraday",
        label="Intraday",
        horizon="hours",
        context_timeframe="4H",
        execution_timeframe="1H",
        description="Positions opened and closed within the same day.",
    ),
    IntentDefinition(
        intent="swing",
        label="Swing",
        horizon="days",
        context_timeframe="1D",
        execution_timeframe="4H",
        description="Multi-day positions around the dominant daily structure.",
    ),
    IntentDefinition(
        intent="position",
        label="Trend",
        horizon="weeks",
        context_timeframe="1W",
        execution_timeframe="1D",
        description="Trend-following positions held for weeks.",
    ),
)


@dataclass(slots=True)
class IntentChecklistItem:
    label: str
    detail: str
    done: bool


@dataclass(slots=True)
class IntentAssessment:
    intent: TradingIntent
    definition: IntentDefinition
    verdict: IntentVerdict
    # Recommended direction for this objective; "none" when standing aside.
    direction: TradeDirection
    is_counter_trend: bool
    # 1 = full size, 0.5 = reduced (counter-trend). Applied to the plan.
    size_multiplier: float
    headline: str
    summary: str
    checklist: list[IntentChecklistItem]
    # Price events that would upgrade, downgrade, or flip this verdict.
    triggers: list[str]
    # Engine confidence on the execution timeframe.
    confidence: float
    context_bias: TradeDirection
    execution_bias: TradeDirection
    context: SignalEvaluation
    execution: SignalEvaluation
    # Execution-timeframe plan (size-adjusted), or None when nothing to execute.
    plan: RiskRewardPlan | None
    # The anticipatory limit-at-POI read for this assessment's direction (EDR
    # 0009): passive context next to `plan`, read by no verdict. Per-unit
    # geometry only, so there is no position sizing to scale.
    anticipatory_plan: AnticipatoryPlan | None
    # Where price sits vs. structure for this direction; None when unavailable
    # or standing aside.
    location: LocationRead | None


def _human(value: str) -> str:
    return value.replace("-", " ")


def _regime_bias(regime: MarketRegime) -> TradeDirection:
    if regime == "trending-up":
        return "long"
    if regime == "trending-down":
        return "short"
    return "none"


def timeframe_bias(evaluation: SignalEvaluation) -> TradeDirection:
    """Directional lean of one timeframe — delegates to the engine's single
    reconciliation (``directional_lean``). Computed from parts (rather than
    reading ``evaluation.lean``) so it also works on partially stubbed
    evaluations."""
    return directional_lean(evaluation.direction, evaluation.regime, evaluation.structure)


def _fmt_price(value: float | None) -> str:
    if value is None or not math.isfinite(value):
        return "n/a"
    abs_ = abs(value)
    if abs_ >= 1000:
        text = f"{value:,.2f}".rstrip("0").rstrip(".")
        return f"${text}"
    if abs_ >= 1:
        text = f"{value:,.4f}".rstrip("0").rstrip(".")
        return f"${text}"
    return f"${value:.5g}"


def _js_round(value: float) -> float:
    """JS Math.round — half toward +infinity."""
    return math.floor(value + 0.5)


def scale_plan(plan: RiskRewardPlan, multiplier: float) -> RiskRewardPlan:
    if multiplier == 1:
        return plan

    def money(v: float) -> float:
        return _js_round(v * multiplier * 100) / 100

    return replace(
        plan,
        position_size=_js_round(plan.position_size * multiplier * 1e6) / 1e6,
        max_dollar_risk=money(plan.max_dollar_risk),
        max_dollar_loss=money(plan.max_dollar_loss),
        estimated_gain1=money(plan.estimated_gain1),
        estimated_gain2=money(plan.estimated_gain2),
    )


def _location_clause(location: LocationRead) -> str:
    """Short clause describing entry location, for the favored-verdict summary."""
    if location.confluence == "multi-timeframe":
        return (
            "price is sitting on a multi-timeframe supply/demand confluence — "
            "the highest-quality entry structure"
        )
    if location.confluence == "single-timeframe":
        return "price is sitting on a fresh supply/demand zone for a tight-stop entry"
    if location.grade == "at-structure":
        return "price is well located against structure for a tight-stop entry"
    return "price is mid-range but still a workable entry"


def _build_checklist(
    definition: IntentDefinition,
    direction: TradeDirection,
    ctx: SignalEvaluation,
    exe: SignalEvaluation,
    location: LocationRead | None,
) -> list[IntentChecklistItem]:
    ctx_bias = timeframe_bias(ctx)
    if ctx_bias == "none":
        ctx_detail = (
            f"The {definition.context_timeframe} chart shows no clear trend "
            f"({_human(ctx.regime)})."
        )
    else:
        ctx_detail = (
            f"The {definition.context_timeframe} chart leans {ctx_bias} ({_human(ctx.regime)})."
        )
    items: list[IntentChecklistItem] = [
        IntentChecklistItem(
            label=f"{definition.context_timeframe} trend agrees",
            done=direction != "none" and ctx_bias == direction,
            detail=ctx_detail,
        )
    ]
    for component in exe.components:
        if component.status == "neutral":
            continue
        items.append(
            IntentChecklistItem(
                label=component.name,
                done=component.status == "pass",
                detail=component.explanation,
            )
        )
    if location is not None:
        items.append(
            IntentChecklistItem(
                label="Price at a good entry location",
                done=location.grade != "extended",
                detail=location.note,
            )
        )
    return items


def _build_triggers(
    definition: IntentDefinition,
    direction: TradeDirection,
    is_counter_trend: bool,
    ctx: SignalEvaluation,
    exe: SignalEvaluation,
    location: LocationRead | None,
    anticipatory_plan: AnticipatoryPlan | None,
) -> list[str]:
    triggers: list[str] = []
    a = exe.analytics
    exe_tf = definition.execution_timeframe
    ctx_tf = definition.context_timeframe

    if direction == "long":
        if a.resistance is not None:
            triggers.append(
                f"A {exe_tf} close above {_fmt_price(a.resistance)} strengthens the long case."
            )
        inv = a.support if a.support is not None else exe.risk.invalidation
        triggers.append(f"A {exe_tf} close below {_fmt_price(inv)} invalidates the long idea.")
    elif direction == "short":
        if a.support is not None:
            triggers.append(
                f"A {exe_tf} close below {_fmt_price(a.support)} strengthens the short case."
            )
        inv = a.resistance if a.resistance is not None else exe.risk.invalidation
        triggers.append(f"A {exe_tf} close above {_fmt_price(inv)} invalidates the short idea.")
    else:
        triggers.append(
            f"A decisive {exe_tf} close above {_fmt_price(a.resistance)} would create a long "
            f"bias; below {_fmt_price(a.support)}, a short bias."
        )

    if is_counter_trend:
        level = ctx.analytics.resistance if direction == "long" else ctx.analytics.support
        verb = "reclaims" if direction == "long" else "loses"
        triggers.append(
            f"If {ctx_tf} {verb} {_fmt_price(level)}, this stops being counter-trend and can "
            "be traded at full size."
        )
    elif direction != "none":
        level = ctx.analytics.support if direction == "long" else ctx.analytics.resistance
        verb = "breaks below" if direction == "long" else "breaks above"
        triggers.append(f"Today's answer flips if {ctx_tf} {verb} {_fmt_price(level)}.")

    # When price is extended, the pullback is the event to watch — surface it
    # first, quoting the same POI numbers as the verdict summary (not a
    # separately-derived pullback level) so the two can't disagree.
    if location is not None and location.grade == "extended":
        if anticipatory_plan is not None:
            stop_word = "below" if direction == "long" else "above"
            triggers.insert(
                0,
                f"A move to {_fmt_price(anticipatory_plan.entry)} (the "
                f"{anticipatory_plan.zone.kind} zone) sets up a cleaner {direction} entry — "
                f"stop {stop_word} {_fmt_price(anticipatory_plan.stop)}, targeting "
                f"{_fmt_price(anticipatory_plan.objective.price)} — and can upgrade this to "
                "favored.",
            )
        else:
            triggers.insert(
                0,
                f"A pullback toward {_fmt_price(location.pullback_target)} would set up a "
                f"cleaner {direction} entry and can upgrade this to favored.",
            )

    return triggers[:3]


def assess_intent(
    definition: IntentDefinition,
    evals: dict[TokenTimeframe, SignalEvaluation],
    zones_by_timeframe: ZonesByTimeframe | None = None,
    perp: PerpRead | None = None,
    session_levels: list[SessionLevel] | None = None,
) -> IntentAssessment | None:
    ctx = evals.get(definition.context_timeframe)
    exe = evals.get(definition.execution_timeframe)
    if ctx is None or exe is None:
        return None

    ctx_bias = timeframe_bias(ctx)
    exe_bias = timeframe_bias(exe)
    # Swing/position trades live or die by the higher-timeframe trend; scalps
    # and intraday trades are driven by the execution timeframe.
    trend_horizon = definition.intent in ("swing", "position")
    direction: TradeDirection = (
        ctx_bias if trend_horizon else exe_bias if exe_bias != "none" else ctx_bias
    )
    is_counter_trend = direction != "none" and ctx_bias != "none" and direction != ctx_bias
    confirmed = (exe.decision == "buy-candidate" and direction == "long") or (
        exe.decision == "short-candidate" and direction == "short"
    )

    label = definition.label.lower()
    exe_tf = definition.execution_timeframe
    ctx_tf = definition.context_timeframe
    dir_word = "Long" if direction == "long" else "Short"

    # Where price sits vs. structure for this direction — gates the favored
    # verdict, sharpened by fresh supply/demand zones and their cross-timeframe
    # confluence when available.
    location = grade_location(
        exe,
        direction,
        LocationZones(
            execution=zones_by_timeframe.get(definition.execution_timeframe, []),
            context=zones_by_timeframe.get(definition.context_timeframe, []),
        )
        if zones_by_timeframe is not None
        else None,
        session_levels,
    )

    verdict: IntentVerdict
    # Set only by the "confirmed && extended" branch below — distinguishes a
    # wait caused specifically by bad entry location (fixable by a pullback)
    # from the other "wait" reasons, where a stale price-derived plan would be
    # equally misleading.
    pullback_wait = False

    if direction == "none":
        verdict = "avoid"
        headline = f"No {label} edge either way"
        if trend_horizon:
            summary = (
                f"The {ctx_tf} chart has no established trend to lean on "
                f"({_human(ctx.regime)}), and {label} trades need one. Check back when a "
                "direction asserts itself."
            )
        else:
            summary = (
                f"Neither {exe_tf} nor {ctx_tf} shows a directional edge "
                f"({_human(exe.regime)}). Forcing a {label} here is a coin flip."
            )
    elif not trend_horizon and exe.regime == "low-volatility" and not confirmed:
        verdict = "avoid"
        headline = f"Too quiet for {label}s"
        summary = (
            f"{exe_tf} volatility is compressed — the moves on offer are too small to pay "
            f"for a {label}. Wait for range expansion before working this style."
        )
    elif trend_horizon and exe_bias != "none" and exe_bias != direction:
        verdict = "wait"
        headline = f"{dir_word} {label} — not yet"
        summary = (
            f"The {ctx_tf} trend still points {direction}, but {exe_tf} is currently moving "
            "against it. That's an entry-timing problem, not a broken thesis — let "
            f"{exe_tf} turn back {direction} before committing."
        )
    elif is_counter_trend:
        if confirmed:
            verdict = "caution"
            headline = f"Counter-trend {dir_word.lower()} {label} — half size"
            trend_word = "downtrend" if ctx_bias == "short" else "uptrend"
            summary = (
                f"The {exe_tf} setup is valid ({_human(exe.setup_type)}), but it trades "
                f"against the {ctx_tf} {trend_word}. Acceptable as a quick {label} at "
                "reduced size with a fast exit — not a trade to marry."
            )
        elif exe.confidence >= 45:
            verdict = "wait"
            headline = f"Counter-trend {dir_word.lower()} — needs confirmation"
            summary = (
                f"A {direction} {label} against the {ctx_tf} trend is only worth taking "
                "fully confirmed. Wait for the unchecked items below before committing "
                "even reduced size."
            )
        else:
            verdict = "avoid"
            headline = f"Skip the {dir_word.lower()} {label}"
            summary = (
                f"This would be a weak, unconfirmed trade against the {ctx_tf} trend — the "
                f"kind that bleeds accounts. Either trade {ctx_bias} with the trend or "
                "stand aside."
            )
    elif confirmed and location is not None and location.grade == "extended":
        # Right direction, confirmed trigger — but price has run away from the
        # structure you'd enter against. Entering here is a structure trap: a
        # "no trade at current price", not a "favored" — and not a plan to
        # execute either (the numeric plan below is nulled).
        verdict = "wait"
        pullback_wait = True
        headline = f"No {direction} at current price"
        summary = (
            f"No {direction} at current price — {ctx_tf} trend and {exe_tf} trigger agree "
            f"on a {direction} {label}, but {location.note}"
        )
    elif confirmed:
        verdict = "favored"
        headline = f"{dir_word} {label} favored"
        clause = _location_clause(location) if location is not None else "the plan below is ready"
        summary = (
            f"{ctx_tf} trend and {exe_tf} trigger agree, the {exe_tf} setup is confirmed "
            f"({_human(exe.setup_type)}), and {clause}. Conditions currently pay this "
            "objective — execute the plan below."
        )
    else:
        verdict = "wait"
        headline = f"{dir_word} {label} — wait for the trigger"
        summary = (
            f"Direction is right, but the {exe_tf} trigger isn't confirmed yet. \"Not yet\" "
            "— the unchecked confirmations below are exactly what's missing."
        )

    # Higher-timeframe liquidity overlay: the context timeframe's intact pools
    # mark where resting stops cluster. Entering right below one (long) or
    # right above one (short) is entering where raids reject, so a favored
    # call trims to caution until the level resolves. A pool merely on the
    # path to target is noted, never a downgrade.
    htf_pool_trim = False
    entry_price = exe.analytics.last_close
    if direction == "none" or not entry_price:
        opposing_pools: list[LiquidityPool] = []
    else:
        opposing_pools = [
            pool
            for pool in ctx.liquidity
            if pool.intact
            and (
                pool.side == "bsl" and pool.price > entry_price
                if direction == "long"
                else pool.side == "ssl" and pool.price < entry_price
            )
        ]
    htf_pool: LiquidityPool | None = None
    for pool in opposing_pools:
        if htf_pool is None or abs(pool.price - entry_price) < abs(htf_pool.price - entry_price):
            htf_pool = pool
    ctx_atr = ctx.analytics.atr_percent if ctx.analytics.atr_percent is not None else 1
    htf_pool_proximate = (
        htf_pool is not None
        and (abs(htf_pool.price - entry_price) / entry_price) * 100 < max(0.35, ctx_atr * 0.55)
    )
    if htf_pool is not None:
        side_word = "buy-side" if htf_pool.side == "bsl" else "sell-side"
        if htf_pool_proximate:
            if verdict == "favored":
                verdict = "caution"
                htf_pool_trim = True
                headline = f"{dir_word} {label} — into {ctx_tf} liquidity, trim size"
            above_below = "above" if direction == "long" else "below"
            summary = (
                f"{summary} Note: an intact {ctx_tf} {side_word} liquidity pool sits at "
                f"{_fmt_price(htf_pool.price)}, right {above_below} the entry — stop raids "
                "reject from these levels, so let it resolve before pressing."
            )
        elif exe.risk.direction == direction and (
            htf_pool.price <= exe.risk.target1
            if direction == "long"
            else htf_pool.price >= exe.risk.target1
        ):
            summary = (
                f"{summary} The first {ctx_tf} liquidity magnet on the path is "
                f"{_fmt_price(htf_pool.price)} — expect a reaction there."
            )

    # Perp positioning overlay: funding says which side is crowded, and
    # joining the crowd means buying into squeeze risk. Extreme funding with
    # the crowd downgrades a favored call to a trimmed caution; an offside
    # crowd is a tailwind note, never an upgrade.
    crowded_trim = False
    if perp is not None and direction != "none" and perp.funding_bias != "neutral":
        crowded_with_you = (direction == "long" and perp.funding_bias == "longs-crowded") or (
            direction == "short" and perp.funding_bias == "shorts-crowded"
        )
        sign = "+" if perp.funding_annualized_pct > 0 else ""
        apr = f"{sign}{perp.funding_annualized_pct:.0f}% APR"
        if crowded_with_you and perp.funding_extreme and verdict == "favored":
            verdict = "caution"
            crowded_trim = True
            headline = f"{dir_word} {label} — crowded, trim size"
            summary = (
                f"{summary} But funding is extreme with the crowd already {direction} "
                f"({apr}): you'd be joining a crowded {direction} into squeeze risk, so "
                "take it smaller with a tighter leash."
            )
        elif crowded_with_you:
            summary = (
                f"{summary} Heads-up: funding leans {direction} ({apr}), so positioning is "
                "a little crowded on your side — don't chase."
            )
        else:
            summary = (
                f"{summary} Tailwind: the crowd is offside ({apr}), and a squeeze would "
                "run in your favor."
            )

    size_multiplier = 0.5 if (is_counter_trend or crowded_trim or htf_pool_trim) else 1
    # A numeric entry/stop/target plan is only shown for verdicts actionable at
    # the current price: only "favored"/"caution" populate `plan`; a "wait"
    # caused by extended location instead gets a conditional plan below.
    plan = (
        scale_plan(exe.risk, size_multiplier)
        if verdict in ("favored", "caution")
        and direction != "none"
        and exe.risk.direction == direction
        else None
    )

    checklist = _build_checklist(definition, direction, ctx, exe, location)
    if htf_pool is not None:
        side_word = "buy-side" if htf_pool.side == "bsl" else "sell-side"
        checklist.append(
            IntentChecklistItem(
                label=f"No {ctx_tf} liquidity pool at the entry",
                done=not htf_pool_proximate,
                detail=(
                    f"An intact {ctx_tf} {side_word} pool at {_fmt_price(htf_pool.price)} "
                    "sits within reach of the entry — the level stop raids reject from."
                    if htf_pool_proximate
                    else f"The nearest intact {ctx_tf} {side_word} pool "
                    f"({_fmt_price(htf_pool.price)}) leaves the entry room to work."
                ),
            )
        )
    if perp is not None and direction != "none" and perp.funding_bias != "neutral":
        crowded_with_you = (direction == "long" and perp.funding_bias == "longs-crowded") or (
            direction == "short" and perp.funding_bias == "shorts-crowded"
        )
        checklist.append(
            IntentChecklistItem(
                label="Funding not crowded against the trade",
                done=not crowded_with_you,
                detail=perp.note,
            )
        )

    # Phase 1 overlay (inert): the draw-on-liquidity objective and the
    # limit-at-POI plan for this assessment's direction — shown where the
    # verdict is explained, read by no verdict (EDR 0008/0009).
    anticipatory_plan: AnticipatoryPlan | None = None
    if direction in ("long", "short") and entry_price:
        objectives = (
            exe.objectives
            if exe.objectives and exe.objectives[0].direction == direction
            else resolve_objectives(exe.structure, exe.liquidity, direction, entry_price)
        )
        anticipatory_plan = (
            exe.anticipatory_plan
            if exe.anticipatory_plan is not None and exe.anticipatory_plan.direction == direction
            else build_anticipatory_plan(
                zones_by_timeframe.get(definition.execution_timeframe, [])
                if zones_by_timeframe is not None
                else [],
                direction,
                entry_price,
                exe.dealing_range,
                objectives,
            )
        )

        # Echo the objective's own POI plan in the verdict text instead of a
        # separately-derived pullback level: one number source for "where
        # would this become a trade" so the views can't disagree.
        if pullback_wait and anticipatory_plan is not None:
            move_word = "pulls back" if direction == "long" else "rallies"
            stop_word = "below" if direction == "long" else "above"
            summary = (
                f"{summary} If price {move_word} to the {anticipatory_plan.zone.kind} zone "
                f"{_fmt_price(anticipatory_plan.zone.price_low)}–"  # noqa: RUF001
                f"{_fmt_price(anticipatory_plan.zone.price_high)}, a {direction} becomes "
                f"viable with stop {stop_word} {_fmt_price(anticipatory_plan.stop)}, "
                f"targeting {_fmt_price(anticipatory_plan.objective.price)}."
            )

        # G10 displayed, not enforced: a trade with no clean draw has no
        # target worth the name — surfaced so the record can accumulate
        # before any veto.
        preferred = objectives[0] if objectives else None
        draw_word = "high" if direction == "long" else "low"
        if preferred is not None:
            depth = ""
            if len(objectives) > 1:
                plural = "s" if len(objectives) > 2 else ""
                depth = f", with {len(objectives) - 1} further draw{plural} behind it"
            pooled = " with pooled stops" if preferred.pool is not None else ""
            objective_detail = (
                f"The nearest draw is {_fmt_price(preferred.price)} — a "
                f"{preferred.strength} {draw_word}{pooled}{depth}."
            )
        else:
            above_below = "above" if direction == "long" else "below"
            objective_detail = (
                f"No untaken weak {draw_word} {above_below} for price to be drawn toward — "
                f"no clean target for this {label}."
            )
        checklist.append(
            IntentChecklistItem(
                label="Clean liquidity objective exists",
                done=preferred is not None,
                detail=objective_detail,
            )
        )

        # Dreimann gates the POI against the CONTEXT range ("long only in
        # discount" of the tide's range); entry_position on the plan itself is
        # the execution-timeframe read.
        wanted_side = "discount" if direction == "long" else "premium"
        ctx_position = (
            classify_price(ctx.dealing_range, anticipatory_plan.entry)
            if anticipatory_plan is not None and ctx.dealing_range is not None
            else None
        )
        if anticipatory_plan is None:
            zone_word = "demand" if direction == "long" else "supply"
            poi_detail = (
                f"No {zone_word} zone currently offers a resting limit with a clean objective."
            )
        elif ctx.dealing_range is None:
            poi_detail = (
                f"A limit could rest at {_fmt_price(anticipatory_plan.entry)} "
                f"({anticipatory_plan.zone.freshness} {anticipatory_plan.zone.kind}), but "
                f"{ctx_tf} has no dealing range yet to judge {wanted_side} against."
            )
        elif ctx_position == wanted_side:
            poi_detail = (
                f"A limit at {_fmt_price(anticipatory_plan.entry)} "
                f"({anticipatory_plan.zone.freshness} {anticipatory_plan.zone.kind}) rests "
                f"in {ctx_tf} {wanted_side}: stop {_fmt_price(anticipatory_plan.stop)}, "
                f"objective {_fmt_price(anticipatory_plan.objective.price)}, "
                f"~{anticipatory_plan.reward_risk:.1f}R from the limit."
            )
        else:
            position_word = ctx_position if ctx_position is not None else "an unknown position"
            poi_detail = (
                f"The best POI limit ({_fmt_price(anticipatory_plan.entry)}) sits in "
                f"{ctx_tf} {position_word} — not the {wanted_side}-side entry this "
                "framework takes."
            )
        checklist.append(
            IntentChecklistItem(
                label=f"Limit entry at a POI in {ctx_tf} {wanted_side}",
                done=ctx_position == wanted_side,
                detail=poi_detail,
            )
        )

    return IntentAssessment(
        intent=definition.intent,
        definition=definition,
        verdict=verdict,
        direction=direction,
        is_counter_trend=is_counter_trend,
        size_multiplier=size_multiplier,
        headline=headline,
        summary=summary,
        checklist=checklist,
        triggers=_build_triggers(
            definition, direction, is_counter_trend, ctx, exe, location, anticipatory_plan
        ),
        confidence=exe.confidence,
        context_bias=ctx_bias,
        execution_bias=exe_bias,
        context=ctx,
        execution=exe,
        plan=plan,
        anticipatory_plan=anticipatory_plan,
        location=location,
    )


def assess_intents(
    evals: dict[TokenTimeframe, SignalEvaluation],
    zones_by_timeframe: ZonesByTimeframe | None = None,
    perp: PerpRead | None = None,
    session_levels: list[SessionLevel] | None = None,
) -> list[IntentAssessment]:
    assessments = [
        assess_intent(definition, evals, zones_by_timeframe, perp, session_levels)
        for definition in INTENTS
    ]
    return [a for a in assessments if a is not None]
