import { createServerFn } from "@tanstack/react-start";

import { computePivots } from "./analysis";
import {
  dropUnclosedCandle,
  fetchBinanceKlinesDirect,
  fetchBinancePriceDirect,
  type MarketType,
} from "./binance";
import { CRYPTO_RISK_SETTINGS } from "./crypto-config";
import { generateMockCandles, TOKEN_TIMEFRAMES } from "./mock-candles";
import { evaluateSignal } from "./quant";
import { computeBaseZones, SD_ZONE_TIMEFRAMES, type BaseZone } from "./zones";
import type { TokenTimeframe } from "./mock-candles";
import type { RiskSettings, SignalEvaluation, TradeDecision, TradeDirection } from "./quant";

export interface TimeframeAlignmentEntry {
  timeframe: TokenTimeframe;
  direction: TradeDirection;
  decision: TradeDecision;
  /** Full engine output — the intent layer needs the whole evaluation per timeframe. */
  evaluation: SignalEvaluation;
  /**
   * Fresh/tested supply-demand base zones on this timeframe (empty on
   * timeframes too fast to form meaningful bases — see SD_ZONE_TIMEFRAMES).
   * Feeds location grading + multi-timeframe zone confluence.
   */
  zones: BaseZone[];
}

/** User-adjustable subset of RiskSettings that affects the per-timeframe plans. */
export type RiskOverrides = Partial<
  Pick<RiskSettings, "accountSize" | "maxRiskPerTradePercent" | "minimumRewardRisk" | "stopMethod">
>;

const STOP_METHODS: ReadonlySet<string> = new Set(["swing", "atr", "fixed-percent"]);

function sanitizeRisk(risk: unknown): RiskOverrides {
  if (!risk || typeof risk !== "object") return {};
  const r = risk as Record<string, unknown>;
  const out: RiskOverrides = {};
  if (typeof r.accountSize === "number" && Number.isFinite(r.accountSize) && r.accountSize > 0)
    out.accountSize = r.accountSize;
  if (
    typeof r.maxRiskPerTradePercent === "number" &&
    Number.isFinite(r.maxRiskPerTradePercent) &&
    r.maxRiskPerTradePercent > 0 &&
    r.maxRiskPerTradePercent <= 100
  )
    out.maxRiskPerTradePercent = r.maxRiskPerTradePercent;
  if (
    typeof r.minimumRewardRisk === "number" &&
    Number.isFinite(r.minimumRewardRisk) &&
    r.minimumRewardRisk > 0
  )
    out.minimumRewardRisk = r.minimumRewardRisk;
  if (typeof r.stopMethod === "string" && STOP_METHODS.has(r.stopMethod))
    out.stopMethod = r.stopMethod as RiskSettings["stopMethod"];
  return out;
}

function evaluateTimeframes(
  candlesByTimeframe: Array<[TokenTimeframe, ReturnType<typeof generateMockCandles>]>,
  symbol: string,
  settings: RiskSettings,
  livePrice?: number,
): TimeframeAlignmentEntry[] {
  return candlesByTimeframe.map(([timeframe, candles]) => {
    const evaluation = evaluateSignal(
      symbol,
      candles,
      computePivots(candles),
      settings,
      undefined,
      livePrice,
    );
    return {
      timeframe,
      direction: evaluation.direction,
      decision: evaluation.decision,
      evaluation,
      zones: SD_ZONE_TIMEFRAMES.includes(timeframe) ? computeBaseZones(candles) : [],
    };
  });
}

export function buildDemoAlignment(
  symbol: string,
  risk: RiskOverrides = {},
): TimeframeAlignmentEntry[] {
  const ticker = symbol.toUpperCase();
  return evaluateTimeframes(
    TOKEN_TIMEFRAMES.map((timeframe) => [timeframe, generateMockCandles(ticker, timeframe)]),
    ticker,
    { ...CRYPTO_RISK_SETTINGS, ...sanitizeRisk(risk) },
  );
}

const alignmentCache = new Map<string, { at: number; data: TimeframeAlignmentEntry[] }>();
const ALIGNMENT_TTL_MS = 60_000;

async function computeAlignment(
  symbol: string,
  risk: RiskOverrides,
  market: MarketType,
): Promise<TimeframeAlignmentEntry[]> {
  const ticker = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!ticker) return [];
  const settings: RiskSettings = { ...CRYPTO_RISK_SETTINGS, ...risk };

  const now = Date.now();
  const cacheKey = `${ticker}:${market}:${settings.accountSize}:${settings.maxRiskPerTradePercent}:${settings.minimumRewardRisk}:${settings.stopMethod}`;
  const cached = alignmentCache.get(cacheKey);
  if (cached && now - cached.at < ALIGNMENT_TTL_MS) return cached.data;

  const [series, livePrice] = await Promise.all([
    Promise.all(
      TOKEN_TIMEFRAMES.map(async (timeframe) => {
        const candles = await fetchBinanceKlinesDirect({
          symbol: ticker,
          timeframe,
          limit: 200,
          market,
        });
        const closed = dropUnclosedCandle(candles);
        return [timeframe, closed.length > 0 ? closed : generateMockCandles(ticker, timeframe)] as [
          TokenTimeframe,
          ReturnType<typeof generateMockCandles>,
        ];
      }),
    ),
    fetchBinancePriceDirect(ticker, market),
  ]);

  const data = evaluateTimeframes(series, ticker, settings, livePrice ?? undefined);
  alignmentCache.set(cacheKey, { at: now, data });
  return data;
}

export const fetchTimeframeAlignmentServer = createServerFn({ method: "GET" })
  .validator((data: { symbol: string; risk?: RiskOverrides; market?: MarketType }) => ({
    symbol: typeof data?.symbol === "string" ? data.symbol : "",
    risk: sanitizeRisk(data?.risk),
    market: (data?.market === "perp" ? "perp" : "spot") as MarketType,
  }))
  .handler(async ({ data }) => computeAlignment(data.symbol, data.risk, data.market));

/** Client-facing helper: server evaluation, falling back to the deterministic demo build. */
export async function fetchTimeframeAlignment(
  symbol: string,
  risk: RiskOverrides = {},
  market: MarketType = "spot",
): Promise<TimeframeAlignmentEntry[]> {
  try {
    return await fetchTimeframeAlignmentServer({ data: { symbol, risk, market } });
  } catch {
    return buildDemoAlignment(symbol, risk);
  }
}
