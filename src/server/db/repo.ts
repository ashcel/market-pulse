import { sql } from "./client";
import type { AnticipatoryOpenInput, ShadowOpenInput } from "@/lib/engine/evaluate";
import type { HeldVerdict } from "@/lib/engine/hysteresis";
import type { AnticipatorySignal } from "@/lib/engine/anticipatory";
import type { MarketType } from "@/lib/engine/binance";
import { assertProvenance } from "@/lib/engine/version";
import type { Provenance } from "@/lib/engine/version";
import type { ShadowSignal } from "@/lib/engine/shadow";
import type { TrackedSignal } from "@/lib/engine/tracker";

const iso = (v: Date | string | null): string | undefined =>
  v == null ? undefined : v instanceof Date ? v.toISOString() : v;

/** Bind a value as jsonb without fighting postgres.js's JSONValue type. */
const json = (v: unknown) => sql.json(v as Parameters<typeof sql.json>[0]);

// ── Engine runs ──────────────────────────────────────────────────────────────

export async function startEngineRun(prov: Provenance, universe: unknown): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into engine_run (engine_version, config_hash, git_sha, universe_json)
    values (${prov.engineVersion}, ${prov.configHash}, ${prov.gitSha}, ${json(universe)})
    returning id
  `;
  return row.id;
}

export async function finishEngineRun(id: string, status: string, note?: string): Promise<void> {
  await sql`
    update engine_run set finished_at = now(), status = ${status}, note = ${note ?? null}
    where id = ${id}
  `;
}

export interface EngineRunRow {
  id: string;
  startedAt: string;
  finishedAt?: string;
  engineVersion: string;
  status: string;
  note?: string;
}

export async function listRecentRuns(limit = 20): Promise<EngineRunRow[]> {
  const rows = await sql`
    select id, started_at, finished_at, engine_version, status, note
    from engine_run order by started_at desc limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    startedAt: iso(r.started_at as Date)!,
    finishedAt: iso(r.finished_at as Date | null),
    engineVersion: r.engine_version as string,
    status: r.status as string,
    note: (r.note as string | null) ?? undefined,
  }));
}

export interface OpenRecordCounts {
  shadow: number;
  anticipatory: number;
  tracked: number;
}

/** One round trip for the counts behind `/api/forward-test?view=health` — the
 * same "still open" definitions `listOpenShadow`/`listOpenAnticipatory`/
 * `listOpenTracked` use, without pulling full rows just to `.length` them. */
export async function countOpenRecords(): Promise<OpenRecordCounts> {
  const [row] = await sql<{ shadow: number; anticipatory: number; tracked: number }[]>`
    select
      (select count(*) from shadow_signal where status = 'active') as shadow,
      (select count(*) from anticipatory_signal where status in ('pending', 'filled'))
        as anticipatory,
      (select count(*) from tracked_signal where status = 'active') as tracked
  `;
  return {
    shadow: Number(row.shadow),
    anticipatory: Number(row.anticipatory),
    tracked: Number(row.tracked),
  };
}

// ── Shadow record ────────────────────────────────────────────────────────────

function rowToShadow(r: Record<string, unknown>): ShadowSignal {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    market: r.market as MarketType,
    intent: r.intent as ShadowSignal["intent"],
    direction: r.direction as ShadowSignal["direction"],
    setupType: r.setup_type as ShadowSignal["setupType"],
    regime: r.regime as ShadowSignal["regime"],
    timeframe: r.timeframe as ShadowSignal["timeframe"],
    entry: Number(r.entry),
    stop: Number(r.stop),
    target1: Number(r.target1),
    target2: Number(r.target2),
    confidence: Number(r.confidence),
    objectiveResolved: (r.objective_resolved as boolean | null) ?? undefined,
    openedAt: iso(r.opened_at as Date)!,
    status: r.status as ShadowSignal["status"],
    closedAt: iso(r.closed_at as Date | null),
    closePrice: r.close_price == null ? undefined : Number(r.close_price),
    resultR: r.result_r == null ? undefined : Number(r.result_r),
    engineVersion: r.engine_version as string,
    configHash: r.config_hash as string,
    gitSha: r.git_sha as string,
  };
}

/** Opens a shadow record; the partial unique index no-ops a still-open duplicate. */
export async function openShadow(input: ShadowOpenInput, engineRunId: string): Promise<void> {
  assertProvenance(input);
  await sql`
    insert into shadow_signal (
      symbol, market, intent, direction, setup_type, regime, timeframe,
      entry, stop, target1, target2, confidence, objective_resolved,
      opened_at, engine_version, config_hash, git_sha, engine_run_id
    ) values (
      ${input.symbol}, ${input.market}, ${input.intent}, ${input.direction},
      ${input.setupType}, ${input.regime}, ${input.timeframe},
      ${input.entry}, ${input.stop}, ${input.target1}, ${input.target2},
      ${input.confidence}, ${input.objectiveResolved ?? null},
      ${input.openedAt}, ${input.engineVersion}, ${input.configHash},
      ${input.gitSha}, ${engineRunId}
    )
    on conflict do nothing
  `;
}

