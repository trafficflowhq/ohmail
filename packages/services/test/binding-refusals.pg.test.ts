import { afterAll, describe } from "vitest";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { Db } from "../src/context.js";
import { bindingRefusalCases } from "./helpers/binding-refusal-cases.js";

const AVAILABLE = await realPgAvailable();

/** The same refusals on a server's pool, as its factory makes it. */
describe.skipIf(!AVAILABLE)("a transaction on a handle that does not name its context's account: a server's pool", () => {
  let owned: OwnedDb | undefined;
  afterAll(async () => { await owned?.close(); });
  bindingRefusalCases(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL, { role: "api" });
    return owned.db as unknown as Db;
  });
});
