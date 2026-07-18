from app.exceptions import AppError, NotFoundError

from .constants import ErrorCode


class BybitKeyNotFoundError(NotFoundError):
    code = ErrorCode.BYBIT_KEY_NOT_FOUND

    def __init__(self) -> None:
        super().__init__("No Bybit API credentials configured")


class BybitCredentialsInvalidError(AppError):
    status_code = 400
    code = ErrorCode.BYBIT_CREDENTIALS_INVALID

    def __init__(self, message: str = "Bybit credentials could not be verified") -> None:
        super().__init__(message)


class BybitUpstreamError(AppError):
    status_code = 502
    code = ErrorCode.BYBIT_UPSTREAM_ERROR

    def __init__(self, message: str, ret_code: int | None = None) -> None:
        super().__init__(message, details={"ret_code": ret_code} if ret_code is not None else None)
        self.ret_code = ret_code


class BybitCryptoError(AppError):
    status_code = 400
    code = ErrorCode.BYBIT_CRYPTO_ERROR

    def __init__(self, message: str = "Malformed or undecryptable secret") -> None:
        super().__init__(message)


class BybitSyncLogNotFoundError(NotFoundError):
    code = ErrorCode.BYBIT_SYNC_LOG_NOT_FOUND

    def __init__(self, sync_id: str) -> None:
        super().__init__(f"Sync log '{sync_id}' not found")


class BybitSyncForbiddenError(AppError):
    status_code = 403
    code = ErrorCode.BYBIT_SYNC_FORBIDDEN

    def __init__(self) -> None:
        super().__init__("You do not have access to this sync log")
