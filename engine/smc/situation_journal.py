"""SITUATION JOURNAL — every surfaced situation, timestamped and settled.

The scanner's thresholds are guesses until something measures them. This module
is what makes measuring possible later: it records each situation's life —
what fired, in what context, where the structural path was, and what price
actually did afterwards — so the question

    "does this process identify the end of a pullback early enough to catch the
     next structural leg with asymmetric risk/reward?"

can eventually be answered with data rather than opinion.

## What it is not

Not a trade log, not a position, not a recommendation. `entry` /
`invalidation` / `target` are the *structural path that was on the table*, not
orders — nothing here was ever sent anywhere.

Not a persistence layer either. The radar plane keeps Postgres out of the hot
path, so this is a bounded in-memory ring: a restart loses it, which is the
right trade for a plane whose whole state re-warms in minutes. Exporting to the
record plane is a later, deliberate step — the shapes here are already flat
enough for it.

## Determinism

`observe()` takes an explicit `now` and derives everything from the situation
handed to it. No clock reads, no I/O, no randomness: replaying the same tick
sequence produces the same journal, byte for byte.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Literal

from smc.scan_profiles import Mode
from smc.situation import Situation

JOURNAL_VERSION = "1.0.0"

Outcome = Literal["OPEN", "TARGET", "INVALIDATED", "STALE"]

#: Ring capacity. Bounded so a busy tape cannot grow the process without limit.
MAX_ENTRIES = 500

_EPS = 1e-9


@dataclass(frozen=True, slots=True)
class JournalEntry:
    """One situation's life, flat and self-describing.

    Deliberately denormalized: a row should be readable — and analysable —
    without joining it back to live scanner state that no longer exists.
    """

    key: str
    symbol: str
    mode: Mode
    direction: str
    opened_at: float

    # What fired, and what the market looked like when it did.
    trigger_type: str
    trigger_ts: float
    context_bias: str
    context_agreement: float
    alignment: str
    alignment_level: str
    structure_trend: str

    # The developing phase.
    pullback_started_at: float | None = None
    retrace_frac_at_completion: float | None = None
    completion_at: float | None = None
    completion_evidence: tuple[str, ...] = ()

    # The structural path that was on the table (never an order).
    entry: float | None = None
    invalidation: float | None = None
    target: float | None = None
    target_kind: str = ""
    rr: float | None = None

    # What price did afterwards, in percent from `entry`, signed so that
    # positive is always "in the direction of the thesis".
    mfe_pct: float = 0.0
    mae_pct: float = 0.0
    reached_completion: bool = False
    reached_continuation: bool = False
    outcome: Outcome = "OPEN"
    closed_at: float | None = None
    last_price: float = 0.0
    updated_at: float = 0.0

    @property
    def is_open(self) -> bool:
        return self.outcome == "OPEN"


def _signed_move_pct(direction: str, entry: float, price: float) -> float:
    """Move from `entry` to `price`, positive when it favours the thesis."""
    if entry <= _EPS:
        return 0.0
    raw = (price - entry) / entry * 100.0
    return raw if direction == "bullish" else -raw


@dataclass
class SituationJournal:
    """Bounded, append-only-ish record of situations, keyed by (mode, symbol).

    Mutable by necessity (it accumulates), but every mutation is a pure
    function of the arguments — see the module docstring on determinism.
    """

    entries: dict[str, JournalEntry] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    max_entries: int = MAX_ENTRIES

    def key_for(self, situation: Situation) -> str:
        """Identity of one situation's life. A symbol that goes INVALID and
        later fires again is a *new* entry, so `first_seen` is part of the
        key — otherwise two unrelated setups would average together."""
        return f"{situation.mode}:{situation.symbol}:{int(situation.first_seen)}"

    def observe(self, situation: Situation, price: float, now: float) -> JournalEntry | None:
        """Records or updates one situation. Returns the entry, or `None` when
        the situation is not yet worth recording (nothing has developed).

        Only situations that reached at least PULLBACK are journaled: NEW and
        DEVELOPING cards churn by design, and recording them would bury the
        thing the journal exists to measure.
        """
        if situation.direction is None:
            return None
        recordable = situation.state in (
            "PULLBACK",
            "PULLBACK_COMPLETION",
            "CONTINUATION_CANDIDATE",
        )
        key = self.key_for(situation)
        existing = self.entries.get(key)
        if existing is None and not recordable:
            return None

        entry = existing if existing is not None else self._open(situation, key, price, now)
        entry = self._apply(entry, situation, price, now)
        self.entries[key] = entry
        if existing is None:
            self.order.append(key)
            self._trim()
        return entry

    def _open(self, situation: Situation, key: str, price: float, now: float) -> JournalEntry:
        context = situation.context
        headline = situation.headline
        return JournalEntry(
            key=key,
            symbol=situation.symbol,
            mode=situation.mode,
            direction=situation.direction or "bullish",
            opened_at=now,
            trigger_type=headline.type if headline is not None else "",
            trigger_ts=headline.ts if headline is not None else now,
            context_bias=context.bias if context is not None else "unknown",
            context_agreement=context.agreement if context is not None else 0.0,
            alignment=situation.alignment.classification,
            alignment_level=situation.alignment.level,
            structure_trend=(
                context.reads[0].trend if context is not None and context.reads else "range"
            ),
            pullback_started_at=situation.pullback_started_at,
            last_price=price,
            updated_at=now,
        )

    def _apply(
        self, entry: JournalEntry, situation: Situation, price: float, now: float
    ) -> JournalEntry:
        if not entry.is_open:
            return entry

        path = situation.path
        updates: dict[str, object] = {"last_price": price, "updated_at": now}

        # The path is pinned the first time the situation has one: what mattered
        # is the geometry at the moment it became watchable, not the geometry
        # after price has already moved.
        if entry.entry is None and path is not None:
            updates |= {
                "entry": path.entry,
                "invalidation": path.invalidation,
                "target": path.target,
                "target_kind": path.target_kind,
                "rr": path.rr,
            }

        if situation.state == "PULLBACK_COMPLETION" and not entry.reached_completion:
            updates |= {
                "reached_completion": True,
                "completion_at": now,
                "retrace_frac_at_completion": (
                    situation.pullback.retrace_frac if situation.pullback is not None else None
                ),
                "completion_evidence": tuple(
                    item.code for item in situation.completion.met
                )
                if situation.completion is not None
                else (),
            }
        if situation.state == "CONTINUATION_CANDIDATE":
            updates["reached_continuation"] = True

        reference = entry.entry if entry.entry is not None else updates.get("entry")
        if isinstance(reference, float) and reference > _EPS:
            move = _signed_move_pct(entry.direction, reference, price)
            updates["mfe_pct"] = round(max(entry.mfe_pct, move), 3)
            updates["mae_pct"] = round(min(entry.mae_pct, move), 3)

        outcome = self._settle(entry, situation, price, updates)
        if outcome is not None:
            updates |= {"outcome": outcome, "closed_at": now}
        return replace(entry, **updates)  # type: ignore[arg-type]

    def _settle(
        self,
        entry: JournalEntry,
        situation: Situation,
        price: float,
        updates: dict[str, object],
    ) -> Outcome | None:
        """Target and invalidation are settled on price, not on the scanner's
        opinion: the scanner's state is what is being measured, so it cannot
        also be the referee."""
        target = entry.target if entry.target is not None else updates.get("target")
        invalidation = (
            entry.invalidation if entry.invalidation is not None else updates.get("invalidation")
        )
        if isinstance(target, float) and isinstance(invalidation, float):
            if entry.direction == "bullish":
                if price >= target:
                    return "TARGET"
                if price <= invalidation:
                    return "INVALIDATED"
            else:
                if price <= target:
                    return "TARGET"
                if price >= invalidation:
                    return "INVALIDATED"
        if situation.state == "INVALID":
            return "INVALIDATED"
        if situation.state == "STALE":
            return "STALE"
        return None

    def _trim(self) -> None:
        while len(self.order) > self.max_entries:
            oldest = self.order.pop(0)
            self.entries.pop(oldest, None)

    # ── reads ───────────────────────────────────────────────────────────────

    def recent(self, limit: int = 50, mode: str | None = None) -> list[JournalEntry]:
        rows = [self.entries[key] for key in reversed(self.order) if key in self.entries]
        if mode is not None:
            rows = [row for row in rows if row.mode == mode]
        return rows[:limit]

    def stats(self, mode: str | None = None) -> dict[str, float]:
        """Coarse counts, enough to see whether the process is producing
        anything worth analysing yet. Not a performance claim — settled
        outcomes here are structural, not traded."""
        rows = [row for row in self.entries.values() if mode is None or row.mode == mode]
        closed = [row for row in rows if not row.is_open]
        targets = sum(1 for row in closed if row.outcome == "TARGET")
        invalidated = sum(1 for row in closed if row.outcome == "INVALIDATED")
        completions = sum(1 for row in rows if row.reached_completion)
        continuations = sum(1 for row in rows if row.reached_continuation)
        return {
            "recorded": float(len(rows)),
            "open": float(len(rows) - len(closed)),
            "reached_completion": float(completions),
            "reached_continuation": float(continuations),
            "target": float(targets),
            "invalidated": float(invalidated),
            "avg_rr": round(
                sum(row.rr for row in rows if row.rr is not None)
                / max(1, sum(1 for row in rows if row.rr is not None)),
                2,
            ),
        }
