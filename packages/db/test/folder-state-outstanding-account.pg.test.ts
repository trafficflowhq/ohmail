import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable, type makeTestDb } from "../src/testing.js";
import {
  controlFreshIntentWithoutTrigger, controlWithoutTrigger, drift, runFreshIntentShapes, runWriteShapes,
} from "./folder-state-outstanding-cases.js";

/**
 * MAIL 0160's COLUMN ON REAL POSTGRES: the write shapes of `folder-state-outstanding-account.test.ts`
 * through postgres-js, on a database of its own (the cases' ids are fixed, and the control drops
 * the trigger).
 */
type Db = Awaited<ReturnType<typeof makeTestDb>>;
const PG_UP = await realPgAvailable(PG_TEST_URL);
const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const urlFor = (name: string): string => { const u = new URL(PG_TEST_URL); u.pathname = `/${name}`; return u.toString(); };

describe.skipIf(!PG_UP)("mail 0160's column on real Postgres", () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];
  const clients: Array<ReturnType<typeof postgres>> = [];

  beforeAll(async () => {
    admin = postgres(PG_TEST_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end({ timeout: 5 }).catch(() => {})));
    await Promise.all(created.map((name) => admin?.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {})));
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  async function fresh(kind: string): Promise<Db> {
    const name = `ohmail_fso_${kind}_${SUFFIX}`;
    await admin.unsafe(`create database "${name}"`);
    created.push(name);
    await runMigrations(urlFor(name));
    const client = postgres(urlFor(name), { max: 1, onnotice: () => {} });
    clients.push(client);
    return brandDialect(drizzle(client), "pg") as unknown as Db;
  }

  it("is the message's account on every outstanding filing", async () => {
    const db = await fresh("t");
    expect(await runWriteShapes(db, "t")).toBe(6);
    expect(await drift(db)).toBe(0);
  }, 120_000);

  it("control: without the trigger the check sees the filing", async () => {
    const db = await fresh("c");
    await runWriteShapes(db, "c");
    await controlWithoutTrigger(db, false, "c");
  }, 120_000);

  it("mail 0163: a new filing resets its schedule, the same filing and a deferral keep it", async () => {
    const db = await fresh("fi");
    await runFreshIntentShapes(db, "fi");
    await controlFreshIntentWithoutTrigger(db, false, "fi");
  }, 120_000);
});
