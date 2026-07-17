/**
 * Pure statistics for the record-review report (P2.3). Read-only analysis —
 * deliberately server-side and OUTSIDE `src/lib/engine/`, because per EDR 0011
 * nothing here may ever feed `applyRecordAdjustment`/the demotion path: a
 * different statistic there changes what the forward test records and needs a
 * pre-registered spike + ENGINE_VERSION bump.
 */

export interface WilsonInterval {
  /** Point estimate (successes / n). */
  p: number;
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion — behaves sensibly at the
 * tiny per-combo sample sizes this record has (unlike the normal
 * approximation, it never leaves [0, 1] and doesn't collapse at p = 0 or 1).
 */
export function wilson95(successes: number, n: number): WilsonInterval | null {
  if (n <= 0) return null;
  const z = 1.959964; // 97.5th percentile of the standard normal
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface MeanWithSe {
  mean: number;
  /** Standard error of the mean; null when n < 2. */
  se: number | null;
  n: number;
}

export function meanWithSe(values: number[]): MeanWithSe | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean, se: null, n };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(variance / n), n };
}

/**
 * Empirical-Bayes-style shrinkage of a per-cell rate toward the pooled rate:
 * `(k·p_cell + m·p_pool) / (k + m)`. Prior strength `m` defaults to 15 — the
 * demotion threshold (`MIN_SHADOW_RECORD_TRADES`) — a transparent,
 * pre-declared choice rather than a value fitted to this record: a cell only
 * outweighs the pool once it has more evidence than the engine itself
 * requires before acting. Report-only (EDR 0011).
 */
export function shrunkRate(
  cellSuccesses: number,
  cellN: number,
  pooledRate: number,
  priorStrength = 15,
): number {
  if (cellN < 0 || priorStrength < 0 || cellN + priorStrength === 0) return pooledRate;
  return (cellSuccesses + priorStrength * pooledRate) / (cellN + priorStrength);
}
