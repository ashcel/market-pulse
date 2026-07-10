import { readFile } from "node:fs/promises";

import { sql } from "../db/client";
import { insertBacktestRun } from "../db/repo";
import { currentProvenance } from "@/lib/engine/version";

/**
 * Phase D — persist a gated backtest / spike run so results are queryable and
 * diffable across engine versions instead of living as loose JSON under
 * research/scripts. The raw file is kept; its gate table becomes a row.
 *
 *   bun run src/server/scripts/record-backtest.ts \
 *     --kind g1-spike \
 *     --raw research/scripts/phase2-spike/results-2026-07-10.json \
 *     --verdict "cross-TF retained" \
 *     --note "Gate B failed sample floor"
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const kind = arg("kind");
  if (!kind) throw new Error("--kind is required");
  const rawPath = arg("raw");
  let gateResults: unknown;
  if (rawPath) {
    try {
      gateResults = JSON.parse(await readFile(rawPath, "utf8"));
    } catch (err) {
      console.warn(`could not read/parse ${rawPath}: ${(err as Error).message}`);
    }
  }

  const id = await insertBacktestRun({
    kind,
    provenance: currentProvenance(),
    gateResults,
    rawPath,
    verdict: arg("verdict"),
    note: arg("note"),
  });
  console.log(`✓ recorded backtest_run ${id} (kind=${kind})`);
}

main()
  .then(() => sql.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
