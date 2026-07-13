/**
 * Record-review report (P2.3) — the evidence-quality artifact the Phase 3
 * pre-registered verdict will read from. Read-only over the forward-test
 * system of record; prints markdown to stdout.
 *
 *   bun run src/server/scripts/record-report.ts             # current engine
 *   bun run src/server/scripts/record-report.ts --engine 0.9.0-dev
 *
 * Shows: overall shadow record with Wilson 95% CIs and avg R ± SE, expiry
 * rate, spot/perp segmentation, per setup×regime cells with report-only
 * shrinkage (EDR 0011 — this math must never feed the demotion path),
 * anticipatory fill-model progress against its graduation gate, and a
 * throughput projection toward the Phase 3 n≥150 sample gate.
 */
import { sql } from "../db/client";
import { loadAnticipatorySignals, loadShadowSignals } from "../db/repo";
import { meanWithSe, shrunkRate, wilson95 } from "../forward-test/report-stats";
import { MIN_ANTICIPATORY_RECORD_TRADES } from "@/lib/engine/anticipatory";
import { MIN_SHADOW_RECORD_TRADES } from "@/lib/engine/shadow";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { WORKER_UNIVERSE } from "@/lib/engine/market";
import type { ShadowSignal } from "@/lib/engine/shadow";

const PHASE3_GATE_N = 150;

const argIdx = process.argv.indexOf("--engine");
const engineVersion = argIdx >= 0 ? process.argv[argIdx + 1] : ENGINE_VERSION;

/**
 * --integrity: counts/provenance/gate-progress ONLY — no outcome aggregates.
 * This is the only mode permitted against the live 1.0.0 record between the
 * verdict-protocol registration and its n-gate (research/
 * verdict-protocol-1.0.0.md §8): interim looks at win rates or R would turn
 * the pre-registered analysis into a peek-adjusted one.
 */
if (process.argv.includes("--integrity")) {
  const [row] = await sql<
    {
      total: number;
      settled: number;
      misstamped: number;
      versions: string;
      markets: string;
      last_open: string | null;
    }[]
  >`
    select count(*)::int as total,
           count(*) filter (where status <> 'active')::int as settled,
           count(*) filter (where engine_version = '' or config_hash = '' or git_sha = '')::int as misstamped,
           coalesce(string_agg(distinct engine_version, ','), '') as versions,
           coalesce(string_agg(distinct market, ','), '') as markets,
           max(opened_at)::text as last_open
    from shadow_signal
  `;
  const [cohort] = await sql<{ matured_settled: number }[]>`
    select count(*)::int as matured_settled
    from shadow_signal
    where engine_version = ${engineVersion}
      and market = 'spot'
      and status <> 'active'
      and opened_at > '2026-07-12T11:00:00Z'
  `;
  console.log(
    `integrity: total=${row.total} settled=${row.settled} misstamped=${row.misstamped}` +
      ` versions=[${row.versions}] markets=[${row.markets}] lastOpen=${row.last_open}`,
  );
  console.log(
    `verdict-protocol primary cohort (spot, post-2026-07-12T11:00Z): settled=${cohort.matured_settled}/${PHASE3_GATE_N}`,
  );
  await sql.end();
  process.exit(0);
}

/**
 * --context: external-context plane integrity — catalyst calendar counts,
 * orphaned symbols (rows whose ticker left the worker universe), breadth
 * snapshot gaps, per-source ingest state. No forward-test outcome data at all,
 * so it is verdict-protocol-safe by construction.
 */
