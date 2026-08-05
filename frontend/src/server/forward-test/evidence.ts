import { sql } from "../db/client";

/**
 * Read model over the `forward_return` ground-truth table (the honest,
 * no-lookahead measurement of what each asset actually did over a horizon
 * after an anchor 1H bar closed — recomputed hourly, ~143k rows / 50
 * symbols). Aggregate stats only, grouped by horizon; never exposes raw
 * rows. Backs the Review page's "Track Record — Forward Returns" section.
 */

/** Canonical horizon display order (shortest to longest), not alphabetical. */
const HORIZON_ORDER = ["1h", "4h", "12h", "1d", "3d", "7d"] as const;

/** Below this row count, stats are thin enough to be misleading — hide them. */
const MIN_SAMPLE = 20;

export interface ForwardReturnExtreme {
  symbol: string;
  forwardReturn: number;
}

export interface HorizonEvidence {
  horizon: string;
  n: number;
  avgR: number | null;
  medianR: number | null;
  winRate: number | null;
  insufficient: boolean;
  best: ForwardReturnExtreme | null;
  worst: ForwardReturnExtreme | null;
}

export interface ForwardReturnEvidence {
  horizons: HorizonEvidence[];
}

interface StatRow {
  horizon: string;
  n: number;
  avg_r: number | null;
  median_r: number | null;
  win_rate: number | null;
}

interface ExtremeRow {
  horizon: string;
  symbol: string;
  forward_return: number;
}

export async function forwardReturnEvidence(): Promise<ForwardReturnEvidence> {
  const [stats, bestRows, worstRows] = await Promise.all([
    sql<StatRow[]>`
      select
        horizon,
        count(*)::int as n,
        avg(forward_return)::float8 as avg_r,
        percentile_cont(0.5) within group (order by forward_return)::float8 as median_r,
        (count(*) filter (where forward_return > 0))::float8 / count(*)::float8 as win_rate
      from forward_return
      group by horizon
    `,
    sql<ExtremeRow[]>`
      select distinct on (horizon) horizon, symbol, forward_return::float8 as forward_return
      from forward_return
      order by horizon, forward_return desc
    `,
    sql<ExtremeRow[]>`
      select distinct on (horizon) horizon, symbol, forward_return::float8 as forward_return
      from forward_return
      order by horizon, forward_return asc
    `,
  ]);

  const statsByHorizon = new Map(stats.map((r) => [r.horizon, r]));
  const bestByHorizon = new Map(bestRows.map((r) => [r.horizon, r]));
  const worstByHorizon = new Map(worstRows.map((r) => [r.horizon, r]));

  const horizons: HorizonEvidence[] = HORIZON_ORDER.filter((h) => statsByHorizon.has(h)).map(
    (horizon) => {
      const row = statsByHorizon.get(horizon)!;
      const insufficient = row.n < MIN_SAMPLE;
      const best = bestByHorizon.get(horizon);
      const worst = worstByHorizon.get(horizon);
      return {
        horizon,
        n: row.n,
        avgR: insufficient ? null : row.avg_r,
        medianR: insufficient ? null : row.median_r,
        winRate: insufficient ? null : row.win_rate,
        insufficient,
        best: insufficient || !best ? null : { symbol: best.symbol, forwardReturn: best.forward_return },
        worst:
          insufficient || !worst ? null : { symbol: worst.symbol, forwardReturn: worst.forward_return },
      };
    },
  );

  return { horizons };
}
