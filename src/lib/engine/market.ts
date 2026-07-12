import { createServerFn } from "@tanstack/react-start";

import type {
  Asset,
  MarketRegimeData,
  RotationData,
  Sector,
  SentimentData,
  Signal,
  TechnicalData,
  VolatilityData,
} from "../types";
import { computePivots } from "./analysis";
import { dropUnclosedCandle, fetchBinanceKlinesDirect, type MarketType } from "./binance";
import { computeRelativeRead } from "./relative";
import { CRYPTO_RISK_SETTINGS } from "./crypto-config";
import { generateMockCandles } from "./mock-candles";
import { classifyRegime, evaluateSignal } from "./quant";
import type { SignalEvaluation } from "./quant";
import type { Candle } from "./types";

export interface UniverseEntry {
  ticker: string;
  name: string;
  sector: string;
}

// Curated Binance USDT spot universe, bucketed the way capital actually rotates.
export const UNIVERSE: UniverseEntry[] = [
  { ticker: "BTC", name: "Bitcoin", sector: "Majors" },
  { ticker: "ETH", name: "Ethereum", sector: "Majors" },
  { ticker: "SOL", name: "Solana", sector: "Layer 1" },
  { ticker: "BNB", name: "BNB Chain", sector: "Layer 1" },
  { ticker: "XRP", name: "XRP", sector: "Layer 1" },
  { ticker: "ADA", name: "Cardano", sector: "Layer 1" },
  { ticker: "AVAX", name: "Avalanche", sector: "Layer 1" },
  { ticker: "SUI", name: "Sui", sector: "Layer 1" },
  { ticker: "NEAR", name: "NEAR Protocol", sector: "Layer 1" },
  { ticker: "LINK", name: "Chainlink", sector: "DeFi" },
  { ticker: "UNI", name: "Uniswap", sector: "DeFi" },
  { ticker: "AAVE", name: "Aave", sector: "DeFi" },
  { ticker: "FET", name: "Artificial Superintelligence", sector: "AI" },
  { ticker: "RENDER", name: "Render", sector: "AI" },
  { ticker: "TAO", name: "Bittensor", sector: "AI" },
  { ticker: "DOGE", name: "Dogecoin", sector: "Meme" },
  { ticker: "PEPE", name: "Pepe", sector: "Meme" },
  { ticker: "WIF", name: "dogwifhat", sector: "Meme" },
];

export const SECTOR_ORDER = ["Majors", "Layer 1", "DeFi", "AI", "Meme"];

/**
 * Worker-only sampling extension (P2.1, EDR 0011). The forward-test worker
 * evaluates `WORKER_UNIVERSE` = dashboard `UNIVERSE` + these, roughly tripling
 * evidence throughput; the dashboard/rotation product surface stays on the
 * curated 18. Sampling-frame change only — per-symbol decision semantics are
 * untouched, so no ENGINE_VERSION bump; `engine_run.universe_json` records the
 * evaluated set per pass and every record carries its symbol, keeping cohorts
 * separable. Every ticker verified TRADING on BOTH Binance spot and USDS-M
 * futures on 2026-07-12 (futures 1000x renames handled by symbol-map.ts).
 */
export const WORKER_UNIVERSE_EXTENSION: UniverseEntry[] = [
  { ticker: "LTC", name: "Litecoin", sector: "Layer 1" },
  { ticker: "BCH", name: "Bitcoin Cash", sector: "Layer 1" },
  { ticker: "ETC", name: "Ethereum Classic", sector: "Layer 1" },
  { ticker: "DOT", name: "Polkadot", sector: "Layer 1" },
  { ticker: "ATOM", name: "Cosmos", sector: "Layer 1" },
  { ticker: "FIL", name: "Filecoin", sector: "Layer 1" },
  { ticker: "APT", name: "Aptos", sector: "Layer 1" },
  { ticker: "ARB", name: "Arbitrum", sector: "Layer 1" },
  { ticker: "OP", name: "Optimism", sector: "Layer 1" },
  { ticker: "TRX", name: "TRON", sector: "Layer 1" },
  { ticker: "XLM", name: "Stellar", sector: "Layer 1" },
  { ticker: "HBAR", name: "Hedera", sector: "Layer 1" },
  { ticker: "ICP", name: "Internet Computer", sector: "Layer 1" },
  { ticker: "TIA", name: "Celestia", sector: "Layer 1" },
  { ticker: "SEI", name: "Sei", sector: "Layer 1" },
  { ticker: "ALGO", name: "Algorand", sector: "Layer 1" },
  { ticker: "STX", name: "Stacks", sector: "Layer 1" },
  { ticker: "INJ", name: "Injective", sector: "DeFi" },
  { ticker: "LDO", name: "Lido DAO", sector: "DeFi" },
  { ticker: "CRV", name: "Curve", sector: "DeFi" },
  { ticker: "RUNE", name: "THORChain", sector: "DeFi" },
  { ticker: "ENA", name: "Ethena", sector: "DeFi" },
  { ticker: "ONDO", name: "Ondo", sector: "DeFi" },
  { ticker: "JUP", name: "Jupiter", sector: "DeFi" },
  { ticker: "ETHFI", name: "Ether.fi", sector: "DeFi" },
  { ticker: "GRT", name: "The Graph", sector: "AI" },
  { ticker: "WLD", name: "Worldcoin", sector: "AI" },
  { ticker: "AR", name: "Arweave", sector: "AI" },
  { ticker: "SHIB", name: "Shiba Inu", sector: "Meme" },
  { ticker: "BONK", name: "Bonk", sector: "Meme" },
  { ticker: "IMX", name: "Immutable", sector: "Gaming" },
  { ticker: "ZEC", name: "Zcash", sector: "Privacy" },
];

