import { afterAll, beforeAll, describe, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { cutlineMatchesGrouped, seed, walksMatch, type Db } from "./_screener-same-answer.js";

/**
 * THE SAME COMPARISON ON THE SERVER'S POSTGRES — the per-message cutline, the claim gate and the total
 * folded into the page reach Cloud's `GET /screener`, its consent counts and the worker's Screener
 * passes, so old and new are held equal on the store those run on too. Writes are INSERTs under a
 * fresh account per case; every read is scoped to it.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: Db;

describe.skipIf(!PG_UP)("the Screener's reads answer what they answered before, on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Db;
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("the cutline asked per message names the same senders as the grouped form, under every window", async () => {
    await cutlineMatchesGrouped(await seed(db));
  });

  it("every page of every walk and the first page's total are equal, row for row", async () => {
    await walksMatch(await seed(db));
  });
});
