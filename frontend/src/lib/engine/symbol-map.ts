import type { MarketType } from "./binance";

export interface ExchangeSymbol {
  /** Exact exchange-facing symbol, e.g. "1000PEPEUSDT". */
  symbol: string;
  /** Raw price fields must be divided by this, raw base-asset volume multiplied by it. */
  priceScale: number;
}

// Binance quotes a handful of low-unit-price bases as a fixed multiple of the
// real token on USDS-M futures only — spot lists the bare ticker, futures
// renames the base asset and scales the quoted price. Confirmed against live
// fapi.binance.com/fapi/v1/exchangeInfo. Add overrides here, never inline —
// this table is the single place that knows about the rename.
const FUTURES_BASE_OVERRIDES: Record<string, { base: string; scale: number }> = {
  PEPE: { base: "1000PEPE", scale: 1000 },
  SHIB: { base: "1000SHIB", scale: 1000 },
  XEC: { base: "1000XEC", scale: 1000 },
  LUNC: { base: "1000LUNC", scale: 1000 },
  FLOKI: { base: "1000FLOKI", scale: 1000 },
  BONK: { base: "1000BONK", scale: 1000 },
  SATS: { base: "1000SATS", scale: 1000 },
  RATS: { base: "1000RATS", scale: 1000 },
  CAT: { base: "1000CAT", scale: 1000 },
  MOG: { base: "1000000MOG", scale: 1_000_000 },
  X: { base: "1000X", scale: 1000 },
  CHEEMS: { base: "1000CHEEMS", scale: 1000 },
  WHY: { base: "1000WHY", scale: 1000 },
  BOB: { base: "1000000BOB", scale: 1_000_000 },
};

/** Strips everything but letters/digits and uppercases — the one ticker-normalization rule. */
export function normalizeTicker(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/** Resolves an internal ticker to the exact exchange symbol + price-scale for a market. */
export function resolveExchangeSymbol(rawTicker: string, market: MarketType): ExchangeSymbol {
  const ticker = normalizeTicker(rawTicker);
  const override = market === "perp" ? FUTURES_BASE_OVERRIDES[ticker] : undefined;
  if (override) return { symbol: `${override.base}USDT`, priceScale: override.scale };
  return { symbol: `${ticker}USDT`, priceScale: 1 };
}