export async function listOpenShadow(): Promise<ShadowSignal[]> {
  const rows = await sql`select * from shadow_signal where status = 'active'`;
  return rows.map((r) => rowToShadow(r as Record<string, unknown>));
}

export async function loadShadowSignals(engineVersion?: string): Promise<ShadowSignal[]> {
  const rows = engineVersion
    ? await sql`select * from shadow_signal where engine_version = ${engineVersion}`
    : await sql`select * from shadow_signal`;
  return rows.map((r) => rowToShadow(r as Record<string, unknown>));
}

export async function patchShadow(id: string, patch: Partial<ShadowSignal>): Promise<void> {
  await sql`
    update shadow_signal set
      status = coalesce(${patch.status ?? null}, status),
      closed_at = coalesce(${patch.closedAt ?? null}, closed_at),
      close_price = coalesce(${patch.closePrice ?? null}, close_price),
      result_r = coalesce(${patch.resultR ?? null}, result_r)
    where id = ${id}
  `;
}

// ── Anticipatory record ──────────────────────────────────────────────────────

function rowToAnticipatory(r: Record<string, unknown>): AnticipatorySignal {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    market: r.market as MarketType,
    intent: r.intent as AnticipatorySignal["intent"],
    direction: r.direction as AnticipatorySignal["direction"],
    setupType: r.setup_type as AnticipatorySignal["setupType"],
    regime: r.regime as AnticipatorySignal["regime"],
    timeframe: r.timeframe as AnticipatorySignal["timeframe"],
    verdict: r.verdict as AnticipatorySignal["verdict"],
    entry: Number(r.entry),
    stop: Number(r.stop),
    objective: Number(r.objective),
    objectiveStrength: r.objective_strength as AnticipatorySignal["objectiveStrength"],
    zoneFreshness: r.zone_freshness as AnticipatorySignal["zoneFreshness"],
    rewardRisk: Number(r.reward_risk),
    openedAt: iso(r.opened_at as Date)!,
    status: r.status as AnticipatorySignal["status"],
    filledAt: iso(r.filled_at as Date | null),
    closedAt: iso(r.closed_at as Date | null),
    closePrice: r.close_price == null ? undefined : Number(r.close_price),
    resultR: r.result_r == null ? undefined : Number(r.result_r),
    engineVersion: r.engine_version as string,
    configHash: r.config_hash as string,
    gitSha: r.git_sha as string,
  };
}

export async function openAnticipatory(
  input: AnticipatoryOpenInput,
  engineRunId: string,
): Promise<void> {
  assertProvenance(input);
  await sql`
    insert into anticipatory_signal (
      symbol, market, intent, direction, setup_type, regime, timeframe, verdict,
      entry, stop, objective, objective_strength, zone_freshness, reward_risk,
      opened_at, engine_version, config_hash, git_sha, engine_run_id
    ) values (
      ${input.symbol}, ${input.market}, ${input.intent}, ${input.direction},
      ${input.setupType}, ${input.regime}, ${input.timeframe}, ${input.verdict},
      ${input.entry}, ${input.stop}, ${input.objective}, ${input.objectiveStrength},
      ${input.zoneFreshness}, ${input.rewardRisk}, ${input.openedAt},
      ${input.engineVersion}, ${input.configHash}, ${input.gitSha}, ${engineRunId}
    )
    on conflict do nothing
  `;
}

export async function listOpenAnticipatory(): Promise<AnticipatorySignal[]> {
  const rows = await sql`
    select * from anticipatory_signal where status in ('pending', 'filled')
  `;
  return rows.map((r) => rowToAnticipatory(r as Record<string, unknown>));
}

export async function patchAnticipatory(
  id: string,
  patch: Partial<AnticipatorySignal>,
): Promise<void> {
  await sql`
    update anticipatory_signal set
      status = coalesce(${patch.status ?? null}, status),
      filled_at = coalesce(${patch.filledAt ?? null}, filled_at),
      closed_at = coalesce(${patch.closedAt ?? null}, closed_at),
      close_price = coalesce(${patch.closePrice ?? null}, close_price),
      result_r = coalesce(${patch.resultR ?? null}, result_r)
    where id = ${id}
  `;
}

// ── Verdict holds (server-owned hysteresis state) ────────────────────────────