if (process.argv.includes("--context")) {
  const universe = WORKER_UNIVERSE.map((u) => u.ticker);
  const kinds = await sql<{ kind: string; n: number }[]>`
    select kind, count(*)::int as n from catalyst_event
    where occurs_at >= now() and occurs_at <= now() + interval '7 days'
    group by kind order by n desc
  `;
  const [orphans] = await sql<{ n: number; symbols: string }[]>`
    select count(*)::int as n, coalesce(string_agg(distinct symbol, ','), '') as symbols
    from catalyst_event
    where symbol <> 'MARKET' and symbol not in ${sql(universe)}
  `;
  // A gap > 2× the 15-min cadence between consecutive breadth snapshots in the
  // last 24h means the poller missed passes (worker down or provider erroring).
  const [gaps] = await sql<{ n: number }[]>`
    select count(*)::int as n from (
      select fetched_at - lag(fetched_at) over (order by fetched_at) as gap
      from market_context_snapshot
      where fetched_at > now() - interval '24 hours'
    ) g where g.gap > interval '30 minutes'
  `;
  const ingest = await sql<{ source: string; status: string; last_ok_at: string | null }[]>`
    select source, status, last_ok_at::text from ingest_state order by source
  `;
  console.log(
    `context: upcoming7d=[${kinds.map((k) => `${k.kind}=${k.n}`).join(" ") || "none"}]` +
      ` orphans=${orphans.n}${orphans.n > 0 ? ` (${orphans.symbols})` : ""}` +
      ` snapshotGaps24h=${gaps.n}`,
  );
  for (const s of ingest) {
    console.log(`  source ${s.source}: ${s.status} lastOk=${s.last_ok_at ?? "never"}`);
  }
  await sql.end();
  process.exit(0);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtR(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
}

function line(cells: (string | number)[]): string {
  return `| ${cells.join(" | ")} |`;
}

interface Cohort {
  label: string;
  settled: ShadowSignal[];
}

function summarize(c: Cohort, pooledWinRate: number | null): string {
  const wins = c.settled.filter((s) => (s.resultR ?? 0) > 0).length;
  const expired = c.settled.filter((s) => s.status === "expired").length;
  const n = c.settled.length;
  const iv = wilson95(wins, n);
  const r = meanWithSe(c.settled.map((s) => s.resultR ?? 0));
  const shrunk =
    pooledWinRate !== null && iv ? ` → shrunk ${pct(shrunkRate(wins, n, pooledWinRate))}` : "";
  return line([
    c.label,
    n,
    iv ? `${pct(iv.p)} [${pct(iv.low)}–${pct(iv.high)}]${shrunk}` : "—",
    r ? `${fmtR(r.mean)}${r.se !== null ? ` ± ${r.se.toFixed(2)}` : ""}` : "—",
    n ? pct(expired / n) : "—",
  ]);
}

const shadow = await loadShadowSignals(engineVersion);
const settled = shadow.filter((s) => s.status !== "active");
const wins = settled.filter((s) => (s.resultR ?? 0) > 0).length;
const pooledWinRate = settled.length ? wins / settled.length : null;

console.log(`# Forward-test record review — engine ${engineVersion}`);
console.log(`\nGenerated ${new Date().toISOString()} · read-only (EDR 0011)\n`);

// ── Overall + segmentation ──────────────────────────────────────────────────
console.log(`## Shadow record (${shadow.length} opened, ${settled.length} settled)\n`);
console.log(line(["Cohort", "n", "Win rate [Wilson 95%]", "Avg R ± SE", "Expired"]));
console.log(line(["---", "---", "---", "---", "---"]));
console.log(summarize({ label: "**All settled**", settled }, null));
for (const market of ["spot", "perp"] as const) {
  const cohort = settled.filter((s) => s.market === market);
  if (cohort.length > 0) console.log(summarize({ label: market, settled: cohort }, null));
}
const expiredAll = settled.filter((s) => s.status === "expired").length;
if (settled.length > 0 && expiredAll / settled.length > 0.2) {
  console.log(
    `\n> ⚠ ${pct(expiredAll / settled.length)} of settled calls expired (hit neither level` +
      ` within the intent horizon) — they dilute win-rate/expectancy readings; Phase 3's` +
      ` pre-registration must decide how to treat them.`,
  );
}

// ── Per setup×regime cells ──────────────────────────────────────────────────
const cells = new Map<string, ShadowSignal[]>();
for (const s of settled) {
  const key = `${s.setupType} × ${s.regime}`;
  cells.set(key, [...(cells.get(key) ?? []), s]);
}
console.log(
  `\n## By setup × regime (shrinkage prior m=15 toward pooled ${pct(pooledWinRate ?? 0)}; report-only)\n`,
);
console.log(line(["Cell", "n", "Win rate [Wilson 95%] → shrunk", "Avg R ± SE", "Expired"]));
console.log(line(["---", "---", "---", "---", "---"]));
for (const [label, cohort] of [...cells.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(summarize({ label, settled: cohort }, pooledWinRate));
}
console.log(
  `\nDemotion (the live rule) needs n ≥ ${MIN_SHADOW_RECORD_TRADES} per cell with negative avg R;` +
    ` cells above that bar today: ${
      [...cells.values()].filter((c) => c.length >= MIN_SHADOW_RECORD_TRADES).length
    } of ${cells.size}.`,
);

// ── Anticipatory fill model ─────────────────────────────────────────────────
const anticipatory = await loadAnticipatorySignals(engineVersion);
const decided = anticipatory.filter((a) => a.status !== "pending");
const filled = decided.filter((a) => a.status !== "never-filled");
const fillSettled = filled.filter((a) => a.status !== "filled");
console.log(
  `\n## Anticipatory fill model (graduation gate: ${MIN_ANTICIPATORY_RECORD_TRADES} settled fills)\n`,
);
console.log(
  `- opened ${anticipatory.length} · decided ${decided.length} · filled ${filled.length}` +
    ` (fill rate ${decided.length ? pct(filled.length / decided.length) : "—"})`,
);
const fillR = meanWithSe(
  fillSettled.filter((a) => a.resultR !== undefined).map((a) => a.resultR ?? 0),
);
console.log(
  `- settled fills ${fillSettled.length}/${MIN_ANTICIPATORY_RECORD_TRADES} toward the gate` +
    (fillR
      ? ` · avg ${fmtR(fillR.mean)}${fillR.se !== null ? ` ± ${fillR.se.toFixed(2)}` : ""}`
      : ""),
);

// ── Throughput toward the Phase 3 gate ──────────────────────────────────────
const settleTimes = settled
  .map((s) => Date.parse(s.closedAt ?? ""))
  .filter((t) => Number.isFinite(t))
  .sort((a, b) => a - b);
if (settleTimes.length >= 2) {
  const spanDays = (settleTimes[settleTimes.length - 1] - settleTimes[0]) / 86_400_000;
  const perDay = spanDays > 0 ? settled.length / spanDays : null;
  const remaining = Math.max(0, PHASE3_GATE_N - settled.length);
  console.log(`\n## Phase 3 gate (n ≥ ${PHASE3_GATE_N} settled)\n`);
  console.log(
    `- ${settled.length} settled over ${spanDays.toFixed(1)} days` +
      (perDay
        ? ` (~${perDay.toFixed(1)}/day) → ~${Math.ceil(remaining / perDay)} days to the gate` +
          ` at the observed rate (before the P2.1 universe expansion takes effect)`
        : ""),
  );
}

// ── Provenance sanity ───────────────────────────────────────────────────────
const [prov] = await sql<{ versions: string; bad: number }[]>`
  select string_agg(distinct engine_version, ', ') as versions,
         count(*) filter (where engine_version = '' or config_hash = '' or git_sha = '') as bad
  from shadow_signal
`;
console.log(
  `\n---\nAll versions in table: ${prov.versions ?? "(none)"} · mis-stamped rows: ${prov.bad}`,
);

await sql.end();