/** The set the forward-test worker actually evaluates. Superset of UNIVERSE. */
export const WORKER_UNIVERSE: UniverseEntry[] = [...UNIVERSE, ...WORKER_UNIVERSE_EXTENSION];

export function tradingViewSymbol(ticker: string): string {
  return `BINANCE:${ticker.toUpperCase()}USDT`;
}

export interface AssetSignals {
  signals: Signal[];
  confidence: number;
  /** Backtest statistics for this ticker's detected setup, when available. */
  backtest?: { winRate: number; lowSample: boolean };
}

export interface MarketSnapshot {
  source: "live" | "demo";
  updatedAt: string;
  assets: Asset[];
  regime: MarketRegimeData;
  rotation: RotationData;
  sectors: Sector[];
  sentiment: SentimentData;
  technical: TechnicalData;
  volatility: VolatilityData;
  assetSignals: Record<string, AssetSignals>;
}

const HOURS_24 = 24;
const HOURS_7D = 168;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function smaAt(candles: Candle[], length: number): number | null {
  if (candles.length < length) return null;
  return mean(candles.slice(-length).map((c) => c.close));
}

function atrPercent(candles: Candle[], length = 14): number | null {
  if (candles.length < length + 1) return null;
  const ranges: number[] = [];
  for (let i = candles.length - length; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    ranges.push(
      Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)),
    );
  }
  const lastClose = candles[candles.length - 1].close;
  if (!lastClose) return null;
  return (mean(ranges) / lastClose) * 100;
}

function changeOverBars(candles: Candle[], bars: number): number {
  const lastCandle = candles.at(-1);
  if (!lastCandle) return 0;
  const base = candles[Math.max(0, candles.length - 1 - bars)];
  if (!base || base.close === 0) return 0;
  return round(((lastCandle.close - base.close) / base.close) * 100, 2);
}

/** Squashes an unbounded % move into a 0-100 score centred at 50. */
function tanhScore(value: number, scale: number): number {
  return clamp(round(50 + 50 * Math.tanh(value / scale)), 0, 100);
}

