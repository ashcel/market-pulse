from app.exceptions import AppError, NotFoundError

from .constants import ErrorCode


class BinanceReviewKeyNotFoundError(NotFoundError):
    code = ErrorCode.BINANCE_REVIEW_KEY_NOT_FOUND

    def __init__(self) -> None:
        super().__init__("No Binance API credentials configured for Trade Review")


class BinanceReviewCredentialsInvalidError(AppError):
    status_code = 400
    code = ErrorCode.BINANCE_REVIEW_CREDENTIALS_INVALID

    def __init__(self, message: str = "Binance credentials could not be verified") -> None:
        super().__init__(message)


class BinanceReviewUpstreamError(AppError):
    status_code = 502
    code = ErrorCode.BINANCE_REVIEW_UPSTREAM_ERROR

    def __init__(self, message: str) -> None:
        super().__init__(message)


class BinanceReviewCryptoError(AppError):
    status_code = 400
    code = ErrorCode.BINANCE_REVIEW_CRYPTO_ERROR

    def __init__(self, message: str = "Malformed or undecryptable secret") -> None:
        super().__init__(message)


class BinanceReviewSyncLogNotFoundError(NotFoundError):
    code = ErrorCode.BINANCE_REVIEW_SYNC_LOG_NOT_FOUND

    def __init__(self, sync_id: str) -> None:
        super().__init__(f"Sync log '{sync_id}' not found")


class BinanceReviewSyncForbiddenError(AppError):
    status_code = 403
    code = ErrorCode.BINANCE_REVIEW_SYNC_FORBIDDEN

    def __init__(self) -> None:
        super().__init__("You do not have access to this sync log")
