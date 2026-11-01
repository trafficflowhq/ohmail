import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { like } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema, authThrottle } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { Tx } from "@trafficflow/db";
import { makeTestAuthDeps, reserveIpSlot, throttleKeysFor } from "@trafficflow/services";

/**
 * `reserveIpSlot` on real Postgres through postgres-js, the production driver: concurrent claims
 * on one key admit exactly `max` and the refused ones are not counted. The refusal is the
 * statement's `WHERE` declining the update; PGlite runs one statement at a time, so only here do
 * several connections race for the last slots. Every key is this run's own namespace, removed after.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const NS = `fr3-pg-${randomUUID()}`;

describe.skipIf(!PG_UP)("reserveIpSlot against the postgres-js driver", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 8 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterEach(async () => { await db.delete(authThrottle).where(like(authThrottle.key, `${NS}:%`)); });
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  const keys = throttleKeysFor(makeTestAuthDeps().keyProvider);
  const claim = (now: Date) => reserveIpSlot(db as unknown as Tx, keys, {
    namespace: NS, ip: "192.0.2.45", now, max: 4, windowMs: 60_000,
  });
  const failures = async () => (await db.select().from(authThrottle)
    .where(like(authThrottle.key, `${NS}:%`))).map((r) => r.failures);

  it("sixteen concurrent claims admit four, and the counter reads four", async () => {
    const now = new Date();
    expect(await claim(now)).toBe(true); // the row exists, so every racer takes the conflict arm
    const raced = await Promise.all(Array.from({ length: 15 }, () => claim(now)));
    expect(raced.filter(Boolean)).toHaveLength(3);
    expect(await failures()).toEqual([4]);

    // A refused claim after the race is still refused, and still not counted.
    expect(await claim(now)).toBe(false);
    expect(await failures()).toEqual([4]);
    // The window rolls on the conflict arm too: the first claim past it is admitted at 1.
    expect(await claim(new Date(now.getTime() + 60_001))).toBe(true);
    expect(await failures()).toEqual([1]);
  });
});
