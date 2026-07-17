from app.exceptions import AppError, NotFoundError

from .constants import ErrorCode


class InvalidCredentialsError(AppError):
    status_code = 401
    code = ErrorCode.INVALID_CREDENTIALS

    def __init__(self) -> None:
        super().__init__("Invalid email or password")


class UserExistsError(AppError):
    status_code = 409
    code = ErrorCode.USER_EXISTS

    def __init__(self, email: str) -> None:
        super().__init__(f"User with email '{email}' already exists")


class UserNotFoundError(NotFoundError):
    code = ErrorCode.USER_NOT_FOUND

    def __init__(self, user_id: str) -> None:
        super().__init__(f"User '{user_id}' not found")


class InvalidTokenError(AppError):
    status_code = 401
    code = ErrorCode.INVALID_TOKEN

    def __init__(self) -> None:
        super().__init__("Invalid or expired token")
