import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { closePooledDbs, makePooledDb, POOLED_IDLE_TIMEOUT_S } from "../src/client.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * A POOLED CONNECTION CLOSES BEFORE ITS INSTANCE IS SUSPENDED. A suspended instance keeps its idle
 * client connections open at the pooler until it wakes, and on 2026-10-26 those of ~160 cold
 * instances filled the pooler's client cap. One second, inside the hosted API's quiet hold
 * (`QUIET_HOLD_MS`), which the platform bills at the instance's whole memory; the cost is one dial
 * on the first request after a second of quiet. The handle is built without connecting.
 */
const PG_UP = await realPgAvailable();
afterAll(async () => { await closePooledDbs(); });

describe("the pooled client's idle window", () => {
  it("is one second, read off the client the hosted API dials with", () => {
    expect(POOLED_IDLE_TIMEOUT_S).toBe(1);
    const db = makePooledDb("postgres://u:p@127.0.0.1:1/idle_timeout_probe") as unknown as { $client: { options: { idle_timeout: number } } };
    expect(db.$client.options.idle_timeout).toBe(POOLED_IDLE_TIMEOUT_S);
  });

  it.skipIf(!PG_UP)("an idle pooled connection is gone from the server 1.5 s after its last statement", async () => {
    const pooled = makePooledDb(PG_TEST_URL);
    const [row] = await pooled.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
    const watcher = postgres(PG_TEST_URL, { max: 1 });
    try {
      const alive = async (): Promise<number> =>
        Number((await watcher`select count(*)::int as n from pg_stat_activity where pid = ${row!.pid}`)[0]!.n);
      expect(await alive()).toBe(1);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await alive(), "the idle connection is still open at the server").toBe(0);
    } finally {
      await watcher.end({ timeout: 5 });
    }
  });
});
