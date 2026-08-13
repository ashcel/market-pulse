import { useCallback, useEffect, useState } from "react";

/**
 * Forward-test research feed.
 *
 * Polls rather than streams: this data changes when a setup transitions, which
 * is minutes apart, not seconds. A live stream here would be motion without
 * information.
 *
 * Everything below is a *recorded hypothesis* and what happened to it. Nothing
 * is a position, nothing was ever sent to an exchange, and no row is ever
 * edited or removed — including the bad ones, which are the whole point.
 */

export type ForwardTestStatus =
  "PENDING_ENTRY" | "ACTIVE" | "TARGET_HIT" | "INVALIDATED" | "EXPIRED" | "NO_FILL";

export interface ForwardTestSetup {
  id: string;
  symbol: string;
  market: string;
  mode: string;
  direction: "bullish" | "bearish";
  status: ForwardTestStatus;
  detectedAt: number;

  /** The plan, frozen at detection. */
  state: string;
  tier: string;
  combo: string;
  score: number;
  entryLow: number;
  entryHigh: number;
  referenceEntry: number;
  initialInvalidation: number;
  target: number;
  targetKind: string;
  potentialRr: number;
  htfBias: string;
  alignment: string;
  alignmentLevel: string;
  /** The whole tape at detection: bullish | bearish | choppy | unknown, or ""
   * on rows written before regime was recorded at all. */
  regime: string;
  evidence: Record<string, unknown>;

  /** The lifecycle. `activeStop` may have trailed; `initialInvalidation` never moves. */
  activeStop: number;
  trailingMode: string;
  trailingActivatedAt: number | null;
  trailingUpdates: number[][];
  zoneTouchedAt: number | null;
  enteredAt: number | null;
  entryPrice: number | null;

  /** The outcome. */
  settledAt: number | null;
  exitPrice: number | null;
  exitReason: string;
  realizedR: number;
  grossR: number;
  costR: number;
  variants: Record<string, { status: string; realized_r: number; exit_reason: string }>;
  /** The tape at settlement. Different from `regime` = the trade outlived the
   * conditions it was taken in. */
  exitRegime: string;
  mfePct: number;
  maePct: number;
  mfeR: number;
  maeR: number;
  pendingMfePct: number;
  /** Floating R while open, already net of the round trip. Zero once settled. */
  unrealizedR: number;
  touchedZone: boolean;
  timeToEntry: number | null;
  timeInTrade: number | null;
  lastPrice: number;
  updatedAt: number;

  strategyVersion: string;
  engineVersion: string;
  configHash: string;
  gitSha: string;
}

export interface ForwardTestStats {
  total: number;
  open: number;
  filled: number;
  noFill: number;
  targetHit: number;
  invalidated: number;
  expired: number;
  fillRate: number;
  winRate: number;
  noFillRate: number;
  averageR: number;
  medianR: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownR: number;
  totalR: number;
  averageMfeR: number;
  averageMaeR: number;
}

export interface ForwardTestSummary {
  daysRunning: number;
  firstDetectedAt: number | null;
  setupsRecorded: number;
  openNow: number;
  scannedUniverse: number;
  strategyVersion: string;
  configHash: string;
  gitSha: string;
  bestSetup: ForwardTestSetup | null;
}

export interface ForwardTestData {
  mode: string | null;
  summary: ForwardTestSummary;
  stats: ForwardTestStats;
  /** The same statistics cut by the tape each setup was detected in. A rule
   * that only works in one regime is not a rule that works, and a single
   * aggregate cannot show that. */
  byRegime: Record<string, ForwardTestStats>;
  setups: ForwardTestSetup[];
}

interface RawSetup {
  id: string;
  symbol: string;
  market: string;
  mode: string;
  direction: string;
  status: string;
  detected_at: number;
  state: string;
  tier: string;
  combo: string;
  score: number;
  entry_low: number;
  entry_high: number;
  reference_entry: number;
  initial_invalidation: number;
  target: number;
  target_kind: string;
  potential_rr: number;
  htf_bias: string;
  alignment: string;
  alignment_level: string;
  regime: string;
  evidence: Record<string, unknown>;
  active_stop: number;
  trailing_mode: string;
  trailing_activated_at: number | null;
  trailing_updates: number[][];
  zone_touched_at: number | null;
  entered_at: number | null;
  entry_price: number | null;
  settled_at: number | null;
  exit_price: number | null;
  exit_reason: string;
  realized_r: number;
  gross_r: number;
  cost_r: number;
  variants: Record<string, { status: string; realized_r: number; exit_reason: string }>;
  exit_regime: string;
  mfe_pct: number;
  mae_pct: number;
  mfe_r: number;
  mae_r: number;
  pending_mfe_pct: number;
  unrealized_r: number;
  touched_zone: boolean;
  time_to_entry: number | null;
  time_in_trade: number | null;
  last_price: number;
  updated_at: number;
  strategy_version: string;
  engine_version: string;
  config_hash: string;
  git_sha: string;
}

