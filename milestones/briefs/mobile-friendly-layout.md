# Mobile-Friendly Layout — Market Pulse Frontend

Make the Market Pulse frontend (Vite+React 19, TanStack Start) mobile-friendly like the Bybit mobile app.

## Current state
- Desktop sidebar (hidden on mobile) + bottom nav with 4 tabs
- Layout uses `lg:` breakpoints but cards/padding aren't optimized for mobile
- Token page has verdict header + chart + assistant panel side-by-side (desktop) or stacked (mobile poorly)
- Homepage cards have desktop-sized padding on mobile

## What to build

### 1. Bottom nav enhancement (bottom-nav.tsx)
- Current: simple text + icon tabs
- Target: Bybit-style active indicator (small dot or underline), slightly more prominent active state
- Safe-area handling already there (`pb-[env(safe-area-inset-bottom)]`) — keep it
- Keep 4 tabs: Today, Markets, Journal, Settings

### 2. Homepage mobile (routes/index.tsx)
- Reduce card padding on mobile (`p-5` → `p-3 sm:p-5`)
- Make RegimeVerdictHero full-width with less whitespace on small screens
- LiveSetupsStrip: reduce card padding, thinner borders
- AlternativesStrip: compact row height on mobile
- TopNews: compact layout on mobile
- CatalystRail: horizontal scroll on mobile instead of wrap

### 3. Token page mobile (routes/token.$symbol.tsx)
- VerdictHeader: make intent selector scrollable horizontally, compact padding
- Skip Check button and CatalystLine: inline on mobile, full-width modal for Skip Check panel
- Chart section: stack full-width (currently tries side-by-side on mobile)
- AssistantPanel: collapsible bottom sheet on mobile (like Bybit's trade panel)
- The `lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,25rem)_auto]` should collapse to single column on mobile

### 4. Markets page mobile (routes/markets.tsx + markets-panel.tsx)
- Tab bar: scrollable horizontally on mobile
- Market cards: 1 column on mobile (currently 2 columns)
- Alternatives card: compact rows
- Heatmap: smaller cells on mobile

### 5. General style
- All `px-5` → `px-3 sm:px-5` or `px-4 sm:px-5` on card containers
- All `p-5` → `p-3 sm:p-5` on card paddings
- Touch targets minimum 44px on mobile
- Keep dark theme, keep Montserrat font
- DON'T change any logic, hooks, API calls, or data fetching

## Files to modify
- `frontend/src/routes/index.tsx`
- `frontend/src/routes/token.$symbol.tsx`
- `frontend/src/routes/markets.tsx`
- `frontend/src/components/features/sidebar.tsx`
- `frontend/src/components/features/bottom-nav.tsx`
- `frontend/src/components/features/markets-panel.tsx`
- `frontend/src/components/features/token/verdict-header.tsx`
- `frontend/src/components/features/token/catalyst-line.tsx`
- `frontend/src/components/features/token/assistant-panel.tsx`
- `frontend/src/components/features/token/verdict-cards.tsx`
- `frontend/src/components/features/regime-hero.tsx`
- `frontend/src/components/features/market-opportunities-card.tsx`
- `frontend/src/components/features/alternatives-strip.tsx`
- `frontend/src/components/features/iq-card.tsx`
- `frontend/src/components/features/market-card.tsx`
- `frontend/src/components/features/heatmap.tsx`
- `frontend/src/styles.css` (add mobile-specific utility classes if needed)

## Tech constraints
- Tailwind CSS responsive prefixes only (sm:/md:/lg:)
- No new dependencies
- No CSS-in-JS libraries — tailwind only
- Keep all existing functionality
- DO NOT change any TypeScript types, hooks, API routes, or data logic

## Verification
1. `bunx tsc --noEmit` must pass
2. `bunx vitest run` must pass (same or fewer failures)
3. Build with `bun run build`
4. Preview homepage + token page + markets page at 375px viewport width