function titleCase(slug: string): string {
  return slug.replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ScoredAsset {
  asset: Asset;
  evaluation: SignalEvaluation;
  aboveWeeklyMean: boolean;
  volumeRatio: number;
}

function scoreAsset(entry: UniverseEntry, candles: Candle[]): ScoredAsset {
  const close = candles.at(-1)?.close ?? 0;
  const change24h = changeOverBars(candles, HOURS_24);
  const change7d = changeOverBars(candles, HOURS_7D);

  const momentum = round(0.6 * tanhScore(change24h, 6) + 0.4 * tanhScore(change7d, 15));

  const ma24 = smaAt(candles, 24);
  const ma72 = smaAt(candles, 72);
  const ma168 = smaAt(candles, HOURS_7D);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangePos = rangeHigh > rangeLow ? (close - rangeLow) / (rangeHigh - rangeLow) : 0.5;
  const strength = clamp(
    round(
      40 +
        (ma24 !== null ? (close > ma24 ? 10 : -10) : 0) +
        (ma72 !== null ? (close > ma72 ? 10 : -10) : 0) +
        (ma168 !== null ? (close > ma168 ? 10 : -10) : 0) +
        rangePos * 20,
    ),
    0,
    100,
  );

  const vol24 = candles.slice(-HOURS_24).reduce((sum, c) => sum + c.volume, 0);
  const priorWindows = candles.slice(-HOURS_7D, -HOURS_24);
  const priorPerDay =
    priorWindows.length >= HOURS_24
      ? (priorWindows.reduce((sum, c) => sum + c.volume, 0) / priorWindows.length) * HOURS_24
      : vol24;
  const volumeRatio = priorPerDay > 0 ? vol24 / priorPerDay : 1;
  const volumeScore = tanhScore((volumeRatio - 1) * 100, 80);

  const pivots = computePivots(candles);
  const evaluation = evaluateSignal(entry.ticker, candles, pivots, CRYPTO_RISK_SETTINGS);
  const technical = evaluation.confidence;

  const quoteVolume24h = candles.slice(-HOURS_24).reduce((sum, c) => sum + c.volume * c.close, 0);
  const spark = candles.slice(-48).map((c, i) => ({ t: i, v: c.close }));

  const asset: Asset = {
    id: entry.ticker.toLowerCase(),
    ticker: entry.ticker,
    name: entry.name,
    category: "crypto",
    sector: entry.sector,
    price: close,
    change24h,
    change7d,
    quoteVolume24h: Math.round(quoteVolume24h),
    spark,
    momentum,
    strength,
    volume: volumeScore,
    technical,
    confidence: round(0.5 * technical + 0.25 * momentum + 0.25 * strength),
    score: round(0.3 * momentum + 0.25 * strength + 0.25 * technical + 0.2 * volumeScore),
    decision: evaluation.decision,
    setupType: evaluation.setupType,
  };

  return {
    asset,
    evaluation,
    aboveWeeklyMean: ma168 !== null ? close > ma168 : change7d > 0,
    volumeRatio,
  };
}

function signalsFor(scored: ScoredAsset): AssetSignals {
  const e = scored.evaluation;
  const statusMap: Record<string, Signal["status"]> = {
    pass: "bullish",
    fail: "bearish",
    warning: "warning",
    neutral: "neutral",
  };
  const decisionStatus: Signal["status"] =
    e.decision === "buy-candidate"
      ? "bullish"
      : e.decision === "short-candidate" || e.decision === "invalidated"
        ? "bearish"
        : "warning";
  const regimeStatus: Signal["status"] =
    e.regime === "trending-up"
      ? "bullish"
      : e.regime === "trending-down"
        ? "bearish"
        : e.regime === "high-volatility" || e.regime === "choppy"
          ? "warning"
          : "neutral";

  const signals: Signal[] = [
    { label: "Decision", value: titleCase(e.decision), status: decisionStatus, detail: e.reason },
    {
      label: "Setup",
      value: titleCase(e.setupType),
      status: e.setupType === "no-clear-setup" ? "neutral" : decisionStatus,
      detail: `Engine-classified structure on 1H bars.`,
    },
    {
      label: "Regime",
      value: titleCase(e.regime),
      status: regimeStatus,
      detail: `ATR ${e.analytics.atrPercent ?? "–"}% of price.`,
    },
    {
      label: "Structure",
      value:
        e.structure.trend === "uptrend"
          ? "Uptrend (HH/HL)"
          : e.structure.trend === "downtrend"
            ? "Downtrend (LH/LL)"
            : "Range",
      status:
        e.structure.trend === "uptrend"
          ? "bullish"
          : e.structure.trend === "downtrend"
            ? "bearish"
            : "neutral",
      detail: `Swing legs on 1H bars read ${e.structure.lastHigh?.label ?? "–"} high / ${e.structure.lastLow?.label ?? "–"} low${
        e.structure.event ? `; latest break: ${e.structure.event === "bos" ? "BOS" : "CHoCH"}` : ""
      }.`,
    },
    ...e.components.map((c) => ({
      label: c.name,
      value:
        c.status === "pass"
          ? "Confirmed"
          : c.status === "warning"
            ? "Caution"
            : c.status === "fail"
              ? "Failed"
              : "Neutral",
      status: statusMap[c.status] ?? "neutral",
      detail: c.explanation,
    })),
  ];
  return {
    signals,
    confidence: e.confidence,
    backtest:
      e.backtest.totalTrades > 0
        ? { winRate: e.backtest.winRate, lowSample: e.backtest.lowSample }
        : undefined,
  };
}

function buildRegime(
  btcDaily: Candle[],
  scored: ScoredAsset[],
): {
  regime: MarketRegimeData;
  breadth: number;
  avgMomentum: number;
  volScore: number;
  atrPctDaily: number;
} {
  const btcRegime = classifyRegime(btcDaily);
  const trendScoreMap: Record<string, number> = {
    "trending-up": 85,
    "breakout-compression": 62,
    "low-volatility": 55,
    "range-bound": 52,
    "mean-reversion": 48,
    choppy: 42,
    "high-volatility": 35,
    "trending-down": 18,
  };
  const trendScore = trendScoreMap[btcRegime] ?? 50;

  const nAbove = scored.filter((s) => s.aboveWeeklyMean).length;
  const breadth = round((nAbove / Math.max(1, scored.length)) * 100);
  const avgMomentum = round(mean(scored.map((s) => s.asset.momentum ?? 50)));
  const atrPctDaily = atrPercent(btcDaily) ?? 3;
  const volScore = clamp(round(115 - atrPctDaily * 18), 5, 95);
  const participating = scored.filter((s) => s.volumeRatio > 1).length;
  const participation = round((participating / Math.max(1, scored.length)) * 100);
  const totalQuote = scored.reduce((sum, s) => sum + (s.asset.quoteVolume24h ?? 0), 0);
  const avg24 = round(mean(scored.map((s) => s.asset.change24h)), 2);
  const avg7 = round(mean(scored.map((s) => s.asset.change7d ?? 0)), 2);

  const riskScore = round(0.35 * trendScore + 0.25 * breadth + 0.2 * avgMomentum + 0.2 * volScore);
  const label: MarketRegimeData["regime"] =
    riskScore >= 60 ? "Risk On" : riskScore <= 42 ? "Risk Off" : "Neutral";

  const timeline: MarketRegimeData["timeline"] = [];
  const sessions = Math.min(60, Math.max(0, btcDaily.length - 21));
  for (let i = btcDaily.length - sessions; i < btcDaily.length; i++) {
    const window = btcDaily.slice(0, i + 1);
    const ma20 = smaAt(window, 20);
    const close = window[window.length - 1].close;
    if (!ma20 || !close) continue;
    const dist = ((close - ma20) / ma20) * 100;
    const value = clamp(round(50 + dist * 3, 1), 4, 96);
    timeline.push({
      t: timeline.length,
      value,
      regime: value > 60 ? "Risk On" : value >= 40 ? "Neutral" : "Risk Off",
    });
  }

  const pillarStatus = (score: number): "bullish" | "bearish" | "neutral" =>
    score >= 60 ? "bullish" : score <= 40 ? "bearish" : "neutral";
  const regime: MarketRegimeData = {
    regime: label,
    confidence: clamp(round(48 + Math.abs(riskScore - 50) * 1.6), 45, 97),
    trendStrength:
      Math.abs(riskScore - 50) > 20 ? "High" : Math.abs(riskScore - 50) > 10 ? "Medium" : "Low",
    timeline,
    pillars: [
      {
        label: "Trend",
        score: trendScore,
        status: pillarStatus(trendScore),
        description: `BTC daily structure reads ${titleCase(btcRegime).toLowerCase()}; trend is the heaviest input to the regime call.`,
      },
      {
        label: "Breadth",
        score: breadth,
        status: pillarStatus(breadth),
        description: `${nAbove} of ${scored.length} tracked assets trade above their 7-day average price.`,
      },
      {
        label: "Volatility",
        score: volScore,
        status: pillarStatus(volScore),
        description: `BTC 14-day ATR is ${round(atrPctDaily, 1)}% of price${atrPctDaily > 4.2 ? " — expect wide swings" : ""}.`,
      },
      {
        label: "Momentum",
        score: avgMomentum,
        status: pillarStatus(avgMomentum),
        description: `Universe averages ${avg24 >= 0 ? "+" : ""}${avg24}% over 24h and ${avg7 >= 0 ? "+" : ""}${avg7}% over 7 days.`,
      },
      {
        label: "Participation",
        score: participation,
        status: pillarStatus(participation),
        description: `${participation}% of assets printing above-average volume; ~$${formatBillions(totalQuote)} traded in 24h.`,
      },
    ],
  };

  return { regime, breadth, avgMomentum, volScore, atrPctDaily };
}

function formatBillions(value: number): string {
  if (value >= 1e9) return `${round(value / 1e9, 1)}B`;
  if (value >= 1e6) return `${round(value / 1e6, 1)}M`;
  return `${Math.round(value).toLocaleString()}`;
}

function rankIndex(values: Array<[string, number]>): Map<string, number> {
  const sorted = [...values].sort((a, b) => b[1] - a[1]);
  return new Map(sorted.map(([name], i) => [name, i]));
}

function buildRotation(scored: ScoredAsset[]): { rotation: RotationData; sectors: Sector[] } {
  const bySector = new Map<string, ScoredAsset[]>();
  for (const s of scored) {
    const key = s.asset.sector ?? "Other";
    bySector.set(key, [...(bySector.get(key) ?? []), s]);
  }

  const stats = SECTOR_ORDER.filter((name) => bySector.has(name)).map((name) => {
    const items = bySector.get(name) ?? [];
    return {
      name,
      avg24: round(mean(items.map((i) => i.asset.change24h)), 2),
      avg7: round(mean(items.map((i) => i.asset.change7d ?? 0)), 2),
    };
  });

  // Money exits the weakest bucket and chases the strongest: order losers → winners.
  const ordered = [...stats].sort((a, b) => a.avg24 - b.avg24);
  const min = ordered[0]?.avg24 ?? 0;
  const max = ordered[ordered.length - 1]?.avg24 ?? 0;
  const spread = Math.max(0.0001, max - min);

  const flow = ordered.map((s) => s.name);
  const legs = ordered.slice(0, -1).map((s, i) => ({
    from: s.name,
    to: ordered[i + 1].name,
    strength: clamp(round(((s.avg24 - min) / spread) * 100), 0, 100),
  }));

  const rank24 = rankIndex(stats.map((s) => [s.name, s.avg24]));
  const rank7 = rankIndex(stats.map((s) => [s.name, s.avg7]));
  const n = stats.length;
  let dSquared = 0;
  for (const s of stats) {
    const d = (rank24.get(s.name) ?? 0) - (rank7.get(s.name) ?? 0);
    dSquared += d * d;
  }
  const rho = n > 1 ? 1 - (6 * dSquared) / (n * (n * n - 1)) : 0;

  const winning = ordered[ordered.length - 1];
  const losing = ordered[0];
  const rotation: RotationData = {
    flow,
    legs,
    strength: spread >= 3 ? "High" : spread >= 1.2 ? "Medium" : "Low",
    confidence: clamp(round(55 + rho * 40), 30, 95),
    winning: winning?.name ?? "—",
    losing: losing?.name ?? "—",
    winningChange: winning?.avg24,
    losingChange: losing?.avg24,
  };

  const sectors: Sector[] = scored.map((s) => ({
    group: (s.asset.sector ?? "Other").toUpperCase(),
    ticker: s.asset.ticker,
    name: s.asset.name,
    change: s.asset.change24h,
  }));

  return { rotation, sectors };
}

function buildVolatility(btcDaily: Candle[]): VolatilityData {
  const spark: VolatilityData["spark"] = [];
  const sessions = Math.min(40, Math.max(0, btcDaily.length - 15));
  for (let i = btcDaily.length - sessions; i < btcDaily.length; i++) {
    const value = atrPercent(btcDaily.slice(0, i + 1));
    if (value !== null) spark.push({ t: spark.length, v: round(value, 2) });
  }
  const current = spark.at(-1)?.v ?? 3;
  const weekAgo = spark.at(-8)?.v ?? current;
  return {
    label: current < 2.2 ? "Low" : current < 4.2 ? "Medium" : "High",
    vix: current,
    change: weekAgo ? round(((current - weekAgo) / weekAgo) * 100, 2) : 0,
    spark,
  };
}

async function fetchFearGreed(): Promise<number | null> {
  try {
    const response = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: Array<{ value?: string }> };
    const value = Number(payload.data?.[0]?.value);
    return Number.isFinite(value) ? clamp(value, 0, 100) : null;
  } catch {
    return null;
  }
}

