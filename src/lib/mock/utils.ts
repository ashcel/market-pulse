import type { SparkPoint } from "../types";

// Deterministic pseudo-random so mock data is stable across renders/SSR.
export function seededRandom(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function makeSpark(
  seed: number,
  points = 40,
  drift = 0.02,
  volatility = 0.03,
  start = 100,
): SparkPoint[] {
  const rand = seededRandom(seed);
  const out: SparkPoint[] = [];
  let v = start;
  for (let i = 0; i < points; i++) {
    v = v * (1 + drift / points + (rand() - 0.5) * volatility);
    out.push({ t: i, v: Number(v.toFixed(2)) });
  }
  return out;
}
