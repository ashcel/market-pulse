import {
  countOpenRecords,
  listFavoredShadowRecords,
  listRecentRuns,
  loadShadowSignals,
  type EngineRunRow,
  type OpenRecordCounts,
} from "../db/repo";
import {
  shadowComboStats,
  summarizeShadowRecord,
  type ShadowComboStat,
  type ShadowRecordSummary,
  type ShadowSignal,
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

/**
 * Read model behind `/api/forward-test?view=records` — the individual
 * auto-recorded favored-verdict shadow signals themselves (not just their
 * aggregate stats), most-recent first. Global like `forwardTestStats`: these
 * are the engine's own calls, not scoped to any one user.
 */
export async function shadowRecords(limit = 200): Promise<ShadowSignal[]> {
  return listFavoredShadowRecords(limit);
}

export type ForwardTestHealthStatus = "ok" | "stale" | "error" | "never-run";

export interface ForwardTestHealth {
  status: ForwardTestHealthStatus;
  engineVersion: string;
  openRecords: OpenRecordCounts;
  lastRun?: EngineRunRow;
  /** Seconds since the last run finished (or started, if it never finished). */
  lastRunAgeSeconds?: number;
}

/**
 * A pass is "stale" once it's been silent for longer than a few worker
 * intervals — long enough that a slow individual pass isn't a false alarm,
 * short enough that a genuinely dead worker (crash-looped past
 * `Restart=always`, or the unit stopped) is caught quickly. Reads the same
 * `WORKER_INTERVAL_MS` the worker itself uses so this stays in sync with
 * whatever cadence prod is actually running.
 */
const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5 * 60_000);
const STALE_AFTER_MS = WORKER_INTERVAL_MS * 3;

/** Read model behind `/api/forward-test?view=health` (WS4) — liveness without SSH. */
export async function healthSnapshot(): Promise<ForwardTestHealth> {
  const [runs, openRecords] = await Promise.all([listRecentRuns(1), countOpenRecords()]);
  const lastRun = runs[0];
  if (!lastRun) {
    return { status: "never-run", engineVersion: ENGINE_VERSION, openRecords };
  }

  const referenceTime = Date.parse(lastRun.finishedAt ?? lastRun.startedAt);
  const lastRunAgeSeconds = Math.round((Date.now() - referenceTime) / 1000);
  const status: ForwardTestHealthStatus =
    lastRun.status === "error"
      ? "error"
      : lastRunAgeSeconds * 1000 > STALE_AFTER_MS
        ? "stale"
        : "ok";

  return { status, engineVersion: ENGINE_VERSION, openRecords, lastRun, lastRunAgeSeconds };
}