function buildSnapshot(
  hourly: Map<string, Candle[]>,
  btcDaily: Candle[],
  source: "live" | "demo",
  fearGreed: number | null,
): MarketSnapshot {
  const seriesFor = (ticker: string): Candle[] => {
    const candles = hourly.get(ticker);
    return candles && candles.length >= 48 ? candles : generateMockCandles(ticker, "1H");
  };
  const btcHourly = seriesFor("BTC");
  const scored = UNIVERSE.map((entry) => {
    const candles = seriesFor(entry.ticker);
    const s = scoreAsset(entry, candles);
    // Relative strength + correlation vs BTC — display-only fields computed
    // from the exact series the asset was scored on (relative.ts).
    Object.assign(s.asset, computeRelativeRead(candles, btcHourly));
    return s;
  });

  const { regime, breadth, avgMomentum } = buildRegime(btcDaily, scored);
  const { rotation, sectors } = buildRotation(scored);
  const volatility = buildVolatility(btcDaily);

  const fg = fearGreed ?? round(0.5 * breadth + 0.5 * avgMomentum);
  const sentiment: SentimentData = {
    label: fg >= 60 ? "Bullish" : fg <= 40 ? "Bearish" : "Neutral",
    score: fg,
    fearGreed: fg,
  };

  const avgTechnical = round(mean(scored.map((s) => s.asset.technical ?? 50)));
  const technical: TechnicalData = {
    label: avgTechnical >= 65 ? "Strong" : avgTechnical <= 45 ? "Weak" : "Mixed",
    score: avgTechnical,
  };

  const assetSignals: Record<string, AssetSignals> = {};
  for (const s of scored) assetSignals[s.asset.ticker] = signalsFor(s);

  const assets = [...scored.map((s) => s.asset)].sort((a, b) => b.score - a.score);

  return {
    source,
    updatedAt: new Date().toISOString(),
    assets,
    regime,
    rotation,
    sectors,
    sentiment,
    technical,
    volatility,
    assetSignals,
  };
}

