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
                    {"field": e.field, "code": e.code.value, "message": e.message}
                    for e in errors
                ]
            },
        )


class PermitNotFoundError(NotFoundError):
    code = ErrorCode.PERMIT_NOT_FOUND

    def __init__(self, permit_id: str) -> None:
        super().__init__(f"No trade permit found with id '{permit_id}'")
