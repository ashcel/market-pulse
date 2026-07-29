Redesign the live trades cards on the home page and add "Ask AI" button.

File: frontend/src/routes/index.tsx

## CHANGES

### 1. Redesign trade cards
Replace the current OpenPositionCard-based rendering with a sleeker design:
- Each card: compact, one row per position
- Left: symbol + direction arrow (green up / red down)
- Middle: entry price + mark price (small, muted)
- Right: unrealized PnL in bold (green/red) + PnL% 
- Badge for leverage
- A thin left border color: green if PnL>0, red if PnL<0, gray if 0

Keep the same data from positionToTradeRow() — just render it inline instead of using OpenPositionCard.

### 2. Keep overtrade badge
The `behaviorWarning` stays exactly where it is — in the header bar, amber colored, showing "⚠ Nth trade in 2h — overtrade watch"

### 3. Ask AI button
Below the trade cards grid, before "View all trades →", add a button:
- Text: "🤖 Ask AI about your trades"
- Style: outline button, full width on mobile, auto on desktop
- On click: opens a small inline panel or a dialog with a simple prompt input
- The panel has: a read-only textarea showing context (symbols, PnLs), a text input for user's question, and a "Send" button
- For now, on Send: show a toast "AI analysis coming soon — configure BYOK in Settings"
- Keep it simple — no backend wiring yet

### 4. Card grid
- Desktop: 2 columns
- Mobile: 1 column

## CONSTRAINTS
- Tailwind v4
- Use existing components (Badge, Button, IqCard, CardEyebrow)
- NO git operations
- NO backend changes
