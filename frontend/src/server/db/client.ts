import postgres from "postgres";

/**
 * Server-only Postgres client (postgres.js). Never import this from a client
 * component — it is reached only through server functions and API route
 * handlers, so Vite never bundles it into the browser build.
 *
 * The DB lives on the VPS (docker-compose.yml) next to the systemd units.
 * Connection comes from DATABASE_URL (prod: /etc/market-pulse.env; local dev
 * and the vitest DB-integration suite: frontend/.env, gitignored — see
 * .env.example), defaulting to a fresh dev container on :5435. The fallback is
 * never used in prod (the systemd unit always supplies DATABASE_URL).
 */
const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5435/market_pulse";

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
