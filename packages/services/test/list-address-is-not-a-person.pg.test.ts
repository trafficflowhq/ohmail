import { afterAll, beforeAll, describe, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { readerDoorListClaim, type Db } from "./helpers/list-claim-reader-door.js";

/**
 * A LIST'S CLAIM SCREENED OUT AT A READER'S DOOR, ON THE SERVER'S POSTGRES (mail 0150): the door's
 * transaction and the holder's drain as Cloud runs them. The PGlite half is in
 * `list-address-is-not-a-person.test.ts`. Each case writes under a fresh account.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: Db;

describe.skipIf(!PG_UP)("a list claim screened out where another install organizes every mailbox, on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Db;
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("asks the claim's holder to move it alone: the list's rule and letters stand, nothing is learned or unsubscribed", async () => {
    await readerDoorListClaim(db);
  });
});
