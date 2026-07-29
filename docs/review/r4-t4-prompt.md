Implement R4-T4: Forensics persistence, kline enrichment, endpoint, and worker pass.

R4-T3 (backend/app/review/forensics.py) is done with pure compute functions. Now wire it up.

## 1. Raw-interval kline fetcher
Add to `backend/app/worker/binance.py`:
- `fetch_klines_raw(symbol: str, interval: str, limit: int, end_time: int | None = None) -> list[dict]`
- Uses `https://fapi.binance.com/fapi/v1/klines` directly (skips TokenTimeframe/BINANCE_INTERVALS)
- Supports "1m", "5m", "15m", "1h", "4h", "1d"
- Uses the existing shared httpx client
- Returns standard kline lists

## 2. Forensics model
Add to `backend/app/review/models.py` or create `backend/app/review/forensics_models.py`:
```python
class TradeForensics(Base):
    __tablename__ = "trade_forensics"
    id: str (PK uuid)
    user_id: str (FK, indexed)
    binance_trade_id: str (FK to binance_trades.id, unique)
    forensics_version: str (default "1.0.0")
    kline_interval: str | None
    kline_candles_in_window: int | None
    boundary_inflation_bound_pct: float | None
    # MAE/MFE
    mae_price: float | None; mae_percent: float | None; mae_r: float | None
    mae_available: bool; mae_reason: str | None
    mfe_price: float | None; mfe_percent: float | None; mfe_r: float | None
    mfe_available: bool; mfe_reason: str | None
    # Exit efficiency
    exit_efficiency: float | None
    exit_efficiency_available: bool; exit_efficiency_reason: str | None
    # Stop discipline
    slippage_adverse: float | None; slippage_adverse_r: float | None
    violation_depth_r: float | None; realized_r: float | None
    stop_discipline_available: bool; stop_discipline_reason: str | None
    # Re-entry
    reentry_latency_seconds: float | None
    reentry_same_direction: bool | None
    reentry_after_loss: bool | None
    reentry_available: bool; reentry_reason: str | None
    # Sizing variance (per-trade — uses same metric but per-row)
    sizing_notional: float | None
    # System
    created_at: datetime
    updated_at: datetime | None
```

## 3. Migration
Create hand-written SQL migration in `backend/migrations/versions/` following the existing naming pattern.

## 4. Forensics service
Create `backend/app/review/forensics_service.py`:
- `async def compute_and_persist_forensics(db, user_id, trade, trades, klines) -> TradeForensics`
- `async def compute_forensics_for_user(db, user_id) -> int` — computes for all un-forensiced trades
- Uses forensics.py pure functions for computation
- Fetches klines using `fetch_klines_raw` at the appropriate interval
- Creates/updates TradeForensics rows

## 5. Worker pass
Add `backend/app/worker/forensics_pass.py`:
- `async def run_forensics_pass() -> str`
- Runs after binance_review_sync_tick completes
- Calls compute_forensics_for_user for each user who has synced trades
- Register it in worker/config.py as a cron job (every hour, same as binance_review_sync)

## 6. API endpoint
Add to `backend/app/review/router.py`:
- `GET /api/v1/review/forensics/{trade_id}` — get forensics for one trade
- `GET /api/v1/review/forensics` — list forensics (paginated)

## CONSTRAINTS
- NO git operations
- Hand-written SQL migrations (not alembic auto)
- Use existing patterns from the repo
- Run `python -m compileall -q` to verify