export function buildDemoSnapshot(): MarketSnapshot {
  const hourly = new Map<string, Candle[]>();
  for (const entry of UNIVERSE) hourly.set(entry.ticker, generateMockCandles(entry.ticker, "1H"));
  return buildSnapshot(hourly, generateMockCandles("BTC", "1D", 120), "demo", null);
}

// One cache entry per market — spot and perp refresh independently, so
// toggling the nav-bar switch doesn't invalidate the mode you just left.
const snapshotCache: Record<MarketType, { at: number; data: MarketSnapshot } | null> = {
  spot: null,
  perp: null,
};
let fngCache: { at: number; value: number | null } | null = null;
const SNAPSHOT_TTL_MS = 45_000;
const FNG_TTL_MS = 30 * 60_000;

async function computeSnapshot(market: MarketType = "spot"): Promise<MarketSnapshot> {
  const now = Date.now();
  const cached = snapshotCache[market];
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.data;

  const [hourlyResults, btcDailyLive] = await Promise.all([
    Promise.all(
      UNIVERSE.map(async (entry) => {
        const candles = await fetchBinanceKlinesDirect({
          symbol: entry.ticker,
          timeframe: "1H",
          limit: 200,
          market,
        });
        return [entry.ticker, dropUnclosedCandle(candles)] as const;
      }),
    ),
    fetchBinanceKlinesDirect({ symbol: "BTC", timeframe: "1D", limit: 120, market }).then(
      dropUnclosedCandle,
    ),
  ]);

  if (!fngCache || now - fngCache.at > FNG_TTL_MS) {
    fngCache = { at: now, value: await fetchFearGreed() };
  }

  const hourly = new Map<string, Candle[]>();
  let liveCount = 0;
  for (const [ticker, candles] of hourlyResults) {
    if (candles.length >= 48) {
      hourly.set(ticker, candles);
      liveCount++;
    }
  }

  // A UNIVERSE ticker Binance doesn't list on this market (or that fails to
  // fetch) simply falls back to its own mock candles inside buildSnapshot —
  // partial per-asset failure never has to fail the whole snapshot.
  const source: MarketSnapshot["source"] = liveCount >= UNIVERSE.length / 2 ? "live" : "demo";
  const btcDaily = btcDailyLive.length >= 40 ? btcDailyLive : generateMockCandles("BTC", "1D", 120);
  const snapshot = buildSnapshot(hourly, btcDaily, source, fngCache.value);
  snapshotCache[market] = { at: now, data: snapshot };
  return snapshot;
}

export const fetchMarketSnapshotServer = createServerFn({ method: "GET" })
  .validator((data: { market?: MarketType }) => ({
    market: data?.market === "perp" ? ("perp" as const) : ("spot" as const),
  }))
  .handler(async ({ data }) => computeSnapshot(data.market));

/** Client-facing helper: server snapshot, falling back to a deterministic demo build. */
export async function fetchMarketSnapshot(market: MarketType = "spot"): Promise<MarketSnapshot> {
  try {
    return await fetchMarketSnapshotServer({ data: { market } });
  } catch {
    return buildDemoSnapshot();
  }
}
