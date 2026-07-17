import { sql } from "./client";
import type { AnticipatoryOpenInput, ShadowOpenInput } from "@/lib/engine/evaluate";
import type { HeldVerdict } from "@/lib/engine/hysteresis";
import type { AnticipatorySignal } from "@/lib/engine/anticipatory";
import type { MarketType } from "@/lib/engine/binance";
import { assertProvenance } from "@/lib/engine/version";
import type { Provenance } from "@/lib/engine/version";
import type { ShadowSignal } from "@/lib/engine/shadow";
import type { TrackedSignal } from "@/lib/engine/tracker";
import type {
  TokenEventInput,
  TokenEventKind,
  TokenEventSeverity,
} from "@/lib/engine/token-events";
import type { MarketContextSnapshotInput } from "@/lib/engine/external-context";
import type {
  CatalystCredibility,
  CatalystEventInput,
  CatalystKind,
} from "@/lib/engine/catalyst-events";

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

/** Full anticipatory record for one engine version — the record report's read. */
export async function loadAnticipatorySignals(
  engineVersion?: string,
): Promise<AnticipatorySignal[]> {
  const rows = engineVersion
    ? await sql`select * from anticipatory_signal where engine_version = ${engineVersion}`
    : await sql`select * from anticipatory_signal`;
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

/**
 * Owner-scoped removal (the tracker page's trash action). Scoping the delete
 * to `owner_id` in the same statement means a user can only ever remove their
 * own follows — a foreign id is a silent no-op, reported via the count.
 */
export async function deleteTrackedByOwner(ownerId: string, id: string): Promise<boolean> {
  const result = await sql`
    delete from tracked_signal where id = ${id} and owner_id = ${ownerId}
  `;
  return result.count > 0;
}

export async function listTrackedByOwner(ownerId: string): Promise<TrackedSignal[]> {
  const rows = await sql`
    select * from tracked_signal where owner_id = ${ownerId} order by followed_at desc
  `;
  return rows.map((r) => rowToTracked(r as Record<string, unknown>));
}

/** A settled follow together with who owns it — the follow-watch's read model. */
export interface SettledTrackedRow {
  signal: TrackedSignal;
  ownerId: string;
}

/** Follows settled after `sinceIso`, oldest first (the notification watcher's poll). */
export async function listSettledTrackedSince(sinceIso: string): Promise<SettledTrackedRow[]> {
  const rows = await sql`
    select * from tracked_signal
    where closed_at is not null and closed_at > ${sinceIso}
    order by closed_at asc
  `;
  return rows.map((r) => ({
    signal: rowToTracked(r as Record<string, unknown>),
    ownerId: (r as Record<string, unknown>).owner_id as string,
  }));
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

// ── Token events + watchlist (Phase 2.5) ─────────────────────────────────────

export interface TokenEventRow {
  id: string;
  symbol: string;
  kind: TokenEventKind;
  severity: TokenEventSeverity;
  title: string;
  body: string | null;
  source: string;
  url: string | null;
  publishedAt: string;
  createdAt: string;
}

function rowToTokenEvent(r: Record<string, unknown>): TokenEventRow {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    kind: r.kind as TokenEventKind,
    severity: r.severity as TokenEventSeverity,
    title: r.title as string,
    body: (r.body as string | null) ?? null,
    source: r.source as string,
    url: (r.url as string | null) ?? null,
    publishedAt: iso(r.published_at as Date)!,
    createdAt: iso(r.created_at as Date)!,
  };
}

/** Idempotent bulk insert — the dedup unique index makes re-ingestion a no-op. */
export async function insertTokenEvents(events: TokenEventInput[]): Promise<number> {
  let inserted = 0;
  for (const e of events) {
    const result = await sql`
      insert into token_event (
        symbol, kind, severity, title, body, source, url, published_at, dedup_key
      ) values (
        ${e.symbol}, ${e.kind}, ${e.severity}, ${e.title}, ${e.body},
        ${e.source}, ${e.url}, ${e.publishedAt}, ${e.dedupKey}
      )
      on conflict (dedup_key) do nothing
    `;
    inserted += result.count;
  }
  return inserted;
}

export async function listTokenEvents(symbol: string, limit = 20): Promise<TokenEventRow[]> {
  const rows = await sql`
    select * from token_event
    where symbol = ${symbol.toUpperCase()}
    order by published_at desc
    limit ${limit}
  `;
  return rows.map((r) => rowToTokenEvent(r as Record<string, unknown>));
}

/** Events ingested after `sinceIso`, oldest first — the event watcher's poll. */
export async function listTokenEventsSince(sinceIso: string): Promise<TokenEventRow[]> {
  const rows = await sql`
    select * from token_event where created_at > ${sinceIso} order by created_at asc
  `;
  return rows.map((r) => rowToTokenEvent(r as Record<string, unknown>));
}

/** Recent events for a set of symbols (the "relevant to me" view). */
export async function listTokenEventsForSymbols(
  symbols: string[],
  sinceIso: string,
  limit = 50,
): Promise<TokenEventRow[]> {
  if (symbols.length === 0) return [];
  const rows = await sql`
    select * from token_event
    where symbol in ${sql(symbols.map((s) => s.toUpperCase()))}
      and published_at > ${sinceIso}
    order by published_at desc
    limit ${limit}
  `;
  return rows.map((r) => rowToTokenEvent(r as Record<string, unknown>));
}

/**
 * Who must be told about an event on `symbol`: owners of an ACTIVE followed
 * signal on it, plus users watching it server-side. The union is the whole
 * relevance rule — events are stored for every universe token regardless.
 */
export async function tokenEventRecipients(symbol: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select distinct owner_id as user_id from tracked_signal
      where symbol = ${symbol.toUpperCase()} and status = 'active'
    union
    select user_id from user_watchlist where symbol = ${symbol.toUpperCase()}
  `;
  return rows.map((r) => r.user_id);
}

// ── External market context (breadth snapshots + ingest bookkeeping) ────────

export interface MarketContextRow {
  id: string;
  totalMcapUsd: number;
  btcDominance: number;
  ethDominance: number | null;
  mcapChange24hPct: number | null;
  source: string;
  fetchedAt: string;
}

function rowToMarketContext(r: Record<string, unknown>): MarketContextRow {
  return {
    id: r.id as string,
    totalMcapUsd: Number(r.total_mcap_usd),
    btcDominance: Number(r.btc_dominance),
    ethDominance: r.eth_dominance == null ? null : Number(r.eth_dominance),
    mcapChange24hPct: r.mcap_change_24h_pct == null ? null : Number(r.mcap_change_24h_pct),
    source: r.source as string,
    fetchedAt: iso(r.fetched_at as Date)!,
  };
}

export async function insertMarketContextSnapshot(
  input: MarketContextSnapshotInput,
): Promise<void> {
  await sql`
    insert into market_context_snapshot (
      total_mcap_usd, btc_dominance, eth_dominance, mcap_change_24h_pct, source
    ) values (
      ${input.totalMcapUsd}, ${input.btcDominance}, ${input.ethDominance},
      ${input.mcapChange24hPct}, ${input.source}
    )
  `;
}

export async function latestMarketContextSnapshot(): Promise<MarketContextRow | null> {
  const rows = await sql`
    select * from market_context_snapshot order by fetched_at desc limit 1
  `;
  return rows.length ? rowToMarketContext(rows[0] as Record<string, unknown>) : null;
}

/** The newest snapshot at or before `iso` — the "~24h ago" row for deltas. */
export async function marketContextSnapshotNear(isoTs: string): Promise<MarketContextRow | null> {
  const rows = await sql`
    select * from market_context_snapshot
    where fetched_at <= ${isoTs}
    order by fetched_at desc limit 1
  `;
  return rows.length ? rowToMarketContext(rows[0] as Record<string, unknown>) : null;
}

export async function pruneMarketContextSnapshots(olderThanIso: string): Promise<number> {
  const result = await sql`
    delete from market_context_snapshot where fetched_at < ${olderThanIso}
  `;
  return result.count;
}

export interface IngestStateRow {
  source: string;
  status: "ok" | "error" | "unconfigured";
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
}

/**
 * Record the outcome of one ingest attempt. `ok` refreshes last_ok_at and
 * clears nothing (the last error stays visible for postmortems); `error`
 * keeps last_ok_at so staleness can be computed from when data was last good.
 */
export async function upsertIngestState(
  source: string,
  status: IngestStateRow["status"],
  error?: string,
): Promise<void> {
  if (status === "ok") {
    await sql`
      insert into ingest_state (source, status, last_ok_at)
      values (${source}, 'ok', now())
      on conflict (source) do update
        set status = 'ok', last_ok_at = now(), updated_at = now()
    `;
    return;
  }
  await sql`
    insert into ingest_state (source, status, last_error, last_error_at)
    values (${source}, ${status}, ${error ?? null},
            ${status === "error" ? sql`now()` : null})
    on conflict (source) do update
      set status = ${status},
          last_error = coalesce(${error ?? null}, ingest_state.last_error),
          last_error_at = case when ${status} = 'error' then now()
                               else ingest_state.last_error_at end,
          updated_at = now()
  `;
}

export async function listIngestState(): Promise<IngestStateRow[]> {
  const rows = await sql`select * from ingest_state order by source`;
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      source: row.source as string,
      status: row.status as IngestStateRow["status"],
      lastOkAt: iso(row.last_ok_at as Date | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      lastErrorAt: iso(row.last_error_at as Date | null) ?? null,
      updatedAt: iso(row.updated_at as Date)!,
    };
  });
}

// ── Catalyst events (forward-looking calendar) ──────────────────────────────

export interface CatalystEventRow {
  id: string;
  symbol: string;
  kind: CatalystKind;
  title: string;
  description: string | null;
  occursAt: string;
  source: string;
  sourceId: string | null;
  url: string | null;
  credibility: CatalystCredibility | null;
  percentOfSupply: number | null;
  createdAt: string;
  updatedAt: string;
}

function rowToCatalystEvent(r: Record<string, unknown>): CatalystEventRow {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    kind: r.kind as CatalystKind,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    occursAt: iso(r.occurs_at as Date)!,
    source: r.source as string,
    sourceId: (r.source_id as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    credibility: (r.credibility as CatalystCredibility | null) ?? null,
    percentOfSupply: r.percent_of_supply == null ? null : Number(r.percent_of_supply),
    createdAt: iso(r.created_at as Date)!,
    updatedAt: iso(r.updated_at as Date)!,
  };
}

/**
 * Idempotent bulk upsert. Deliberately DO UPDATE (unlike token_event's
 * do-nothing): calendar entries get rescheduled and re-scored, and the newest
 * provider read must win.
 */
export async function upsertCatalystEvents(events: CatalystEventInput[]): Promise<number> {
  let written = 0;
  for (const e of events) {
    const result = await sql`
      insert into catalyst_event (
        symbol, kind, title, description, occurs_at, source, source_id, url,
        credibility, percent_of_supply, dedup_key
      ) values (
        ${e.symbol}, ${e.kind}, ${e.title}, ${e.description}, ${e.occursAt},
        ${e.source}, ${e.sourceId}, ${e.url},
        ${e.credibility == null ? null : json(e.credibility)}, ${e.percentOfSupply},
        ${e.dedupKey}
      )
      on conflict (dedup_key) do update set
        occurs_at = excluded.occurs_at,
        title = excluded.title,
        description = excluded.description,
        url = excluded.url,
        credibility = excluded.credibility,
        percent_of_supply = excluded.percent_of_supply,
        updated_at = now()
    `;
    written += result.count;
  }
  return written;
}

export async function listUpcomingCatalystEvents(
  symbol: string,
  untilIso: string,
  limit = 10,
): Promise<CatalystEventRow[]> {
  const rows = await sql`
    select * from catalyst_event
    where symbol = ${symbol.toUpperCase()}
      and occurs_at >= now() and occurs_at <= ${untilIso}
    order by occurs_at asc
    limit ${limit}
  `;
  return rows.map((r) => rowToCatalystEvent(r as Record<string, unknown>));
}

/** Market-wide backdrop events: BTC/ETH plus the reserved MARKET pseudo-symbol. */
export async function listMarketCatalystEvents(
  untilIso: string,
  limit = 10,
): Promise<CatalystEventRow[]> {
  const rows = await sql`
    select * from catalyst_event
    where symbol in ('BTC', 'ETH', 'MARKET')
      and occurs_at >= now() and occurs_at <= ${untilIso}
    order by occurs_at asc
    limit ${limit}
  `;
  return rows.map((r) => rowToCatalystEvent(r as Record<string, unknown>));
}

/** Occurred events age out; the calendar is a forward-looking surface. */
export async function pruneCatalystEvents(olderThanIso: string): Promise<number> {
  const result = await sql`
    delete from catalyst_event where occurs_at < ${olderThanIso}
  `;
  return result.count;
}

export async function getWatchlist(userId: string): Promise<string[]> {
  const rows = await sql<{ symbol: string }[]>`
    select symbol from user_watchlist where user_id = ${userId} order by added_at
  `;
  return rows.map((r) => r.symbol);
}

/** Replace-all sync — the client store's full ticker list is the source shape. */
export async function putWatchlist(userId: string, symbols: string[]): Promise<void> {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, 200);
  await sql.begin(async (tx) => {
    await tx`delete from user_watchlist where user_id = ${userId}`;
    for (const symbol of unique) {
      await tx`insert into user_watchlist (user_id, symbol) values (${userId}, ${symbol})`;
    }
  });
}
