import { afterAll, beforeAll, describe, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  beltArm, claimedUndoArm, oneOverrideArm, patchArm, pauseArm, undoArm, unmarkedDemotes, world, type Db,
} from "./_press-seed-move-route.js";

/**
 * THE SAME CASES ON THE SERVER'S POSTGRES: the override window and the demotion's UPDATE run on
 * the store Cloud runs them on. A fresh account per case; every read is scoped to it.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: Db;

describe.skipIf(!PG_UP)("a sheet press's seed move is not an override of the route it rewrites, on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Db;
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("the PATCH after a marked seed move leaves the rule on, at the place pressed", async () => { await patchArm(await world(db)); });
  it("Undo inside the window leaves the learned rule as it was", async () => { await undoArm(await world(db)); });
  it("Undo of a claimed press (marked inverse) leaves the learned rule on", async () => { await claimedUndoArm(await world(db), true); });
  it("POSITIVE CONTROL: an unmarked inverse of a claimed press demotes the route", async () => { await claimedUndoArm(await world(db), false); });
  it("POSITIVE CONTROL: unmarked, the same move demotes the route", async () => { await unmarkedDemotes(await world(db)); });
  it("an older client's PATCH naming a place switches the demoted row back on", async () => { await beltArm(await world(db)); });
  it("CONTROL: with one override only the rule stays on and moves", async () => { await oneOverrideArm(await world(db)); });
  it("CONTROL: a person's pause stays off under a destination PATCH", async () => { await pauseArm(await world(db)); });
});
