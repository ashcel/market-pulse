"""Port of version.test.ts — provenance determinism, the assert guard, and
shadow_combo_stats engine segmentation."""

import re
from dataclasses import replace
from typing import ClassVar

import pytest

from smc.shadow import ShadowSignal, shadow_combo_stats
from smc.version import ENGINE_VERSION, assert_provenance, config_hash, current_provenance


class TestProvenance:
    def test_config_hash_deterministic(self) -> None:
        assert config_hash() == config_hash()
        assert re.fullmatch(r"[0-9a-f]{8}", config_hash())

    def test_current_provenance_carries_version_and_hash(self) -> None:
        p = current_provenance()
        assert p.engine_version == ENGINE_VERSION
        assert p.config_hash == config_hash()
        assert isinstance(p.git_sha, str)

    def test_engine_version_is_the_python_reset(self) -> None:
        # The clock reset: the Python engine starts a fresh record at 2.0.0.
        assert ENGINE_VERSION == "2.0.0"


class TestAssertProvenance:
    """The last guard before a record hits the DB — it must pass every record
    the engine actually builds and reject anything with a blank field."""

    def test_passes_current_provenance(self) -> None:
        p = current_provenance()
        assert_provenance(p.engine_version, p.config_hash, p.git_sha)

    def test_throws_when_engine_version_missing_or_blank(self) -> None:
        with pytest.raises(ValueError, match="provenance"):
            assert_provenance(None, "abc", "def")
        with pytest.raises(ValueError, match="provenance"):
            assert_provenance("", "abc", "def")

    def test_throws_when_config_hash_missing(self) -> None:
        with pytest.raises(ValueError, match="provenance"):
            assert_provenance("2.0.0", None, "def")

    def test_throws_when_git_sha_missing(self) -> None:
        with pytest.raises(ValueError, match="provenance"):
            assert_provenance("2.0.0", "abc", None)

    def test_accepts_git_sha_dev_fallback_unknown(self) -> None:
        # That's a deliberate non-blank default.
        assert_provenance("2.0.0", "abc", "unknown")


def base_signal() -> ShadowSignal:
    return ShadowSignal(
        id="1",
        symbol="BTC",
        market="spot",
        intent="swing",
        direction="long",
        setup_type="lower-high-rejection",
        regime="trending-up",
        timeframe="4H",
        entry=100,
        stop=95,
        target1=110,
        target2=120,
        confidence=70,
        opened_at="2026-07-17T00:00:00.000Z",
        status="target1-hit",
        result_r=1,
    )


class TestComboStatsEngineSegmentation:
    signals: ClassVar[list[ShadowSignal]] = [
        replace(base_signal(), id="a", engine_version="0.9.0-dev"),
        replace(
            base_signal(), id="b", engine_version="0.8.0-old", result_r=-1, status="stopped-out"
        ),
    ]

    def test_pools_every_version_when_none_given(self) -> None:
        assert shadow_combo_stats(self.signals)[0].closed == 2

    def test_segments_to_requested_engine_version(self) -> None:
        scoped = shadow_combo_stats(self.signals, "0.9.0-dev")
        assert len(scoped) == 1
        assert scoped[0].closed == 1
        assert scoped[0].average_r == 1

    def test_excludes_records_with_no_provenance_from_versioned_query(self) -> None:
        legacy = [replace(base_signal(), id="legacy")]
        assert shadow_combo_stats(legacy, "0.9.0-dev") == []
