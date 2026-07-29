Implement R4-T6: Frontend per-trade forensics rows + distributions view.

The backend API at GET /api/v1/review/forensics returns forensics data per trade:
- mae_price, mae_percent, mae_r, mae_available, mae_reason
- mfe_price, mfe_percent, mfe_r, mfe_available, mfe_reason
- exit_efficiency, exit_efficiency_available, exit_efficiency_reason
- slippage_adverse, slippage_adverse_r, violation_depth_r, realized_r
- stop_discipline_available, stop_discipline_reason
- reentry_latency_seconds, reentry_same_direction, reentry_after_loss
- reentry_available, reentry_reason
- sizing_notional
- kline_interval, kline_candles_in_window, boundary_inflation_bound_pct

Frontend proxy: The frontend TanStack Start proxies to the backend. Create a route at frontend/src/routes/api/review.forensics.ts and frontend/src/routes/api/review.forensics.$tradeId.ts following the pattern of other API routes (e.g. review.$id.ts, review.analytics.ts - check those files for the proxy pattern).

## WHAT TO BUILD

### 1. Create frontend API proxy routes

**frontend/src/routes/api/review.forensics.ts**
- GET handler that proxies to backend /api/v1/review/forensics?page=N&per_page=M
- Returns JSON with data and meta

**frontend/src/routes/api/review.forensics.$tradeId.ts**
- GET handler that proxies to backend /api/v1/review/forensics/{tradeId}
- Returns JSON with data

Check existing api routes like review.analytics.ts, review.$id.ts for the exact TanStack Start proxy pattern.

### 2. Create frontend hook: frontend/src/hooks/useForensics.ts
- useTradeForensics(tradeId: string) — fetches forensics for one trade
- useForensicsList(page, perPage) — fetches paginated list

### 3. Add forensics display to TradeReviewRow in review-panel.tsx

Currently TradeReviewRow shows: trade info, PnL, AI review button. Add a forensics section that displays:
- A collapsible "Forensics" section (can be toggled open/closed per trade row)
- When open, show a mini dashboard with:

**MAE/MFE bars** — a horizontal bar showing the excursion range:
```
Entry $50,000 ──────────────────────────
              ├── MAE $47,500 (-5%)
              └── MFE $56,000 (+12%)  → Exit $55,000 (83% efficiency)
```

Use simple colored bars:
- Red bar for MAE (how far it went against you)
- Green bar for MFE (how far it went for you)  
- Arrow/dot showing where exit happened relative to MFE

**Stop discipline card** — shows when stop is evidenced:
- slippage_adverse (in $ and R)
- violation_depth_r (how far past stop price it traded)
- realized_r (what actually happened in R)

**Re-entry latency** — shows if the trade was a re-entry after loss:
- "Re-entered after 2h 15m" or "Same direction as previous trade" etc.

**Unavailable reasons** — show reason when data unavailable (e.g. "Estimated open time" in amber badge)

### 4. Distributions view

Below the trade list, add a summary section:
- "Forensics summary" card showing averages across all trades
- Count of trades with available MAE, MFE, efficiency
- Simple text stats (no charts needed for now)

### 5. Styling
- Keep inline with existing IqCard/badge patterns
- Compact — this is secondary to the main trade info
- Use small text, subtle colors (text-muted-foreground, border-border)
- Collapsed by default to not crowd the page

## FILES TO CREATE
- frontend/src/routes/api/review.forensics.ts
- frontend/src/routes/api/review.forensics.$tradeId.ts
- frontend/src/hooks/useForensics.ts

## FILES TO MODIFY
- frontend/src/components/features/review-panel.tsx (add forensics to TradeReviewRow)

## CONSTRAINTS
- Tailwind v4 classes
- Use existing components
- NO git operations
- NO backend changes
- Read existing api routes to match the proxy pattern exactly
