import { makeTestDb } from "@trafficflow/db/testing";
import type { Tx } from "@trafficflow/db";
import { defineCorrespondentSuite } from "./_correspondent-suite.js";

/**
 * The correspondent predicate and the retro on the in-process store — PGlite here, and the
 * device's SQLite when the `sqlite` project runs this file: the sidecar runs the auto-act's gate
 * over that store. The act's own arm is `screener-correspondent-act.test.ts`; real Postgres is
 * the `.pg` twin, which runs both.
 */
defineCorrespondentSuite("in-process store", async () => (await makeTestDb()) as unknown as Tx, { act: false });
