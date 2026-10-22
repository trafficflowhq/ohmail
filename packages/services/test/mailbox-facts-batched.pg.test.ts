import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { schema } from "@trafficflow/db/cloud";
import { GOLDEN, goldenAnswer, outstandingDrift, seed, type Db } from "./helpers/mailbox-facts-seed.js";

/**
 * GET /mailboxes on real Postgres answers the golden file PGlite and SQLite answer
 * (`mailbox-facts-batched.test.ts`), byte for byte. A database of its own: the seed's ids are fixed.
 */
const PG_UP = await realPgAvailable(PG_TEST_URL);
const NAME = `ohmail_mfgolden_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const urlFor = (name: string): string => { const u = new URL(PG_TEST_URL); u.pathname = `/${name}`; return u.toString(); };

describe.skipIf(!PG_UP)("the mailbox facts on real Postgres", () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres> | undefined;
  let db: Db;

  beforeAll(async () => {
    admin = postgres(PG_TEST_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${NAME}"`);
    await runMigrations(urlFor(NAME));
    client = postgres(urlFor(NAME), { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Db;
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`drop database if exists "${NAME}" with (force)`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  it("answers the golden file byte for byte", async () => {
    await seed(db);
    const golden = readFileSync(fileURLToPath(new URL(GOLDEN, import.meta.url)), "utf8");
    expect(await goldenAnswer(db)).toBe(golden);
    expect(await outstandingDrift(db)).toBe(0);
  }, 60_000);
});
