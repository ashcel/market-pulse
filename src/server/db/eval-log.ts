import { sql } from "./client";
import type { MarketType } from "@/lib/engine/binance";
import type { DisplayIntentAssessment } from "@/lib/engine/hysteresis";
import { currentProvenance } from "@/lib/engine/version";

const json = (v: unknown) => sql.json(v as Parameters<typeof sql.json>[0]);

export interface EvalLogInput {
  engineRunId: string | null;
  evaluatedAt?: string;
  symbol: string;
  market: MarketType;
  intent: string;
  verdict: string;
  direction: string | null;
  setupType: string;
  regime: string;
  timeframe: string;
  confidence: number | null;
  btWinRate: number | null;
  btExpectancy: number | null;
  btAvgR: number | null;
  btTotalTrades: number | null;
  btLowSample: boolean | null;
  noTradeReasons: string[];
  componentScores: any;
}

export interface EvalLogRow {
  id: string;
  engineRunId: string | null;
  evaluatedAt: string;
  symbol: string;
  market: MarketType;
  intent: string;
  verdict: string;
  direction: string | null;
  setupType: string;
  regime: string;
  timeframe: string;
  confidence: number | null;
  btWinRate: number | null;
  btExpectancy: number | null;
  btAvgR: number | null;
  btTotalTrades: number | null;
  btLowSample: boolean | null;
  noTradeReasons: string[];
  componentScores: any;
  engineVersion: string;
  configHash: string;
  gitSha: string;
}

export function rowToEvalLog(r: Record<string, unknown>): EvalLogRow {
  return {
    id: r.id as string,
    engineRunId: (r.engine_run_id as string | null) ?? null,
    evaluatedAt: r.evaluated_at instanceof Date ? r.evaluated_at.toISOString() : (r.evaluated_at as string),
    symbol: r.symbol as string,
    market: r.market as MarketType,
    intent: r.intent as string,
    verdict: r.verdict as string,
    direction: (r.direction as string | null) ?? null,
    setupType: r.setup_type as string,
    regime: r.regime as string,
    timeframe: r.timeframe as string,
    confidence: r.confidence == null ? null : Number(r.confidence),
    btWinRate: r.bt_win_rate == null ? null : Number(r.bt_win_rate),
    btExpectancy: r.bt_expectancy == null ? null : Number(r.bt_expectancy),
    btAvgR: r.bt_avg_r == null ? null : Number(r.bt_avg_r),
    btTotalTrades: r.bt_total_trades == null ? null : Number(r.bt_total_trades),
    btLowSample: r.bt_low_sample == null ? null : Boolean(r.bt_low_sample),
    noTradeReasons: (r.no_trade_reasons as string[]) || [],
    componentScores: r.component_scores,
    engineVersion: r.engine_version as string,
    configHash: r.config_hash as string,
    gitSha: r.git_sha as string,
  };
}

export async function insertEvalLog(input: EvalLogInput): Promise<void> {
  const prov = currentProvenance();
  const evaluatedAt = input.evaluatedAt ? new Date(input.evaluatedAt) : new Date();
  
  await sql`
    insert into eval_log (
      engine_run_id, evaluated_at, symbol, market, intent, verdict, direction, setup_type, regime, timeframe, confidence,
      bt_win_rate, bt_expectancy, bt_avg_r, bt_total_trades, bt_low_sample,
      no_trade_reasons, component_scores,
      engine_version, config_hash, git_sha
    ) values (
      ${input.engineRunId}, ${evaluatedAt}, ${input.symbol}, ${input.market}, ${input.intent}, ${input.verdict}, ${input.direction}, ${input.setupType}, ${input.regime}, ${input.timeframe}, ${input.confidence},
      ${input.btWinRate}, ${input.btExpectancy}, ${input.btAvgR}, ${input.btTotalTrades}, ${input.btLowSample},
      ${json(input.noTradeReasons)}, ${json(input.componentScores)},
      ${prov.engineVersion}, ${prov.configHash}, ${prov.gitSha}
    )
  `;
}

export async function getEvalLogsForSymbol(symbol: string, market?: MarketType): Promise<EvalLogRow[]> {
  const rows = market
    ? await sql`
        select * from eval_log
        where symbol = ${symbol} and market = ${market}
        order by evaluated_at desc
      `
    : await sql`
        select * from eval_log
        where symbol = ${symbol}
        order by evaluated_at desc
      `;
  return rows.map(rowToEvalLog);
}

export async function logEvalAssessments(
  engineRunId: string,
  symbol: string,
  market: MarketType,
  assessments: DisplayIntentAssessment[],
): Promise<void> {
  // Must be try/catch wrapped — never fail the tick.
  try {
    for (const assessment of assessments) {
      const bt = assessment.execution?.backtest;
      const componentScores: Record<string, any> = {};
      if (assessment.execution?.components) {
        for (const comp of assessment.execution.components) {
          componentScores[comp.name] = {
            score: comp.score,
            status: comp.status,
            explanation: comp.explanation,
          };
        }
      }

      await insertEvalLog({
        engineRunId,
        symbol,
        market,
        intent: assessment.intent,
        verdict: assessment.verdict,
        direction: assessment.direction === "none" ? null : assessment.direction,
        setupType: assessment.execution?.setupType ?? "none",
        regime: assessment.execution?.regime ?? "choppy",
        timeframe: assessment.definition?.executionTimeframe ?? "15M",
        confidence: assessment.confidence ?? null,
        btWinRate: bt?.winRate ?? null,
        btExpectancy: bt?.expectancy ?? null,
        btAvgR: bt?.averageR ?? null,
        btTotalTrades: bt?.totalTrades ?? null,
        btLowSample: bt?.lowSample ?? null,
        noTradeReasons: assessment.execution?.noTradeReasons || [],
        componentScores,
      });
    }
  } catch (err) {
    console.error(`[eval-log] Failed to log assessments for ${symbol}:`, err);
  }
}
