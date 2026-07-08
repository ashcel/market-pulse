import { createServerFn } from "@tanstack/react-start";

import { fetchBinanceKlinesDirect } from "./binance";

/**
 * Perpetual-futures positioning context: funding rate + open interest, the two
 * inputs a perp trader reads before anything else. Funding tells you which side
 * is crowded (and therefore at squeeze risk); open interest tells you whether a
 * move has fresh money behind it or is just position-unwinding. Spot has
 * neither, so this is only fetched in perp mode.
 */

const FAPI_BASE = "https://fapi.binance.com";

// 8h funding rate, as a decimal. Binance's baseline is ~0.01% (0.0001). Beyond
// ~0.05% one side is clearly paying up to hold — crowded; ~0.1%+ is the kind of
// extreme that precedes a squeeze. Annualized ≈ rate × 3 × 365 (≈ ×1095).
const FUNDING_ELEVATED = 0.0005;
const FUNDING_EXTREME = 0.001;

// Open-interest change over the sampled window (24×1h). A couple of percent is
// noise; beyond it, positioning is meaningfully building or unwinding.
const OI_TREND_PCT = 2;

export type FundingBias = "neutral" | "longs-crowded" | "shorts-crowded";
export type OiTrend = "rising" | "falling" | "flat";
/** Whether open interest says the current move has fresh conviction behind it. */
export type PerpConviction = "building" | "unwinding" | "neutral";

export interface PerpMetrics {
  /** Last settled 8h funding rate, as a decimal (0.0001 = 0.01%). */
  fundingRate: number;
  /** Funding expressed as an annualized percentage, for readability. */
  fundingAnnualizedPct: number;
  /** Epoch ms of the next funding settlement. */
  nextFundingMs: number;
  markPrice: number;
  /** Latest open-interest notional, in USDT. */
  openInterestValue: number;
  /** Open-interest change over the sampled window, percent. */
  oiChangePct: number;
  /** Price change over the same window, percent — pairs with OI for conviction. */
  priceChangePct: number;
}

export interface PerpRead extends PerpMetrics {
  fundingBias: FundingBias;
  /** Funding is beyond the extreme threshold — squeeze-prone. */
  fundingExtreme: boolean;
  oiTrend: OiTrend;
  conviction: PerpConviction;
  /** Compact one-line summary, e.g. "Longs crowded · OI building". */
  label: string;
  /** Plain-English read for the tooltip / verdict note. */
  note: string;
}

function fundingBiasOf(rate: number): FundingBias {
  if (rate > FUNDING_ELEVATED) return "longs-crowded";
  if (rate < -FUNDING_ELEVATED) return "shorts-crowded";
  return "neutral";
}

function oiTrendOf(changePct: number): OiTrend {
  if (changePct > OI_TREND_PCT) return "rising";
  if (changePct < -OI_TREND_PCT) return "falling";
  return "flat";
}

function fundingLabel(bias: FundingBias): string {
  if (bias === "longs-crowded") return "Longs crowded";
  if (bias === "shorts-crowded") return "Shorts crowded";
  return "Funding neutral";
}

