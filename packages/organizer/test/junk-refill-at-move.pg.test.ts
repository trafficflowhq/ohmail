import { afterAll, describe } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { defineJunkRefillSuite } from "./_junk-refill-suite.js";

/**
 * The same refill on REAL Postgres: the rewrite takes `FOR UPDATE` on the body row inside the
 * completion's own write group, the class PGlite does not witness. Scoped to its own accounts.
 */
const AVAILABLE = await realPgAvailable();
let sql: ReturnType<typeof postgres> | undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

if (AVAILABLE) {
  defineJunkRefillSuite("real Postgres", async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    return brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  });
} else {
  describe.skip("real Postgres — a message moved out of Junk has its text back (no lane database)", () => {});
}
