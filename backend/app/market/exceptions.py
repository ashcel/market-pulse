from app.exceptions import NotFoundError

from .constants import ErrorCode


class TokenNotFoundError(NotFoundError):
    code = ErrorCode.TOKEN_NOT_FOUND

    def __init__(self, symbol: str) -> None:
        super().__init__(f"Token '{symbol}' not found")


class SignalNotFoundError(NotFoundError):
    code = ErrorCode.SIGNAL_NOT_FOUND

    def __init__(self, signal_id: str) -> None:
        super().__init__(f"Signal '{signal_id}' not found")
