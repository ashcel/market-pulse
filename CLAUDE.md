# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun is the package manager (`bun.lock`, `bunfig.toml`).

- `bun run dev` — start the dev server (Vite)
- `bun run build` — production build (Nitro, `node-server` preset)
- `bun run lint` — ESLint
- `bun run format` — Prettier (writes)

There is no test suite.

`bunfig.toml` enforces a 24h supply-chain guard: package versions published less than a day ago are skipped at install. Confirm with the user before adding any package to `minimumReleaseAgeExcludes`.

## Lovable integration

This project is connected to [Lovable](https://lovable.dev). Never rewrite published git history (no force pushes, or rebasing/amending/squashing already-pushed commits) — it destroys the user's Lovable project history. Pushed commits sync back into the Lovable editor, so keep the branch in a working state.

`vite.config.ts` uses `@lovable.dev/vite-tanstack-config`, which already bundles tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro, the `@` path alias, and more. Do **not** add these plugins manually — duplicates break the app. Extra config goes through its `defineConfig({ vite: { ... } })` wrapper.

## Routing (TanStack Start)

File-based routing lives in `src/routes/` — do not create `src/pages/` or Next.js/Remix-style layouts. The only root layout is `src/routes/__root.tsx` (app shell: `Sidebar` / `TopBar` / `BottomNav` around `<Outlet />`; also provides the `QueryClient` via router context). Conventions:

- `index.tsx` → `/`, `token.$symbol.tsx` → `/token/:symbol` (bare `$`, no curly braces)
- `routes/api/*.ts` files are server routes using `createFileRoute` with `server.handlers` (see `src/routes/api/klines.ts`)
- `src/routeTree.gen.ts` is auto-generated — never edit by hand

## Architecture

Mobile-first crypto market-intelligence dashboard ("IQ"). There are **two live data paths**, both fed by Binance klines with a deterministic demo fallback (`mock-candles.ts`) through the same pipeline:

1. **Market snapshot** — `src/lib/engine/market.ts` defines the tracked `UNIVERSE` (18 Binance USDT pairs bucketed into Majors/Layer 1/DeFi/AI/Meme sectors) and a server function that computes one `MarketSnapshot` from 1H klines (+ BTC 1D): per-asset quant scores and engine decisions, market regime + pillars + timeline, sector rotation, heatmap, volatility (BTC ATR%), and Fear & Greed sentiment (alternative.me, cached; computed fallback). It caches server-side (~45s). `src/hooks/queries/index.ts` exposes one `useMarketSnapshot` query (refetch interval from the preferences store) and all page hooks (`useAssets`, `useRegime`, `useRotation`, …) are selectors over it — every dashboard page (`index`, `markets`, `rankings`, `regime`, `rotation`, `technical`) reads from this single snapshot. News is still a curated sample in `src/lib/mock/news.ts`.

2. **Token signal engine** — `src/lib/engine/` powers the token detail page (`token.$symbol.tsx`) via `src/hooks/useTokenSignal.ts`:
   - `binance.ts` has three fetch tiers: `fetchBinanceKlinesDirect` (raw fetch to Binance klines, always appends `USDT`, returns `[]` on any failure), `fetchBinanceKlinesServer` (a `createServerFn` wrapper so the call runs server-side), and `fetchBinanceKlines` (the client-facing helper). `/api/klines` exposes the direct fetch as an HTTP endpoint.
   - `useTokenSignal` fetches live candles, and if that returns empty, falls back to deterministic mock candles (`mock-candles.ts`) with `source: "demo"` — UI should surface live vs. demo.
   - `analysis.ts` computes prominence-ranked pivots and support/resistance trend lines; `quant.ts` (`evaluateSignal`) is the scoring engine producing trade decisions, setup types, market regimes, and a per-token backtest summary; `crypto-config.ts` holds risk settings. `market.ts` reuses this same engine per universe asset.

Other structure:

- `src/components/ui/` — shadcn/ui primitives (new-york style, configured in `components.json`); `src/components/iq/` — app-specific components (cards, charts, nav, TradingView widget).
- `src/stores/` — zustand stores with `persist` middleware (preferences, watchlist, UI state).
- Styling is Tailwind v4 via `src/styles.css` (CSS variables, dark-mode shell); charts use `lightweight-charts` and `recharts`.
- Path alias: `@/` → `src/`.
