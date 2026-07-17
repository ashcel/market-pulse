"""Engine version + provenance — the primary GROUP BY for every stat.

Bump ``ENGINE_VERSION`` on any change to decision or trigger *semantics* so
the record segments by engine behaviour instead of pooling incompatible
versions into one hit-rate.

Semver intent: major = trigger/decision semantics, minor = additive signal,
patch = fix. ``2.0.0`` marks the Python engine cutover — the forward-test
clock **resets to n=0** here (docs/migration-plan.md, decision 2026-07-16):
the ``1.0.0`` TS record was declared buggy/disposable (2026-07-17) and does
not carry over. Stats from ``2.0.0`` onward are the evidence; nothing is
pooled across the language boundary.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

from smc.crypto_config import CRYPTO_RISK_SETTINGS
from smc.hysteresis import INTENT_MAX_HOLD_BARS

ENGINE_VERSION = "2.0.0"


def git_sha() -> str:
    """Build/commit SHA for exact traceability — ``GIT_SHA`` in the worker's
    environment, "unknown" in dev."""
    return os.environ.get("GIT_SHA") or "unknown"


def _stable_hash(value: object) -> str:
    """FNV-1a over the canonical (sorted-key) JSON encoding — dependency-free
    and deterministic."""
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    h = 0x811C9DC5
    for ch in encoded:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def config_hash() -> str:
    """Hash over the engine's outcome-affecting configuration. Captures
    config-only drift that the hand-bumped ENGINE_VERSION would miss: the
    resolved risk settings + the per-intent hold horizons — the two knobs
    that actually move recorded outcomes."""
    return _stable_hash({"risk": asdict(CRYPTO_RISK_SETTINGS), "holdBars": INTENT_MAX_HOLD_BARS})


@dataclass(slots=True)
class Provenance:
    """Provenance stamped onto every opened forward-test record."""

    engine_version: str
    config_hash: str
    git_sha: str


def current_provenance() -> Provenance:
    return Provenance(engine_version=ENGINE_VERSION, config_hash=config_hash(), git_sha=git_sha())


def assert_provenance(
    engine_version: str | None, config_hash_: str | None, git_sha_: str | None
) -> None:
    """Guards the one place provenance actually matters: right before a
    shadow/anticipatory/tracked record is persisted. A missing field means the
    caller bypassed ``current_provenance()`` — silently writing "" would pool
    a mis-stamped record into every version-segmented stat forever. Fail
    loudly instead of defaulting."""
    if not engine_version or not config_hash_ or not git_sha_:
        raise ValueError(
            "Refusing to persist a forward-test record with incomplete provenance "
            f"(engine_version={engine_version or '∅'}, config_hash={config_hash_ or '∅'}, "
            f"git_sha={git_sha_ or '∅'})."
        )