function fromRawSetup(row: RawSetup): ForwardTestSetup {
  return {
    id: row.id,
    symbol: row.symbol,
    market: row.market,
    mode: row.mode,
    direction: row.direction as ForwardTestSetup["direction"],
    status: row.status as ForwardTestStatus,
    detectedAt: row.detected_at,
    state: row.state,
    tier: row.tier,
    combo: row.combo ?? "",
    score: row.score,
    entryLow: row.entry_low,
    entryHigh: row.entry_high,
    referenceEntry: row.reference_entry,
    initialInvalidation: row.initial_invalidation,
    target: row.target,
    targetKind: row.target_kind ?? "",
    potentialRr: row.potential_rr,
    htfBias: row.htf_bias,
    alignment: row.alignment,
    alignmentLevel: row.alignment_level,
    regime: row.regime ?? "",
    evidence: row.evidence ?? {},
    activeStop: row.active_stop,
    trailingMode: row.trailing_mode,
    trailingActivatedAt: row.trailing_activated_at,
    trailingUpdates: row.trailing_updates ?? [],
    zoneTouchedAt: row.zone_touched_at,
    enteredAt: row.entered_at,
    entryPrice: row.entry_price,
    settledAt: row.settled_at,
    exitPrice: row.exit_price,
    exitReason: row.exit_reason ?? "",
    realizedR: row.realized_r,
    grossR: row.gross_r ?? 0,
    costR: row.cost_r ?? 0,
    variants: row.variants ?? {},
    exitRegime: row.exit_regime ?? "",
    mfePct: row.mfe_pct,
    maePct: row.mae_pct,
    mfeR: row.mfe_r,
    maeR: row.mae_r,
    pendingMfePct: row.pending_mfe_pct,
    unrealizedR: row.unrealized_r ?? 0,
    touchedZone: row.touched_zone,
    timeToEntry: row.time_to_entry,
    timeInTrade: row.time_in_trade,
    lastPrice: row.last_price,
    updatedAt: row.updated_at,
    strategyVersion: row.strategy_version,
    engineVersion: row.engine_version,
    configHash: row.config_hash,
    gitSha: row.git_sha,
  };
}

function fromRawStats(stats: Record<string, number>): ForwardTestStats {
  return {
    total: stats.total ?? 0,
    open: stats.open ?? 0,
    filled: stats.filled ?? 0,
    noFill: stats.no_fill ?? 0,
    targetHit: stats.target_hit ?? 0,
    invalidated: stats.invalidated ?? 0,
    expired: stats.expired ?? 0,
    fillRate: stats.fill_rate ?? 0,
    winRate: stats.win_rate ?? 0,
    noFillRate: stats.no_fill_rate ?? 0,
    averageR: stats.average_r ?? 0,
    medianR: stats.median_r ?? 0,
    expectancy: stats.expectancy ?? 0,
    profitFactor: stats.profit_factor ?? 0,
    maxDrawdownR: stats.max_drawdown_r ?? 0,
    totalR: stats.total_r ?? 0,
    averageMfeR: stats.average_mfe_r ?? 0,
    averageMaeR: stats.average_mae_r ?? 0,
  };
}

/** Transitions are minutes apart; polling this often is already generous. */
const POLL_MS = 20_000;

/** …but an open position is *marked* every recorder tick (5s), and a floating
 * number that updates every 20s reads as a stuck one. */
const LIVE_POLL_MS = 5_000;

export function useForwardTest(
  mode: string | null,
  status: string | null,
  generation: number | null = null,
): { data: ForwardTestData | null; loading: boolean } {
  const [data, setData] = useState<ForwardTestData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const params = new URLSearchParams();
        if (mode !== null) params.set("mode", mode);
        if (status !== null) params.set("status", status);
        if (generation !== null) params.set("generation", String(generation));
        const res = await fetch(`/api/research/forward-test?${params.toString()}`, { signal });
        if (!res.ok) return;
        const body = (await res.json()) as {
          data: {
            mode: string | null;
            summary: Record<string, unknown> & { best_setup: RawSetup | null };
            stats: Record<string, number>;
            by_regime: Record<string, Record<string, number>>;
            setups: RawSetup[];
          };
        };
        if (signal.aborted || !body?.data) return;
        const summary = body.data.summary;
        const stats = body.data.stats;
        setData({
          mode: body.data.mode,
          summary: {
            daysRunning: Number(summary.days_running ?? 0),
            firstDetectedAt: (summary.first_detected_at as number | null) ?? null,
            setupsRecorded: Number(summary.setups_recorded ?? 0),
            openNow: Number(summary.open_now ?? 0),
            scannedUniverse: Number(summary.scanned_universe ?? 0),
            strategyVersion: String(summary.strategy_version ?? ""),
            configHash: String(summary.config_hash ?? ""),
            gitSha: String(summary.git_sha ?? ""),
            bestSetup: summary.best_setup ? fromRawSetup(summary.best_setup) : null,
          },
          stats: fromRawStats(stats),
          byRegime: Object.fromEntries(
            Object.entries(body.data.by_regime ?? {}).map(([regime, raw]) => [
              regime,
              fromRawStats(raw),
            ]),
          ),
          setups: (body.data.setups ?? []).map(fromRawSetup),
        });
      } catch {
        // Offline or aborted — the last snapshot stays on screen.
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [mode, status, generation],
  );

  const hasOpen = data?.setups.some((setup) => setup.settledAt === null) ?? false;

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const id = setInterval(() => void load(controller.signal), hasOpen ? LIVE_POLL_MS : POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [load, hasOpen]);

  return { data, loading };
}
