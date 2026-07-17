from app.exceptions import AppError, NotFoundError

from .constants import ErrorCode


class TradeNotFoundError(NotFoundError):
    code = ErrorCode.TRADE_NOT_FOUND

    def __init__(self, trade_id: str) -> None:
        super().__init__(f"Trade '{trade_id}' not found")


class TradeForbiddenError(AppError):
    status_code = 403
    code = ErrorCode.TRADE_FORBIDDEN

    def __init__(self) -> None:
        super().__init__("You do not have access to this trade")
