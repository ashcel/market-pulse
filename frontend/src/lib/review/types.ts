// Trade Review types — shared by the client-side generation pipeline
// (severity → candles → prompt → BYOK LLM call → parse) and the backend
// response shapes it reads/writes through the api/bybit.* and api/review.*
// proxy routes.

export type ReviewTradeSide = "LONG" | "SHORT";

/** A synced Bybit trade, as returned by GET /api/bybit/trades `data[]`. */
export interface ReviewTrade {
  id: string;
  user_id: string;
  symbol: string; // e.g. "BTCUSDT"
  side: ReviewTradeSide;
  leverage: number;
  entry_price: number;
  exit_price: number;
  quantity: number;
  realized_pnl: number;
  roi_percent: number | null;
  fees: number;
  opened_at: string;
  open_time_source: string;
  closed_at: string;
  stop_loss: number | null;
  take_profit: number | null;
  close_trigger: string | null;
  sl_slippage: number | null;
  tp_slippage: number | null;
  created_at: string;
  updated_at: string | null;
}

export interface RrStats {
  mode: "r_multiple" | "payoff_ratio";
  avg_r_multiple: number | null;
  payoff_ratio: number | null;
  expectancy_pct: number | null;
  sample_size: number;
  coverage: number;
  label: string;
}

export interface TimeRangeStats {
  start_hour_utc: number;
  end_hour_utc: number;
  win_rate: number;
  sample_size: number;
}

export interface SessionStats {
  n: number;
  win_rate: number;
  total_pnl: number;
}

export interface SessionsStats {
  asia: SessionStats;
  london: SessionStats;
  new_york: SessionStats;
}

export interface StyleBucketStats {
  n: number;
  win_rate: number;
  total_pnl: number;
  expectancy: number;
}

export interface StyleStats {
  buckets: {
    scalp: StyleBucketStats;
    intraday: StyleBucketStats;
    swing: StyleBucketStats;
  };
  recommended: string | null;
  confidence: "low" | "ok";
  data_quality: string;
}

/** GET /review/analytics `data`. */
export interface Analytics {
  total_trades: number;
  rr: RrStats;
  best_trade: ReviewTrade | null;
  worst_trade: ReviewTrade | null;
  time_range: TimeRangeStats | null;
  worst_time_range: TimeRangeStats | null;
  sessions: SessionsStats;
  style: StyleStats;
  stop_evidence_coverage: number;
}

// ── AI-generated review (client-side output, POSTed to the backend) ────────

export type SeverityTier = "MILD" | "MODERATE" | "HIGH" | "CRITICAL";

export interface SeverityResult {
  score: number;
  tier: SeverityTier;
}

export interface UserBaseline {
  avgLeverage: number;
  avgDurationMs: number;
  winRate: number;
}

export interface PreviousTradeContext {
  closeTime: number; // ms timestamp
  result: "win" | "loss";
  pnl: number;
}

export interface TradeDataForSeverity {
  roi: number; // ROI percent (negative = loss)
  leverage: number;
  liquidated: boolean;
  behavioralTags: string[]; // always [] — no tag system yet
  openTime: number; // ms timestamp
  previousTrade: PreviousTradeContext | null;
  closeTrigger?: string | null;
}

export interface CandleContext {
  trend_summary: string;
  volatility_summary: string;
  structure_summary: string;
  sweep_detected: boolean;
  sweep_direction: "above" | "below" | null;
  key_levels: {
    support: number[];
    resistance: number[];
  };
  entry_context: string;
  exit_context: string;
}

export type TradeReviewSectionType =
  | "what_happened"
  | "what_went_well"
  | "risks_weaknesses"
  | "the_moment";

export interface TradeReviewSection {
  type: TradeReviewSectionType;
  title: string;
  content: string | null;
}

export type AnnotationPosition = "entry" | "early" | "mid" | "late" | "exit";
export type AnnotationCategory = "risk" | "strength" | "opportunity" | "execution";

export interface ChartAnnotationData {
  id: string;
  position: AnnotationPosition;
  price?: number;
  category: AnnotationCategory;
  title: string;
  message: string;
}

export type TradeReviewGrade = "A+" | "A" | "B" | "C" | "D" | "F";
export type ReviewMode = "normal" | "strict";

export interface TradeReview {
  severity_tier: SeverityTier;
  review_mode: ReviewMode;
  one_liner: string;
  headline: string;
  grade: TradeReviewGrade;
  setup_quality_score?: number;
  execution_score?: number;
  discipline_score?: number;
  risk_management_score?: number;
  sections: TradeReviewSection[];
  suggestion: string;
  closing_question: string;
  coaching_note: string;
  data_flags: string[];
  annotations?: ChartAnnotationData[];
}
