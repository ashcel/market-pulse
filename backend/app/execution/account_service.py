import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from .binance_client import BinanceExecClient
from .exceptions import ExecutionKeyCredentialsInvalidError, ExecutionKeyNotFoundError
from .exec_key_crypto import decrypt
from .exec_key_service import get_exec_key
from .risk_engine import AccountState

SECTOR_BUCKETS: dict[str, str] = {
    "BTCUSDT": "btc",
    "BTCDOMUSDT": "btc",
    "ETHUSDT": "eth",
    "ETHDOMUSDT": "eth",
    "SOLUSDT": "l1",
    "AVAXUSDT": "l1",
    "BNBUSDT": "l1",
    "ADAUSDT": "l1",
    "DOTUSDT": "l1",
    "MATICUSDT": "l1",
    "ARBUSDT": "l1",
    "OPUSDT": "l1",
    "SUIUSDT": "l1",
    "LINKUSDT": "defi",
    "UNIUSDT": "defi",
    "AAVEUSDT": "defi",
    "PENDLEUSDT": "defi",
    "DOGEUSDT": "meme",
    "SHIBUSDT": "meme",
    "PEPEUSDT": "meme",
    "BONKUSDT": "meme",
}


@dataclass
class CachedAccountState:
    state: AccountState
    fetched_at: datetime


_cache: dict[str, CachedAccountState] = {}


class AccountStateError(RuntimeError):
    """Typed account-snapshot dependency failure."""


class ExchangeUnreachableError(AccountStateError):
    pass


class CredentialsInvalidError(AccountStateError):
    pass


class AccountRateLimitedError(AccountStateError):
    pass


async def get_account_state(db: AsyncSession, user_id: str, settings) -> AccountState:
    try:
        key = await get_exec_key(db, user_id)
        secret = decrypt(key.encrypted_secret)
        client = BinanceExecClient(key.api_key, secret, testnet=key.testnet)

        balances = await client.get_balance()
        usdt_balance = Decimal("0")
        for b in balances:
            if b.get("asset") == "USDT":
                usdt_balance = Decimal(str(b.get("balance", "0")))
                break

        positions = await client.get_positions()
        open_positions = [p for p in positions if float(p.get("positionAmt", 0)) != 0]

        income = await client.get_income_history(income_type="REALIZED_PNL")
        # naive today / week logic for tests
        now_ms = int(time.time() * 1000)
        day_ms = 24 * 60 * 60 * 1000
        week_ms = 7 * day_ms

        daily_pnl = Decimal("0")
        weekly_pnl = Decimal("0")
        for inc in income:
            t = int(inc.get("time", 0))
            amt = Decimal(str(inc.get("income", "0")))
            if now_ms - t <= week_ms:
                weekly_pnl += amt
                if now_ms - t <= day_ms:
                    daily_pnl += amt

        # calculate exposures
        exposures = {}
        for p in open_positions:
            sym = p.get("symbol")
            amt = Decimal(str(p.get("positionAmt", "0")))
            mark = Decimal(str(p.get("markPrice", "0")))
            notional = abs(amt * mark)
            bucket = SECTOR_BUCKETS.get(sym, "other")
            if usdt_balance > 0:
                pct = (notional / usdt_balance) * 100
                exposures[bucket] = exposures.get(bucket, Decimal("0")) + pct

        daily_pct = (daily_pnl / usdt_balance * 100) if usdt_balance > 0 else Decimal("0")
        weekly_pct = (weekly_pnl / usdt_balance * 100) if usdt_balance > 0 else Decimal("0")

        state = AccountState(
            balance=usdt_balance,
            open_position_count=len(open_positions),
            daily_realized_pnl_percent=daily_pct,
            weekly_realized_pnl_percent=weekly_pct,
            exposure_by_bucket_percent=exposures,
            active_behavior_flags=frozenset(),
            is_stale=False,
        )

        _cache[user_id] = CachedAccountState(state=state, fetched_at=datetime.now())
        return state
    except (
        httpx.HTTPError,
        ExecutionKeyCredentialsInvalidError,
        ExecutionKeyNotFoundError,
        ValueError,
    ) as exc:
        if user_id in _cache:
            c = _cache[user_id]
            if (
                datetime.now() - c.fetched_at
            ).total_seconds() < settings.ACCOUNT_STATE_MAX_AGE_SECONDS * 2:
                return AccountState(
                    balance=c.state.balance,
                    open_position_count=c.state.open_position_count,
                    daily_realized_pnl_percent=c.state.daily_realized_pnl_percent,
                    weekly_realized_pnl_percent=c.state.weekly_realized_pnl_percent,
                    exposure_by_bucket_percent=c.state.exposure_by_bucket_percent,
                    active_behavior_flags=c.state.active_behavior_flags,
                    is_stale=True,
                )
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429:
            raise AccountRateLimitedError("Binance account API rate limited") from exc
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in {401, 403}:
            raise CredentialsInvalidError("Binance credentials rejected") from exc
        if isinstance(
            exc,
            (ExecutionKeyCredentialsInvalidError, ExecutionKeyNotFoundError, ValueError),
        ):
            raise CredentialsInvalidError("Binance credentials unavailable or invalid") from exc
        raise ExchangeUnreachableError("Binance account API unreachable") from exc
