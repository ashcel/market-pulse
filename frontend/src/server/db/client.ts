import postgres from "postgres";

/**
 * Server-only Postgres client (postgres.js). Never import this from a client
 * component — it is reached only through server functions, API route handlers,
 * and the worker, so Vite never bundles it into the browser build.
 *
 * The forward-test record is the system of record; the DB lives on the VPS
 * (docker-compose.yml) next to the systemd units. Connection comes from
 * DATABASE_URL, defaulting to the local dev container on :5435.
 */
// TODO(rotation): once deploy/rotate-db-credentials.sh has run on the VPS
// (DATABASE_URL then comes from /etc/market-pulse.env), change this fallback
// to postgres:postgres — it only exists so prod keeps working pre-rotation.
const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:hermes3369@localhost:5435/market_pulse";

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
