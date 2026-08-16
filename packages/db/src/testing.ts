import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { adoptBaseline } from "./baseline.js";
import { JOURNALS } from "./migrate.js";
import { schema } from "./schema.js";

/**
 * Create an in-process PGlite-backed Drizzle client with all migrations applied.
 * Used by tests only — no external DB, no network. Each call yields a fresh,
 * isolated in-memory database.
 *
 * It runs the SAME sequence production does — **adopt → mail → cloud**, in
 * {@link JOURNALS} order — so the whole suite exercises the two-journal path rather than a
 * test-only shortcut. Adoption is always a no-op here (a brand-new PGlite database hits the
 * `fresh` cell of the truth table), and it is still called rather than skipped: a code path that
 * only production takes is a code path nothing checks.
 */
export async function makeTestDb(): Promise<PgliteDatabase<typeof schema>> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  for (const spec of JOURNALS) {
    await adoptBaseline(db, spec);
    await migrate(db, { migrationsFolder: spec.dir, migrationsSchema: spec.migrationsSchema });
  }
  return db;
}

/** The real-Postgres URL every `*.pg.test.ts` uses (docker compose service on :5433). */
export const PG_TEST_URL = process.env.DATABASE_URL_PG_TEST
  ?? process.env.DATABASE_URL_SESSION
  ?? process.env.DATABASE_URL
  ?? "postgres://tf:tf@localhost:5433/trafficflow_test";

/** Set this to `1` in CI so a missing Postgres FAILS the suite instead of skipping it. */
export const REQUIRE_PG_ENV = "TF_REQUIRE_PG";

/**
 * Is a real Postgres reachable — and is it ALLOWED to be missing?
 *
 * `*.pg.test.ts` files host the assertions PGlite structurally cannot: real concurrency across
 * separate connections, `pg_trgm`, and `setupProdDatabase` itself. They have always degraded to
 * `describe.skipIf` when docker was not running, which keeps the suite usable on a laptop — and
 * which also means the decisive cases can vanish silently and the run still exits 0. A gate that
 * can disappear is not a gate.
 *
 * So the skip is now a LOCAL convenience with an explicit opt-out: with
 * `TF_REQUIRE_PG=1` (what `pnpm test:pg` and CI set) an unreachable Postgres THROWS here, and the
 * file fails loudly instead of quietly not running. `pnpm test` on a laptop behaves exactly as
 * before.
 */
export async function realPgAvailable(url: string = PG_TEST_URL): Promise<boolean> {
  const c = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  let up = false;
  try {
    await c`select 1`;
    up = true;
  } catch {
    up = false;
  } finally {
    await c.end({ timeout: 2 }).catch(() => {});
  }
  if (!up && process.env[REQUIRE_PG_ENV] === "1") {
    throw new Error(
      `${REQUIRE_PG_ENV}=1 but no Postgres is reachable at ${new URL(url).host} — ` +
        "start it (docker compose up -d) or unset the variable. These tests are not optional in CI.",
    );
  }
  return up;
}
