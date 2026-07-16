"""Phase 0 smoke test — the package imports."""

import smc


def test_package_imports() -> None:
    assert smc is not None
