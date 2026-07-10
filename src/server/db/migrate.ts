import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "./client";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Minimal forward-only migration runner: applies every unseen `*.sql` file in
 * `migrations/` in lexical order, each in its own transaction, recording it in
 * `_migrations`. Deliberately dependency-free — one driver, transparent SQL.
 */
export async function migrate(): Promise<void> {
  await sql`
    create table if not exists _migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const done = new Set(
    (await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name),
  );
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const content = await readFile(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`insert into _migrations (name) values (${file})`;
    });
    console.log(`✓ applied ${file}`);
  }
  console.log("migrations up to date");
}

// `bun run src/server/db/migrate.ts`
if (import.meta.main) {
  migrate()
    .then(() => sql.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
