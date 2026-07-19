# M9 Execution Plane Report

## 1. Architecture Decisions

- Execution remains an extension of the existing permit architecture. Risk Engine, Constitution, Permit Issuance, Permit Consumption, and AI CRO were not redesigned.
- AI CRO remains read-only. Execution status, permit status, order fields, quantity, SL, TP, and risk decisions are never sourced from AI output.
- Execution is fail-closed. Order submission is blocked when execution is disabled, the execution encryption secret is still the default, execution timeout/base-url settings are invalid, or mainnet is requested without explicit hardening.
- `TradePermit` remains the immutable authorization snapshot. `ExecutionRecord` is now the mutable operational state machine for one consumed permit.
- A permit can be consumed exactly once. A unique `execution_records.permit_id` and atomic `trade_permits.consumed_at` / `consumed_by_execution_id` update preserve the authorization boundary.
- Idempotency is durable. `execution_records.idempotency_key` is unique, and entry/SL/TP client order IDs are derived deterministically from that key.
- Caller quantity is ignored. Executable quantity is rederived from the persisted permit proposal/account snapshot.
- Exchange recovery is evidence-based. Retries reconcile by stored Binance `origClientOrderId` before resuming; they do not mint new logical executions.

## 2. State Machine Diagram

```text
PENDING_ENTRY
  | submit entry
  v
ENTRY_SUBMITTED
  | confirmed or reconciled by entry_client_order_id
  v
ENTRY_CONFIRMED
  | submit reduce-only stop
  v
PROTECTION_SUBMITTED
  | confirmed or reconciled by sl_client_order_id
  v
PROTECTED
  | submit reduce-only TP when target exists
  |---- TP accepted --------------------------> PROTECTED
  |---- TP rejected --------------------------> TP_FAILED

Failure and recovery edges:

PENDING_ENTRY / ENTRY_SUBMITTED / PROTECTION_SUBMITTED
  | exchange timeout
  v
RECONCILIATION_REQUIRED
  | reconcile by deterministic client order id
  v
ENTRY_CONFIRMED or PROTECTED

ENTRY_SUBMITTED
  | exchange rejects entry
  v
ENTRY_REJECTED

PROTECTION_SUBMITTED
  | SL rejected
  v
UNPROTECTED_CRITICAL
  | reduce-only market flatten accepted
  v
FLATTENED

UNPROTECTED_CRITICAL
  | flatten rejected or times out
  v
UNPROTECTED_CRITICAL
```

Terminal states: `PROTECTED`, `TP_FAILED`, `FLATTENED`, `ENTRY_REJECTED`, `UNPROTECTED_CRITICAL`.

Resumable states: `PENDING_ENTRY`, `ENTRY_SUBMITTED`, `ENTRY_CONFIRMED`, `PROTECTION_SUBMITTED`, `RECONCILIATION_REQUIRED`.

## 3. Execution Lifecycle

1. The order path first checks execution readiness and fails closed before permit consumption.
2. Duplicate clicks with the same idempotency key return the existing execution record. Reusing the same idempotency key for a different permit is rejected.
3. Permit consumption loads the permit, verifies owner/status/TTL/unused state, checks request fields against the immutable permit snapshot, derives quantity, creates `ExecutionRecord`, and marks the permit consumed in the same transaction.
4. Entry submission stores `ENTRY_SUBMITTED` before calling Binance. The entry uses `{idempotency_key}_entry`.
5. Entry confirmation records exchange order ID and filled quantity. Partial fills protect only the filled quantity.
6. Stop-loss submission stores `PROTECTION_SUBMITTED` and uses `{idempotency_key}_sl` with reduce-only quantity.
7. Once SL is confirmed, execution becomes `PROTECTED`. TP submission is attempted separately with `{idempotency_key}_tp`.
8. TP failure does not invalidate SL protection; the record moves to `TP_FAILED`.
9. SL failure moves to `UNPROTECTED_CRITICAL` and immediately attempts a reduce-only market flatten. Successful flatten moves to `FLATTENED`.

## 4. Recovery Strategy

- Timeout recovery: the record moves to `RECONCILIATION_REQUIRED`; retry uses stored client order IDs to query Binance before submitting the next step.
- Retry after timeout: retrying the same idempotency key resumes the existing execution instead of consuming another permit.
- Worker/process restart: persisted status, client order IDs, order IDs, filled quantity, protected quantity, and event log allow the service to resume from the last durable state.
- Reconciliation: `ENTRY_SUBMITTED` reconciles by `entry_client_order_id`; `PROTECTION_SUBMITTED` reconciles by `sl_client_order_id`.
- Duplicate click: same permit and idempotency key returns the existing execution response without resubmitting exchange orders.
- Replay defense: consumed permits cannot execute again with a new idempotency key; idempotency keys cannot be rebound to another permit.
- Transaction rollback: permit mismatches roll back without `ExecutionRecord` creation or permit consumption.

## 5. Remaining Known Risks

- Database-level append-only protections for permits/constitution/audit rows are still not enforced with triggers or restricted grants.
- Exchange precision filters in execution derivation still use local defaults until live `exchangeInfo` integration is added.
- `UNPROTECTED_CRITICAL` still requires operator alerting/escalation outside this service code path.
- Reconciliation is implemented around deterministic order IDs, but not yet backed by a periodic sweeper for long-lived unresolved records.
- Trade lock remains a separate stubbed surface and is not hardened against live exchange position/open-order state.
- No production migrations were run in this task.

## 6. Future Work - Mainnet Hardening Only

- Add DB-level immutability controls: append-only triggers or restricted grants for permits, constitution versions, audits, and execution event history.
- Add an execution reconciliation sweeper for `RECONCILIATION_REQUIRED` and `UNPROTECTED_CRITICAL` records with operator alerting.
- Integrate live Binance `exchangeInfo` filters and persist the filters used for each execution.
- Add mainnet isolation controls: separate credentials, explicit environment gating, runbook, alert channels, dry-run rehearsal, and rollback procedure.
- Add position-level trade-lock enforcement based on persisted execution state plus live Binance position/open-order reconciliation.

## Verification

- Tests: `cd backend && uv run pytest -q` - 1330 passed.
- Execution integration tests: `cd backend && uv run pytest tests/test_execution_order_service.py -q` - 29 passed.
- Execution-focused tests: `cd backend && uv run pytest tests/test_execution_order_service.py tests/test_execution_permit.py tests/test_execution_account_service.py tests/test_execution_exec_key.py tests/test_execution_binance_client.py tests/test_execution_risk_engine.py tests/test_execution_trade_lock.py tests/test_execution_ai_cro.py tests/test_execution_behavior_detectors.py -q` - 105 passed.
- Lint: `cd backend && uv run ruff check app tests migrations` - passed.
- Build: `cd backend && uv build` - built source distribution and wheel successfully.
- Frontend lint: `cd frontend && npm run lint` - passed with 11 existing warnings.
- Frontend build: `cd frontend && npm run build` - passed with existing chunk-size/plugin timing warnings.
