from app.exceptions import AppError, NotFoundError

from .constants import ErrorCode
from .validation import ValidationError


class ConstitutionNotFoundError(NotFoundError):
    code = ErrorCode.CONSTITUTION_NOT_FOUND

    def __init__(self, user_id: str) -> None:
        super().__init__(f"No trading constitution found for user '{user_id}'")


class ConstitutionValidationError(AppError):
    """Raised when `validate_constitution` returns one or more errors."""

    status_code = 422
    code = ErrorCode.CONSTITUTION_INVALID

    def __init__(self, errors: list[ValidationError]) -> None:
        super().__init__(
            "Trading constitution failed validation",
            details={
                "errors": [
                    {"field": e.field, "code": e.code.value, "message": e.message} for e in errors
                ]
            },
        )


class PermitNotFoundError(NotFoundError):
    code = ErrorCode.PERMIT_NOT_FOUND

    def __init__(self, permit_id: str) -> None:
        super().__init__(f"No trade permit found with id '{permit_id}'")


class PermitExpiredError(AppError):
    status_code = 409
    code = ErrorCode.PERMIT_EXPIRED

    def __init__(self, permit_id: str) -> None:
        super().__init__(f"Trade permit '{permit_id}' is expired")


class PermitAlreadyUsedError(AppError):
    status_code = 409
    code = ErrorCode.PERMIT_ALREADY_USED

    def __init__(self, permit_id: str) -> None:
        super().__init__(f"Trade permit '{permit_id}' has already been consumed")


class PermitRejectedError(AppError):
    status_code = 409
    code = ErrorCode.PERMIT_REJECTED

    def __init__(self, permit_id: str) -> None:
        super().__init__(f"Trade permit '{permit_id}' is not approved")


class PermitMismatchError(AppError):
    status_code = 409
    code = ErrorCode.PERMIT_MISMATCH

    def __init__(self, permit_id: str, fields: list[str]) -> None:
        super().__init__(
            f"Execution request does not match trade permit '{permit_id}'",
            details={"fields": fields},
        )


class ExecutionKeyNotFoundError(NotFoundError):
    pass


class ExecutionKeyWithdrawalScopeError(AppError):
    status_code = 422
    code = "EXEC_KEY_WITHDRAWAL_SCOPE"


class ExecutionKeyIPNotAllowlistedError(AppError):
    status_code = 422
    code = "EXEC_KEY_IP_NOT_ALLOWLISTED"


class ExecutionKeyCredentialsInvalidError(AppError):
    status_code = 422
    code = "EXEC_KEY_CREDENTIALS_INVALID"


class ExecutionDisabledError(AppError):
    status_code = 403
    code = ErrorCode.EXECUTION_DISABLED


class ExecutionNotReadyError(AppError):
    status_code = 503
    code = ErrorCode.EXECUTION_NOT_READY

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("Execution is not ready", details={"reasons": reasons})


class DuplicateIdempotencyKeyError(AppError):
    status_code = 409
    code = ErrorCode.DUPLICATE_IDEMPOTENCY_KEY

    def __init__(self, idempotency_key: str) -> None:
        super().__init__(
            f"Idempotency key '{idempotency_key}' is already bound to another permit"
        )


class ExecutionInProgressError(AppError):
    status_code = 409
    code = ErrorCode.EXECUTION_IN_PROGRESS

    def __init__(self, execution_id: str) -> None:
        super().__init__(f"Execution '{execution_id}' is already in progress")


class TradeLockViolationError(AppError):
    status_code = 422
    code = "TRADE_LOCK_VIOLATION"
