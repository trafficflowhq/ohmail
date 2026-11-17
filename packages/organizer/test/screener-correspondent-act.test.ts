import { makeTestDb } from "@trafficflow/db/testing";
import type { Tx } from "@trafficflow/db";
import { defineCorrespondentSuite } from "./_correspondent-suite.js";

/**
 * The auto-act's correspondent gate on PGlite. Not in the `sqlite` project: on the device store
 * the act's own filing refuses before this change could matter (gap row
 * DEVICE-STORE-AUTO-ACT-FILING-REFUSED), so the stranger control has nothing to read there.
 */
defineCorrespondentSuite("in-process store, the act", async () => (await makeTestDb()) as unknown as Tx);
