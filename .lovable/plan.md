# IQ — Market Intelligence Platform

Premium mobile-first market intelligence dashboard. Dark by default, mock data only, feel of Bloomberg Terminal with Apple/Linear restraint.

## Stack adjustments from your list

- **Routing**: The template ships with TanStack Start (SSR + file-based routes). Ripping it out for React Router DOM would delete the working shell (`__root.tsx`, `routeTree.gen.ts`, SSR entry) and add real risk with no user-visible benefit — every route pattern you asked for works identically in TanStack Router. I'll keep TanStack Router (same mental model as React Router: `<Link>`, nested routes, `<Outlet />`) unless you explicitly want the swap.
- **Added**: `zustand` (global UI state — theme, watchlist, active asset, refresh interval), `framer-motion` (light card mount + hover motion), `recharts`, TradingView embed placeholder.
- **Kept**: React 19, Vite, TS, Tailwind v4, shadcn/ui, TanStack Query (used for the mock-data hooks so a real REST layer slots in later).

If you still want React Router DOM specifically, say the word and I'll replan the shell swap as its own step.

## Design system

- Near-black background, lifted cards, hairline borders. Semantic tokens in `src/styles.css`: `--color-bullish` (green), `--color-bearish` (red), `--color-warning` (orange), `--color-info` (blue), plus card/border/muted. Registered under `@theme inline`.
- Inter + JetBrains Mono loaded via `<link>` in `__root.tsx`. Tabular numbers for all prices/percentages.
- 12px radius, soft shadows, 150ms hover lift, no gradients / glass / neon.
- Dark class forced on `<html>` by default; theme toggle in Zustand store.

## Layout shell

- **Desktop**: fixed left sidebar (IQ logo, nav, market clock, upgrade card, profile) + top bar (search, notifications, theme toggle, avatar) + main.
- **Mobile**: top bar (hamburger + logo + bell), sidebar in a Sheet, bottom nav with 5 tabs (Dashboard / Markets / Rankings / News / Settings).
- Switch via existing `useIsMobile` hook.

## Routes (`src/routes/`)

```
__root.tsx     shell + providers + head
index.tsx      Dashboard
markets.tsx    Market overview grid
regime.tsx     Gauge + timeline + explanation cards
rotation.tsx   Capital flow + sector heatmap
rankings.tsx   Sortable table + filters
technical.tsx  Asset selector + TradingView widget + signal cards
news.tsx       Impact cards
settings.tsx   Theme / watchlist / notifications / refresh / API
```

Each route gets its own `head()` with unique title + description + og tags.

## Page contents

- **Dashboard**: "Good Morning, Dewi" hero; 5 hero MetricCards (Regime, Rotation, Sentiment, Technical, Volatility); Market Overview strip with 1D/7D/30D toggle; Top Assets table with mini charts; News Highlights; Capital Flow Heatmap by sector.
- **Markets**: full MarketCard grid with sparklines and category tabs.
- **Regime**: large ConfidenceGauge, regime timeline (Recharts area), 5 explanation cards (Trend, Breadth, Volatility, Liquidity, Macro).
- **Rotation**: SVG capital-flow diagram (Stocks → BTC → ETH → AI → Gaming → Meme), sector heatmap, 4 summary cards.
- **Rankings**: shadcn Table, sortable columns, search input, category chips (Crypto/Stocks/ETF/Favorites), favorite star.
- **Technical**: asset combobox, real TradingView Advanced Chart widget (script-injected, themed dark) with graceful placeholder while loading, 6 SignalCards, overall Confidence Score.
- **News**: NewsImpactCard list (headline, impact badge, affected chips, expected direction, timestamp), impact filter tabs.
- **Settings**: theme, watchlist manager, notification toggles, refresh interval Select, API status pill.

## State & data

- **Zustand stores** (`src/stores/`): `useUiStore` (theme, sidebar open), `useWatchlistStore` (persisted to localStorage), `usePreferencesStore` (refresh interval, active asset).
- **TanStack Query hooks** (`src/hooks/queries/`): `useAssets`, `useRegime`, `useRotation`, `useSectors`, `useNews`, `useSignals`. Each returns mock data via a fake async fetch (250–500ms) so skeletons show and a real REST layer drops in later.
- **Types** in `src/lib/types.ts`; mock data in `src/lib/mock/*.ts`.

## Reusable components (`src/components/iq/`)

MetricCard, StatusBadge, ConfidenceGauge (Recharts RadialBar), AssetCard, MarketCard, MiniChart, Heatmap, SignalCard, NewsImpactCard, RotationFlow, DataTable, Timeline, Sparkline, Change (colored delta), SkeletonCard, EmptyState, ErrorState, SectionHeader, PageHeader, TradingViewWidget. All prop-driven, no hardcoded data.

## Motion (Framer Motion)

- Card mount: 8px fade+rise, 180ms, staggered by 30ms per row.
- Hover: `y: -1`, shadow lift.
- Route change: 120ms opacity fade on main content.
- No layout animations, no springs on numbers — keep it calm.

## UX polish

- Skeleton loaders for every query while pending (real, via TanStack Query `isPending`).
- Positive/negative changes colored via `<Change />`.
- Keyboard-accessible controls; focus rings use `--ring`.
- All numbers `tabular-nums`.

## Technical setup

- `bun add zustand framer-motion recharts`.
- Extend `src/styles.css` with IQ tokens and register under `@theme inline`.
- Add Inter + JetBrains Mono `<link>` tags in `__root.tsx` head.
- Force `dark` class on `<html>` in the root shell.
- TradingView widget: script-tag injection inside a `useEffect`, cleaned up on unmount, dark theme, ticker driven by prop.

## Out of scope

No backend, no auth, no real market data, no Lovable Cloud.
