import { useQuery } from "@tanstack/react-query";

/** Mirrors one entry of `app.rally_watcher.schemas.RallyReadResponse.targets`/`.liquidity`. */
export interface RallyTarget {
  price: number;
  distance_pct: number;
  label: string;
  detail: string;
}

/** Mirrors `app.rally_watcher.schemas.RallyReadResponse` (backend). */
export interface RallyRead {
  symbol: string;
  direction: "long";
  gainPct: number;
  volumeMult: number;
  momentumScore: number;
  extended: boolean;
  targets: {
    smcPool?: RallyTarget;
    resistance?: RallyTarget;
    liquidation?: RallyTarget;
  };
  liquidity: {
    bslAbove: RallyTarget[];
    sslBelow: RallyTarget[];
    longLiq: RallyTarget[];
  };
  explanation: string;
  evaluatedAt: number;
  oiAvailable: boolean;
  version: string;
}

interface RawRallyRead {
  symbol: string;
  direction: string;
  gain_pct: number;
  volume_mult: number;
  momentum_score: number;
  extended: boolean;
  targets: Record<string, RallyTarget>;
  liquidity: Record<string, RallyTarget[]>;
  explanation: string;
  evaluated_at: number;
  oi_available: boolean;
  version: string;
}

interface RawScanResponse {
  data: {
    updated_at: string;
    universe_size: number;
    rallies: RawRallyRead[];
    scanning: boolean;
  };
}

export interface RallyWatcherScan {
  updatedAt: number;
  universeSize: number;
  rallies: RallyRead[];
  /** True while the backend's all-market background scan is still running
   * (or cache is empty, cold start) — show "scanning" not "no rallies". */
  scanning: boolean;
}

function fromRaw(row: RawRallyRead): RallyRead {
  return {
    symbol: row.symbol,
    direction: row.direction as "long",
    gainPct: row.gain_pct,
    volumeMult: row.volume_mult,
    momentumScore: row.momentum_score,
    extended: row.extended,
    targets: {
      smcPool: row.targets.smcPool,
      resistance: row.targets.resistance,
      liquidation: row.targets.liquidation,
    },
    liquidity: {
      bslAbove: row.liquidity.bslAbove ?? [],
      sslBelow: row.liquidity.sslBelow ?? [],
      longLiq: row.liquidity.longLiq ?? [],
    },
    explanation: row.explanation,
    evaluatedAt: row.evaluated_at,
    oiAvailable: row.oi_available,
    version: row.version,
  };
}

const REFETCH_MS = 60_000;

/**
 * Live RALLY WATCHER scan for the discover page — 15-minute momentum over
 * the dynamic perp universe, computed live server-side (~60s FastAPI cache)
 * rather than persisted. Research/live-watch tool, never a trade signal.
 */
export function useRallyWatcher() {
  return useQuery<RallyWatcherScan>({
    queryKey: ["rally-watcher-scan"],
    staleTime: REFETCH_MS,
    refetchInterval: REFETCH_MS,
    queryFn: async () => {
      const res = await fetch("/api/rally-watcher/scan", { method: "POST" });
      if (!res.ok) return { updatedAt: Date.now(), universeSize: 0, rallies: [], scanning: true };
      const body = (await res.json()) as RawScanResponse;
      return {
        updatedAt: new Date(body.data.updated_at).getTime(),
        universeSize: body.data.universe_size,
        rallies: (body.data.rallies ?? []).map(fromRaw),
        scanning: body.data.scanning ?? false,
      };
    },
  });
}
