import { describe } from "vitest";

/**
 * Guard for the DB-integration suites (`src/server/db/*.test.ts`), which open a
 * real Postgres connection and write/delete rows.
 *
 * This repo is developed **on the production VPS**, so a bare `DATABASE_URL`
 * points at the live database. These suites must never run there: they mutate
 * shared tables, and some repo reads (`latestMarketContextSnapshot`,
 * `marketContextSnapshotNear`) are global, so live rows written by the arq
 * worker make assertions non-deterministic.
 *
 * The contract, enforced together with `client.ts`:
 *   - Opt in by pointing `TEST_DATABASE_URL` at a throwaway/isolated database
 *     (see `.env.example` — create `market_pulse_test` and `db:migrate` it).
 *   - Without a distinct `TEST_DATABASE_URL`, these suites **skip** (below) and
 *     `client.ts` routes vitest's connection to an unroutable sentinel rather
 *     than `DATABASE_URL`, so even an unguarded stray query can't hit prod.
 *
 * `TEST_DATABASE_URL === DATABASE_URL` is treated as "no test DB" (skip): that
 * is the production database, not an isolated one.
 */
const testDbUrl = process.env.TEST_DATABASE_URL;
export const hasTestDatabase = !!testDbUrl && testDbUrl !== process.env.DATABASE_URL;

/** Use in place of `describe` for any suite that touches the database. */
export const describeDb = hasTestDatabase ? describe : describe.skip;
