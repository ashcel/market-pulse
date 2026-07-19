from enum import StrEnum


class ErrorCode(StrEnum):
    BINANCE_REVIEW_KEY_NOT_FOUND = "BINANCE_REVIEW_KEY_NOT_FOUND"
    BINANCE_REVIEW_CREDENTIALS_INVALID = "BINANCE_REVIEW_CREDENTIALS_INVALID"
    BINANCE_REVIEW_UPSTREAM_ERROR = "BINANCE_REVIEW_UPSTREAM_ERROR"
    BINANCE_REVIEW_CRYPTO_ERROR = "BINANCE_REVIEW_CRYPTO_ERROR"
    BINANCE_REVIEW_SYNC_LOG_NOT_FOUND = "BINANCE_REVIEW_SYNC_LOG_NOT_FOUND"
    BINANCE_REVIEW_SYNC_FORBIDDEN = "BINANCE_REVIEW_SYNC_FORBIDDEN"


# Sync bookkeeping — one BinanceTrade per REALIZED_PNL income event.
EXCHANGE_TRADE_ID_PREFIX = "binance-futures"

# Enrichment
ESTIMATED_OPEN_OFFSET_MS = 5 * 60 * 1000  # 5 minutes
OPEN_TIME_SOURCE_USER_TRADES = "user_trades"
OPEN_TIME_SOURCE_ESTIMATED = "estimated"

CLOSE_TRIGGER_LIQUIDATION = "liquidation"
CLOSE_TRIGGER_SL_HIT = "sl_hit"
CLOSE_TRIGGER_TP_HIT = "tp_hit"
CLOSE_TRIGGER_MANUAL_LIMIT = "manual_limit"
CLOSE_TRIGGER_MANUAL_MARKET = "manual_market"

SYNC_STATUS_SYNCING = "syncing"
SYNC_STATUS_SUCCESS = "success"
SYNC_STATUS_FAILED = "failed"

API_KEY_STATUS_ACTIVE = "active"
API_KEY_STATUS_INACTIVE = "inactive"

# Binance's read-only history endpoints (`/fapi/v1/income`, `/fapi/v1/userTrades`,
# `/fapi/v1/allOrders`) don't expose the leverage that was in effect at trade
# time the way Bybit's `/v5/position/closed-pnl.leverage` did — there is no
# historical-leverage endpoint. `BinanceTrade.leverage` defaults to this and is
# never enriched away; `roi_percent` is therefore computed against full
# notional (unleveraged) margin, which understates ROI% for leveraged
# positions. RR/analytics are unaffected (they key off entry/stop/qty, not
# leverage). See binance_review/service.py and the delivery report.
DEFAULT_LEVERAGE = 1.0
