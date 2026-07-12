import { sql } from "../db/client";
import { countOpenRecords, finishEngineRun, startEngineRun } from "../db/repo";
import { runEvalPass } from "./eval-pass";
import { runSettlePass } from "./settle-pass";
import { WORKER_UNIVERSE } from "@/lib/engine/market";
import { currentProvenance } from "@/lib/engine/version";

/**
 * The forward-test worker (Phase C) — the system of record. Runs as its own
 * process (a second systemd unit: `market-pulse-worker`) alongside the web
 * server so evaluation stays off the request path and survives web restarts.
 *
 *   bun run src/server/worker/index.ts          # loop forever
 *   bun run src/server/worker/index.ts --once    # a single pass (CI / cron)
 *
 * Each tick: one eval pass (open records over the whole universe) + one settle
 * pass (walk klines for every open record). Both are idempotent — the partial
 * unique indexes de-dup open records and the kline walk is catch-up safe.
 */
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5 * 60_000);

export async function runOnce(): Promise<void> {
  const prov = currentProvenance();
  const runId = await startEngineRun(prov, {
    symbols: WORKER_UNIVERSE.map((u) => u.ticker),
    markets: ["spot", "perp"],
  });
  const startedAt = Date.now();
  try {
    // Two eval passes per tick (P1.3): spot, then perp with real funding/OI
    // context — so the perp-mode verdicts the UI shows are forward-tested too.
    const spot = await runEvalPass(runId, "spot");
    const perp = await runEvalPass(runId, "perp");
    const settleResult = await runSettlePass();
    const open = await countOpenRecords();
    await finishEngineRun(
      runId,
      "ok",
      `evaluated=${spot.evaluated}+${perp.evaluated}p ` +
        `shadowOpened=${spot.shadowOpened + perp.shadowOpened} ` +
        `anticipatoryOpened=${spot.anticipatoryOpened + perp.anticipatoryOpened} ` +
        `settled=${settleResult.settled}`,
    );
    // One line per pass — this is the heartbeat `/api/forward-test?view=health`
    // reports on: as long as this keeps appearing in `journalctl -u
    // market-pulse-worker`, the worker is alive and the record is growing.
    console.log(
      `[worker] pass ok in ${Date.now() - startedAt}ms — ` +
        `evaluated=${spot.evaluated}spot+${perp.evaluated}perp ` +
        `shadow+=${spot.shadowOpened + perp.shadowOpened} ` +
        `anticipatory+=${spot.anticipatoryOpened + perp.anticipatoryOpened} ` +
        `settled=${settleResult.settled} ` +
        `open(shadow=${open.shadow} anticipatory=${open.anticipatory} tracked=${open.tracked}) ` +
        `(engine ${prov.engineVersion} / cfg ${prov.configHash})`,
    );
  } catch (err) {
    await finishEngineRun(runId, "error", (err as Error).message).catch(() => {});
    console.error("[worker] pass failed:", err);
    throw err;
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await runOnce();
    await sql.end();
    return;
  }
  console.log(`[worker] starting loop, interval=${INTERVAL_MS}ms`);
  // Kick immediately, then on the interval. A running pass is never overlapped.
  for (;;) {
    await runOnce().catch(() => {});
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
