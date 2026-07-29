Build real-time Binance position streaming for Market Pulse using WebSocket user data stream.

## WHAT TO BUILD

### BACKEND — Position WS Manager + SSE endpoint

**1. Create `backend/app/execution/position_ws_manager.py`**

A singleton manager that:
- Manages a Binance user data stream listenKey for each user
- Connects to `wss://fstream.binance.com/ws/<listenKey>` 
- Parses `ACCOUNT_UPDATE` events, specifically the `P` (position) array
- Broadcasts position updates to connected SSE clients
- Keepalive: `PUT /fapi/v1/listenKey` every 30 minutes
- Auto-reconnect on disconnect

Required methods:
- `start_listener(user_id, db)` — creates listenKey, starts WS
- `stop_listener(user_id)` — cleanup
- `register_client(user_id, queue)` — for SSE streaming  
- `remove_client(user_id, queue)` — cleanup on disconnect

The Binance ACCOUNT_UPDATE format:
```json
{
  "e": "ACCOUNT_UPDATE",
  "E": 1564034571105,
  "a": {
    "P": [
      {
        "s": "BTCUSDT",
        "pa": "0.001",
        "ep": "40800.0",
        "up": "25.0",
        "mt": "isolated",
        "ps": "BOTH"
      }
    ]
  }
}
```

Position fields:
- `s` — symbol (e.g. BTCUSDT)
- `pa` — position amount (positive = long, negative = short, "0" = flat)
- `ep` — entry price
- `up` — unrealized PnL
- `ps` — position side (BOTH/LONG/SHORT)

**2. Create `backend/app/execution/position_router.py`**

SSE endpoint:
- `GET /api/execution/positions/stream` — Server-Sent Events stream
- Uses `sse_starlette.sse.EventSourceResponse` or `StreamingResponse`
- Sends position data as JSON: `{ symbol, side, positionAmt, entryPrice, unrealizedPnl, markPrice?, leverage? }`
- On connect: check auth, get current positions from Binance REST API first, then stream updates
- Filters out zero-position rows (positionAmt = 0)
- Client disconnect handled gracefully

**3. Register in `backend/app/__init__.py` or `main.py`**

Add the new router.

### FRONTEND — Live positions hook + display

**1. Create `frontend/src/hooks/useLivePositions.ts`**

Hook that connects to the SSE endpoint:
```ts
export interface LivePosition {
  symbol: string;
  side: "LONG" | "SHORT";
  positionAmt: number;
  entryPrice: number;
  unrealizedPnl: number;
  markPrice: number | null;
  leverage: number;
}
```
- Uses `EventSource` (SSE) to connect
- Auto-reconnect on error
- Returns `{ positions, isLoading, error }`
- Updates state on each SSE event

**2. Update home page: `frontend/src/routes/index.tsx`**
Currently the `TradesAndBehaviorStrip` component uses `useOpenTradesPnl`. Replace it with `useLivePositions` for the "Your Trades" section using a new component `LivePositionsStrip`:

- Uses the same OpenPositionCard from trades-panel.tsx as the current implementation but feeds it from the live positions data
- Shows: symbol, direction (LONG/SHORT), entry price, mark price, unrealized PnL (in $ and %), leverage badge
- Health indicator: same as current (Healthy/Watching/Slipping/At Risk) but based on live PnL
- When no positions: return null (section hidden)
- Behavior warning (overtrade detection) kept from current implementation

Map LivePosition to a format compatible with OpenPositionCard or create inline rendering.
The `OpenPositionCard` expects `row: OpenTradePnl` with `{ trade, livePrice, unrealizedPnl, unrealizedPct }`.
Create a conversion: `positionToTradeRow(position)` that converts LivePosition to match the expected shape.

## FILES TO CREATE
- backend/app/execution/position_ws_manager.py
- backend/app/execution/position_router.py
- frontend/src/hooks/useLivePositions.ts

## FILES TO MODIFY
- backend/app/main.py (register router)
- frontend/src/routes/index.tsx (replace TradesAndBehaviorStrip with LivePositionsStrip)

## CONSTRAINTS
- Use existing BinanceExecClient for API calls (get_positions, get_account, listenKey)
- Use existing exec_key_service for getting user's key
- SSE on backend, EventSource on frontend
- Tailwind v4 classes
- NO git operations
- Frontend is TanStack Start (SSR), so EventSource must be in useEffect (client-side only)
