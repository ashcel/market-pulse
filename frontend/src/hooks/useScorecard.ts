import { useQuery } from "@tanstack/react-query";

/**
 * `source_scorecard` as the nightly pass stored it — one row per source ×
 * version × regime × horizon. The backend nulls `hit_rate`/`avg_r` below the
 * evidence threshold, so a row with `status: "insufficient"` genuinely has no
 * number to render; the UI must say "Belum cukup data" rather than 0%.
 */
export interface ScorecardRow {
  source: string;
  source_version: string;
  regime: string;
  horizon: string;
  window_days: number;
  n: number;
  hit_rate: number | null;
  avg_r: number | null;
  status: "ok" | "insufficient";
  computed_at: string | null;
}

/**
 * One headline per source, folded server-side. Not derived here on purpose:
 * the rows above have `hit_rate` nulled below the threshold, so folding them
 * in the client would weight a sub-threshold regime slice as 0%.
 */
export interface SourceSummary {
  source: string;
  n: number;
  hit_rate: number | null;
  avg_r: number | null;
  status: "ok" | "insufficient";
  window_days: number;
  horizons: string[];
  versions: string[];
}

export interface ScorecardMeta {
  count: number;
  by_source: SourceSummary[];
  /** SCORECARD_ENABLED on the API — distinguishes "cron off" from "not enough". */
  enabled: boolean;
  min_n: number;
  live_sources: string[];
}

const EMPTY_META: ScorecardMeta = {
  count: 0,
  by_source: [],
  enabled: false,
  min_n: 20,
  live_sources: [],
};

export function useScorecard() {
  return useQuery({
    queryKey: ["scorecard"],
    queryFn: async () => {
      const res = await fetch("/api/scorecard", { credentials: "same-origin" });
      if (res.status === 401) return { data: [] as ScorecardRow[], meta: EMPTY_META };
      if (!res.ok) throw new Error(`scorecard fetch failed: ${res.status}`);
      return (await res.json()) as { data: ScorecardRow[]; meta: ScorecardMeta };
    },
    staleTime: 5 * 60_000,
  });
}