function formatApr(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}% APR`;
}

/** Turn raw funding + OI + price numbers into a directional positioning read. */
export function interpretPerp(metrics: PerpMetrics): PerpRead {
  const fundingBias = fundingBiasOf(metrics.fundingRate);
  const fundingExtreme = Math.abs(metrics.fundingRate) >= FUNDING_EXTREME;
  const oiTrend = oiTrendOf(metrics.oiChangePct);
  const conviction: PerpConviction =
    oiTrend === "rising" ? "building" : oiTrend === "falling" ? "unwinding" : "neutral";

  const oiWord = oiTrend === "rising" ? "building" : oiTrend === "falling" ? "unwinding" : "flat";
  const label = `${fundingLabel(fundingBias)} · OI ${oiWord}`;

  // OI + price direction says who is actually adding: rising OI with rising
  // price is fresh longs; rising OI with falling price is fresh shorts.
  const priceUp = metrics.priceChangePct >= 0;
  let convictionNote: string;
  if (oiTrend === "rising") {
    convictionNote = priceUp
      ? "Open interest is rising into the move — fresh longs are adding, so the advance has real money behind it."
      : "Open interest is rising as price falls — fresh shorts are pressing, so the decline has conviction behind it.";
  } else if (oiTrend === "falling") {
    convictionNote = priceUp
      ? "Open interest is falling as price rises — this looks like short-covering more than fresh buying, so trust the follow-through less."
      : "Open interest is falling with price — positions are being closed out, so the move is losing fuel rather than building.";
  } else {
    convictionNote = "Open interest is flat — no clear build-up or unwind in positioning.";
  }

  let fundingNote: string;
  if (fundingBias === "neutral") {
    fundingNote = `Funding is balanced (${formatApr(metrics.fundingAnnualizedPct)}) — neither side is paying up to hold.`;
  } else {
    const side = fundingBias === "longs-crowded" ? "Longs" : "Shorts";
    const risk = fundingBias === "longs-crowded" ? "a flush lower" : "a squeeze higher";
    fundingNote = `${side} are paying to stay in (${formatApr(metrics.fundingAnnualizedPct)})${
      fundingExtreme ? " — an extreme reading" : ""
    }, so positioning is crowded ${
      fundingBias === "longs-crowded" ? "long" : "short"
    } and vulnerable to ${risk}.`;
  }

  return {
    ...metrics,
    fundingBias,
    fundingExtreme,
    oiTrend,
    conviction,
    label,
    note: `${fundingNote} ${convictionNote}`,
  };
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/**
 * Fetch and interpret the live perp positioning context for a symbol. Any leg
 * failing (network, delisted-on-futures, bad payload) collapses to null so the
 * caller simply omits the context rather than erroring — spot has no funding/OI
 * either, and the verdict must still stand without it.
 */
export async function fetchPerpContextDirect(symbol: string): Promise<PerpRead | null> {
  const ticker = normalizeSymbol(symbol);
  if (!ticker) return null;
  const pair = `${ticker}USDT`;

  try {
    const [premiumRes, oiRes, candles] = await Promise.all([
      fetch(`${FAPI_BASE}/fapi/v1/premiumIndex?symbol=${pair}`),
      fetch(`${FAPI_BASE}/futures/data/openInterestHist?symbol=${pair}&period=1h&limit=24`),
      fetchBinanceKlinesDirect({ symbol: ticker, timeframe: "1H", limit: 24, market: "perp" }),
    ]);

    if (!premiumRes.ok) return null;
    const premium = (await premiumRes.json()) as {
      lastFundingRate?: string;
      nextFundingTime?: number;
      markPrice?: string;
    };
    const fundingRate = num(premium.lastFundingRate);
    const markPrice = num(premium.markPrice);
    if (!Number.isFinite(fundingRate) || !Number.isFinite(markPrice)) return null;

    // Open-interest history is best-effort: if it fails we still return funding
    // with a flat OI trend rather than dropping the whole context.
    let openInterestValue = NaN;
    let oiChangePct = 0;
    if (oiRes.ok) {
      const oiHist = (await oiRes.json()) as Array<{ sumOpenInterestValue?: string }>;
      if (Array.isArray(oiHist) && oiHist.length >= 2) {
        const first = num(oiHist[0].sumOpenInterestValue);
        const last = num(oiHist[oiHist.length - 1].sumOpenInterestValue);
        if (Number.isFinite(first) && Number.isFinite(last) && first > 0) {
          openInterestValue = last;
          oiChangePct = ((last - first) / first) * 100;
        }
      }
    }

    const priceChangePct =
      candles.length >= 2 && candles[0].close > 0
        ? ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100
        : 0;

    return interpretPerp({
      fundingRate,
      fundingAnnualizedPct: fundingRate * 3 * 365 * 100,
      nextFundingMs: Number(premium.nextFundingTime) || 0,
      markPrice,
      openInterestValue: Number.isFinite(openInterestValue) ? openInterestValue : 0,
      oiChangePct,
      priceChangePct,
    });
  } catch {
    return null;
  }
}

export const fetchPerpContextServer = createServerFn({ method: "GET" })
  .validator((data: { symbol: string }) => ({
    symbol: typeof data?.symbol === "string" ? data.symbol : "",
  }))
  .handler(async ({ data }) => fetchPerpContextDirect(data.symbol));

export async function fetchPerpContext(symbol: string): Promise<PerpRead | null> {
  try {
    return await fetchPerpContextServer({ data: { symbol } });
  } catch {
    return null;
  }
}
