import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { waitingFixture } from "./_screener-waiting-count.js";

/** The per-mailbox waiting count on the server's own store (`screener-waiting-count.test.ts`). */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!PG_UP)("waitingCount on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("the first mailbox counts 3, the second 2, and each equals the queue's senders held there", async () => {
    const w = await waitingFixture(db);
    expect(await w.svc.waitingCount(w.ctx(), w.m1)).toEqual({ senders: 3 });
    expect(await w.svc.waitingCount(w.ctx(), w.m2)).toEqual({ senders: 2 });
    const listed = await w.listed();
    for (const mb of [w.m1, w.m2]) {
      const here = [];
      for (const s of listed) if (await w.heldIn(mb, s)) here.push(s);
      expect((await w.svc.waitingCount(w.ctx(), mb)).senders).toBe(here.length);
    }
  });

  it("CONTROL: a single mailbox equals the queue's total", async () => {
    const w = await waitingFixture(db, { single: true });
    expect(await w.svc.waitingCount(w.ctx(), w.m1)).toEqual({ senders: (await w.svc.list(w.ctx())).total });
  });
});
