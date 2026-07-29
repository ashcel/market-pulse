Upgrade the "Your Trades" section on the home page (index.tsx) to show individual open trade cards with live PnL and health status.

## CURRENT STATE
`TradesAndBehaviorStrip` in `frontend/src/routes/index.tsx` (lines 273-312) currently shows only a thin summary strip: count of open trades + total unrealized PnL + behavior warning. No individual trade cards.

## WHAT TO CHANGE

### 1. Import OpenPositionCard
Add import for OpenPositionCard from `@/components/features/trades-panel`:
```
import { OpenPositionCard } from "@/components/features/trades-panel";
```

### 2. Upgrade TradesAndBehaviorStrip
Change the component to show individual trade cards for each open position:

- Header row: "Your Trades" eyebrow + count + total unrealized PnL summary
- If count === 0 && no behaviorWarning: return null (same as current)
- If count === 0 && behaviorWarning: show only the warning (same as current)
- If count > 0: show each open trade as an OpenPositionCard
  - Map over `rows` array and render `<OpenPositionCard key={row.trade.id} row={row} />`
  - Add a "View all trades →" link to /journal tab=open

### 3. Add health indicators
For each trade card, add a health indicator line:
- If unrealizedPnl is null: show "Awaiting live price…" in muted text
- If unrealizedPnl is positive and > 5% of entry: green "Healthy ✅"
- If unrealizedPnl is positive but ≤ 5%: amber "Watching 👀"  
- If unrealizedPnl is negative but |PnL| < 3% of entry: amber "Slipping ⚠️"
- If unrealizedPnl is negative and |PnL| ≥ 3% of entry: red "At Risk 🔴"
- Health line appears below trade stats, before notes

Use a new inline component or keep it simple.

### 4. Keep existing behavior warning
The behaviorWarning (overtrade detection) stays in the header area.

## FILES TO MODIFY
- frontend/src/routes/index.tsx

## CONSTRAINTS
- NO changes to hooks or data fetching
- NO git operations
- Tailwind v4 classes
- Use existing components (IqCard, Badge, CardEyebrow, etc.)
- Response: mobile stacks, desktop 2-column grid for trades