export async function loadHolds(
  symbol: string,
  market: MarketType,
): Promise<Record<string, HeldVerdict>> {
  const rows = await sql<{ hold_key: string; data: HeldVerdict }[]>`
    select hold_key, data from verdict_hold where symbol = ${symbol} and market = ${market}
  `;
  const out: Record<string, HeldVerdict> = {};
  for (const r of rows) out[r.hold_key] = r.data;
  return out;
}

export async function upsertHolds(
  symbol: string,
  market: MarketType,
  updates: Record<string, HeldVerdict>,
): Promise<void> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  await sql.begin(async (tx) => {
    for (const key of keys) {
      await tx`
        insert into verdict_hold (hold_key, symbol, market, data, updated_at)
        values (${key}, ${symbol}, ${market}, ${json(updates[key])}, now())
        on conflict (hold_key) do update set data = excluded.data, updated_at = now()
      `;
    }
  });
}

// ── Tracked signals (user-owned) ─────────────────────────────────────────────

export type FollowInput = Omit<TrackedSignal, "id" | "followedAt" | "status">;

export async function followTracked(
  ownerId: string,
  sessionToken: string | null,
  input: FollowInput,
): Promise<string> {
  assertProvenance(input);
  const [row] = await sql<{ id: string }[]>`
    insert into tracked_signal (
      owner_id, session_id, symbol, intent, direction, setup_type, timeframe, market,
      entry_low, entry_high, entry_price, stop, target1, target2, confidence_at_follow,
      engine_version, config_hash, git_sha
    ) values (
      ${ownerId}, ${sessionToken}, ${input.symbol}, ${input.intent}, ${input.direction},
      ${input.setupType}, ${input.timeframe}, ${input.market ?? null},
      ${input.entryLow}, ${input.entryHigh}, ${input.entryPrice}, ${input.stop},
      ${input.target1}, ${input.target2}, ${input.confidenceAtFollow},
      ${input.engineVersion}, ${input.configHash}, ${input.gitSha}
    )
    returning id
  `;
  return row.id;
}

function rowToTracked(r: Record<string, unknown>): TrackedSignal {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    intent: r.intent as TrackedSignal["intent"],
    direction: r.direction as TrackedSignal["direction"],
    setupType: r.setup_type as TrackedSignal["setupType"],
    timeframe: r.timeframe as TrackedSignal["timeframe"],
    market: (r.market as MarketType | null) ?? undefined,
    entryLow: Number(r.entry_low),
    entryHigh: Number(r.entry_high),
    entryPrice: Number(r.entry_price),
    stop: Number(r.stop),
    target1: Number(r.target1),
    target2: Number(r.target2),
    confidenceAtFollow: Number(r.confidence_at_follow),
    followedAt: iso(r.followed_at as Date)!,
    status: r.status as TrackedSignal["status"],
    closePrice: r.close_price == null ? undefined : Number(r.close_price),
    closedAt: iso(r.closed_at as Date | null),
    resultR: r.result_r == null ? undefined : Number(r.result_r),
    engineVersion: r.engine_version as string,
    configHash: r.config_hash as string,
    gitSha: r.git_sha as string,
  };
}

export async function listOpenTracked(): Promise<TrackedSignal[]> {
  const rows = await sql`select * from tracked_signal where status = 'active'`;
  return rows.map((r) => rowToTracked(r as Record<string, unknown>));
}

export async function listTrackedByOwner(ownerId: string): Promise<TrackedSignal[]> {
  const rows = await sql`
    select * from tracked_signal where owner_id = ${ownerId} order by followed_at desc
  `;
  return rows.map((r) => rowToTracked(r as Record<string, unknown>));
}

export async function patchTracked(id: string, patch: Partial<TrackedSignal>): Promise<void> {
  await sql`
    update tracked_signal set
      status = coalesce(${patch.status ?? null}, status),
      closed_at = coalesce(${patch.closedAt ?? null}, closed_at),
      close_price = coalesce(${patch.closePrice ?? null}, close_price),
      result_r = coalesce(${patch.resultR ?? null}, result_r)
    where id = ${id}
  `;
}

// ── Backtest runs (Phase D) ──────────────────────────────────────────────────

export interface BacktestRunInput {
  kind: string;
  provenance: Provenance;
  params?: unknown;
  gateResults?: unknown;
  rawPath?: string;
  verdict?: string;
  note?: string;
}

export async function insertBacktestRun(input: BacktestRunInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into backtest_run (
      kind, engine_version, config_hash, git_sha,
      params_json, gate_results_json, raw_path, verdict, note
    ) values (
      ${input.kind}, ${input.provenance.engineVersion}, ${input.provenance.configHash},
      ${input.provenance.gitSha},
      ${input.params == null ? null : json(input.params)},
      ${input.gateResults == null ? null : json(input.gateResults)},
      ${input.rawPath ?? null}, ${input.verdict ?? null}, ${input.note ?? null}
    )
    returning id
  `;
  return row.id;
}
