import { listRecentRuns, loadShadowSignals, type EngineRunRow } from "../db/repo";
import {
  shadowComboStats,
  summarizeShadowRecord,
  type ShadowComboStat,
  type ShadowRecordSummary,
} from "@/lib/engine/shadow";
import { ENGINE_VERSION } from "@/lib/engine/version";

/**
 * Read model over the server-owned forward-test record — the numbers the
 * dashboard and the worker's demotion logic both consume. Always segmented to
 * the current ENGINE_VERSION so an older engine's record can't leak in.
 */
export interface ForwardTestStats {
  engineVersion: string;
  shadow: {
    summary: ShadowRecordSummary;
    combos: ShadowComboStat[];
  };
}

export async function forwardTestStats(engineVersion = ENGINE_VERSION): Promise<ForwardTestStats> {
  const signals = await loadShadowSignals(engineVersion);
  return {
    engineVersion,
    shadow: {
      summary: summarizeShadowRecord(signals),
      combos: shadowComboStats(signals, engineVersion),
    },
  };
}

export async function recentRuns(limit = 20): Promise<EngineRunRow[]> {
  return listRecentRuns(limit);
}
