"""Test-only loader for the frozen Dreimann ground-truth fixtures.

Port of __fixtures__/dreimann/index.ts. Reads the committed JSON (copied
verbatim from the TS repo) from disk — never imported by engine code.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from smc.types import Candle

DREIMANN_TRADES = ("zec-tp", "trx-tp3", "zec-sl", "ethfi-sl", "jup-tp", "fet-tp")

DreimannTradeName = Literal["zec-tp", "trx-tp3", "zec-sl", "ethfi-sl", "jup-tp", "fet-tp"]

_FIXTURE_DIR = Path(__file__).parent


@dataclass(slots=True)
class DreimannEntryLabel:
    type: Literal["market", "limit"]
    price: float
    # Pinned to the first fixture bar consistent with the chart — ±a few bars.
    approx_time_utc: str
    source: str


@dataclass(slots=True)
class DreimannObjectiveLabel:
    price: float
    # "weak-high" objectives are assertable from the window; "beyond-window" are not.
    kind: Literal["weak-high", "beyond-window"]
    within_window: bool
    tolerance_pct: float
    # True only where the source material explicitly calls the objective weak structure.
    claims_weak_structure: bool
    source: str


@dataclass(slots=True)
class DreimannLabels:
    chart: str
    tradingview: str
    symbol: str
    execution_timeframe: Literal["15m", "1h", "4h"]
    context_timeframe: Literal["4h"]
    direction: Literal["long", "short"]
    playbook: list[str]
    outcome: Literal["tp", "tp-partial", "sl"]
    entry: DreimannEntryLabel
    stop_price: float
    stop_source: str
    objective: DreimannObjectiveLabel
    notes: str


@dataclass(slots=True)
class DreimannFixture:
    meta: dict[str, Any]
    series: dict[str, list[Candle]]
    labels: DreimannLabels


def _read_json(name: str) -> Any:
    with (_FIXTURE_DIR / name).open() as f:
        return json.load(f)


def _parse_labels(raw: dict[str, Any]) -> DreimannLabels:
    entry = raw["entry"]
    objective = raw["objective"]
    return DreimannLabels(
        chart=raw["chart"],
        tradingview=raw["tradingview"],
        symbol=raw["symbol"],
        execution_timeframe=raw["executionTimeframe"],
        context_timeframe=raw["contextTimeframe"],
        direction=raw["direction"],
        playbook=raw["playbook"],
        outcome=raw["outcome"],
        entry=DreimannEntryLabel(
            type=entry["type"],
            price=entry["price"],
            approx_time_utc=entry["approxTimeUtc"],
            source=entry["source"],
        ),
        stop_price=raw["stop"]["price"],
        stop_source=raw["stop"]["source"],
        objective=DreimannObjectiveLabel(
            price=objective["price"],
            kind=objective["kind"],
            within_window=objective["withinWindow"],
            tolerance_pct=objective["tolerancePct"],
            claims_weak_structure=objective["claimsWeakStructure"],
            source=objective["source"],
        ),
        notes=raw["notes"],
    )


def load_dreimann_fixture(name: DreimannTradeName) -> DreimannFixture:
    data = _read_json(f"{name}.json")
    all_labels = _read_json("labels.json")
    if name not in all_labels:
        raise KeyError(f'labels.json has no entry for "{name}"')
    series = {
        interval: [Candle(**candle) for candle in candles]
        for interval, candles in data["series"].items()
    }
    return DreimannFixture(
        meta=data["meta"],
        series=series,
        labels=_parse_labels(all_labels[name]),
    )


def label_time(iso: str) -> int:
    """Unix seconds for an ISO label timestamp, matching Candle.time."""
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(UTC).timestamp())
