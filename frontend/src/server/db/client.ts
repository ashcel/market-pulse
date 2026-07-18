import postgres from "postgres";

/**
 * Server-only Postgres client (postgres.js). Never import this from a client
 * component — it is reached only through server functions and API route
 * handlers, so Vite never bundles it into the browser build.
 *
 * The DB lives on the VPS (docker-compose.yml) next to the systemd units.
 * Connection comes from DATABASE_URL (prod: /etc/market-pulse.env; local dev:
 * frontend/.env, gitignored — see .env.example), defaulting to a fresh dev
 * container on :5435. The fallback is never used in prod (the systemd unit
 * always supplies DATABASE_URL).
 *
 * Under vitest the connection is routed to TEST_DATABASE_URL instead and
 * *never* falls through to DATABASE_URL: this repo runs on the prod VPS, so
 * the DB-integration suite must only ever touch an isolated throwaway DB (see
 * db-test-guard.ts). With no TEST_DATABASE_URL set, we point at an unroutable
 * sentinel so any stray query fails loudly rather than hitting production.
 */
const underVitest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
const connectionString = underVitest
  ? (process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:1/isolated_test_db_required")
  : (process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5435/market_pulse");

// Reuse one pool across dev server reloads / HMR.
const globalForDb = globalThis as unknown as { __mpSql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.__mpSql ??
  postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    onnotice: () => {},
  });

if (process.env.NODE_ENV !== "production") globalForDb.__mpSql = sql;

export type Sql = typeof sql;
