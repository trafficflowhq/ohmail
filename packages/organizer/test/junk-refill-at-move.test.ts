import { makeTestDb } from "@trafficflow/db/testing";
import type { Tx } from "@trafficflow/db";
import { defineJunkRefillSuite } from "./_junk-refill-suite.js";

/** The refill at the move, on PGlite. Real Postgres is the `.pg` twin; the adapter is a double. */
defineJunkRefillSuite("in-process store", async () => (await makeTestDb()) as unknown as Tx);
