from enum import StrEnum


class ErrorCode(StrEnum):
    REVIEW_TRADE_NOT_FOUND = "REVIEW_TRADE_NOT_FOUND"
    REVIEW_TRADE_FORBIDDEN = "REVIEW_TRADE_FORBIDDEN"
    REVIEW_NOT_FOUND = "REVIEW_NOT_FOUND"


# RR / stop-evidence thresholds
MIN_STOP_EVIDENCE_TRADES = 5
MIN_STOP_EVIDENCE_COVERAGE = 0.3

# Hour-of-day winrate bucketing
MIN_HOUR_SAMPLE = 3
HOUR_RANGE_EXPANSION_TOLERANCE_POINTS = 10.0  # winrate points

# Style-suitability bucketing
MIN_STYLE_SAMPLE = 5
SCALP_MAX_MS = 30 * 60 * 1000  # < 30 minutes
INTRADAY_MAX_MS = 24 * 60 * 60 * 1000  # 30m .. 24h
MIN_ORDER_HISTORY_SAMPLE_FOR_STYLE = 10

# UTC session boundaries (hour-of-day, [start, end))
SESSION_ASIA = (0, 8)
SESSION_LONDON = (8, 16)
SESSION_NEW_YORK = (16, 24)
