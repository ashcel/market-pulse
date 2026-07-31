/** Shapes served by the quant-notifier dashboard (`/api/state`, `/api/token`),
 * proxied through `/api/v1/quant/*`. Only the fields this UI reads are typed —
 * the upstream payload carries more (ranked, regimeEpisodes, stats tables). */

export interface QuantSignal {
  symbol: string;
  kind: string;
  conviction: string | null;
  baseConviction?: string | null;
  direction?: "long" | "short" | null;
  at: string;
  notified?: boolean;
  rank?: number | null;
  provisional?: boolean;
  regime?: string | null;
  stats?: { avgR?: number | null; winRate?: number | null; n?: number | null } | null;
}

export interface QuantRegimeSide {
  symbol: string;
  regime: string | null;
  label?: string;
  last?: number | null;
  changePercent?: number | null;
  error?: string;
}

export interface QuantState {
  generatedAt: string;
  summary: {
    days: number;
    total: number;
    notified: number;
    silent: number;
    cryptoRegime: string | null;
    stockRegime: string | null;
    structureConflict: boolean;
    nextEvent: { title?: string; atUtc?: string } | null;
  };
  regimes: {
    crypto: QuantRegimeSide | null;
    stock: QuantRegimeSide | null;
    structure?: {
      daily: string | null;
      fourHour: string | null;
      conflict: boolean;
      lastDailyBreak?: unknown;
    } | null;
  };
  signals: QuantSignal[];
}

export interface QuantCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface QuantTokenDetail {
  symbol: string;
  capTier?: string;
  last?: number | null;
  change7d?: number | null;
  change30d?: number | null;
  fundingRate?: number | null;
  candles: QuantCandle[];
  forecast: {
    candles: (QuantCandle & { confidence?: number })[];
    cone: { time: number; upper: number; lower: number }[];
    metadata?: {
      tpHitProbability?: number;
      slHitProbability?: number;
      barsToTp?: number | null;
      barsToSl?: number | null;
    };
  } | null;
  signals: QuantSignal[];
  error?: string;
}
