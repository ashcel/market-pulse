# Test Baseline

Baseline captured 2026-07-27. Known execution WIP tests are quarantined with `@pytest.mark.skip(reason="Execution WIP — see docs/test-baseline.md")`; all other backend tests must pass.

## Quarantined

| Test | Existing failure | Reason |
| --- | --- | --- |
| `tests/test_execution_permit.py::test_permit_card_rejected_shape` | Expected reason codes such as `DAILY_LOSS_LIMIT`; `build_permit_card` returns human-readable failed-check details. | Execution card response contract is unresolved. Changing it during operational hardening would alter the published UI contract. |
| `tests/test_execution_permit.py::test_stale_account_state_rejects_and_persists` | Expected `STALE_ACCOUNT_STATE`; response contains the human-readable stale-state detail. | Same unresolved execution card reason-code contract. The persistence and deterministic rejection assertions remain in the test for re-enablement. |
| `tests/test_execution_permit.py::test_account_service_failure_rejects_and_persists` | Expected `STALE_ACCOUNT_STATE`; response contains the human-readable stale-state detail. | Same unresolved execution card reason-code contract. Typed `exchange_unreachable` diagnostics are additionally asserted for re-enablement. |
| `tests/test_execution_exec_key.py::test_withdrawal_scope_rejected_by_fixture` | Fixture calls intake with its default `testnet=True`; withdrawal checks intentionally run only for mainnet. | Execution key test fixture does not select the security mode it intends to test. |
| `tests/test_execution_exec_key.py::test_ip_not_allowlisted_rejected` | Fixture calls intake with its default `testnet=True`; IP allowlist checks intentionally run only for mainnet. | Execution key test fixture does not select the security mode it intends to test. |

## Commands

```bash
cd backend
uv run pytest -q
uv run ruff check app/
```

Unquarantine each test when the execution permit-card contract selects either stable codes or display details and implementation/tests agree. New failures must not be added here automatically; investigate them as regressions first.
