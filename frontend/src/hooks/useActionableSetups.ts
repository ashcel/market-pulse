import type { UniverseSnapshot, UniverseVerdict } from "./queries";

export interface ActionableSetup {
  ticker: string;
  verdict: UniverseVerdict;
}

export function useActionableSetups(universe: UniverseSnapshot | undefined) {
  const data = universe?.verdicts
    .filter((verdict) => verdict.state !== "no_go" && verdict.direction)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((verdict) => ({ ticker: verdict.symbol.replace(/USDT$/, ""), verdict }));

  return { data };
}
