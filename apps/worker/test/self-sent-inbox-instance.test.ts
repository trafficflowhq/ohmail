import type { Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { describeSelfSent } from "./_self-sent-suite.js";

/**
 * A letter to yourself, on the stores an install carries: PGlite (the desktop's engine) in the
 * default project, SQLite (the phone's) in `test/vitest.sqlite.config.ts`. The Postgres half — the
 * Cloud worker's store — is `self-sent-inbox-instance.pg.test.ts`, over the same suite.
 */
describeSelfSent(process.env.OHMAIL_TEST_DIALECT === "sqlite" ? "SQLite" : "PGlite",
  async () => (await makeTestDb()) as unknown as Tx);
