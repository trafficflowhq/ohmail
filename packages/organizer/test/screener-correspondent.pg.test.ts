import { afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { describe } from "vitest";
import { defineCorrespondentSuite } from "./_correspondent-suite.js";

/**
 * The same suite on REAL Postgres: the retro's per-sender transaction takes `FOR UPDATE` on the
 * held rows and the auto-act's gate reads beside the act's own locks, which PGlite does not
 * witness. Every read is scoped to the suite's own random accounts, so it is a safe co-tenant.
 */
const AVAILABLE = await realPgAvailable();
let sql: ReturnType<typeof postgres> | undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

if (AVAILABLE) {
  defineCorrespondentSuite("real Postgres", async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    return brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  });
} else {
  describe.skip("real Postgres — a correspondent is never first contact (no lane database)", () => {});
}
