from app.exceptions import AppError, NotFoundError

from .constants import ErrorCode


class ReviewTradeNotFoundError(NotFoundError):
    code = ErrorCode.REVIEW_TRADE_NOT_FOUND

    def __init__(self, trade_id: str) -> None:
        super().__init__(f"Binance trade '{trade_id}' not found")


class ReviewTradeForbiddenError(AppError):
    status_code = 403
    code = ErrorCode.REVIEW_TRADE_FORBIDDEN

    def __init__(self) -> None:
        super().__init__("You do not have access to this trade")


class ReviewNotFoundError(NotFoundError):
    code = ErrorCode.REVIEW_NOT_FOUND

    def __init__(self, trade_id: str) -> None:
        super().__init__(f"No review found for trade '{trade_id}'")
