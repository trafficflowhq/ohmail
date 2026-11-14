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
import { accounts, mailboxes } from "@trafficflow/db";
import { A, B, GOLDEN, MIN, NOW, at, ctxFor, goldenAnswer, id, outstandingDrift, seed, svc, type Db } from "./helpers/mailbox-facts-seed.js";
import { loadRosterMailboxes, markMailboxSyncBlocked } from "../../../apps/worker/src/mailboxes.js";

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
    await seed(db);
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`drop database if exists "${NAME}" with (force)`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  it("answers the golden file byte for byte", async () => {
    const golden = readFileSync(fileURLToPath(new URL(GOLDEN, import.meta.url)), "utf8");
    expect(await goldenAnswer(db)).toBe(golden);
    expect(await outstandingDrift(db)).toBe(0);
  }, 60_000);

  /**
   * Which rows say whether mail is being fetched is the worker's own duty, not a second rule beside
   * it: the rows its roster serves on its cycle, a reader's and a quarantined one's among them, and
   * not the ones it leaves out and says so on (a closed account's, those past its capacity). The
   * pull's answer says it for an account that has such a row.
   */
  it("says whether mail is being fetched on the rows the worker is on duty for, and to a pull of their account", async () => {
    const closed = id("c0"), crowded = id("d0");
    await db.insert(accounts).values([{ id: closed, name: "mfb-closed" }, { id: crowded, name: "mfb-crowded" }]);
    await db.insert(mailboxes).values([
      { id: id("c1"), accountId: closed, provider: "imap", address: "c1@example.test", createdAt: at(MIN), organizerRole: "reader" },
      { id: id("d1"), accountId: crowded, provider: "imap", address: "d1@example.test", createdAt: at(2 * MIN) },
      { id: id("d2"), accountId: crowded, provider: "imap", address: "d2@example.test", createdAt: at(3 * MIN) },
    ]);
    // One roster pass as the worker makes it: the host names the closed account, the cap drops the
    // newest row, and the worker's own writer says so on the rows it left out.
    const roster = await loadRosterMailboxes(db as never, {}, NOW, async () => new Set([closed]));
    const served = roster.served.slice(0, -1);
    for (const m of roster.parked) await markMailboxSyncBlocked(db as never, m.mailboxId, "account_closed");
    for (const m of roster.served.slice(-1)) await markMailboxSyncBlocked(db as never, m.mailboxId, "at_capacity");
    const duty = new Set(served.map((m) => m.mailboxId));
    expect(roster.parked.map((m) => m.mailboxId)).toEqual([id("c1")]);
    expect([duty.has(id("d1")), duty.has(id("d2"))]).toEqual([true, false]);
    for (const account of [A, B, id("e0"), closed, crowded]) {
      const rows = await svc.list(ctxFor(db, account));
      for (const row of rows) {
        expect(row.fetching !== null, `${row.organizerRole} ${row.status} ${row.syncBlockedReason}`).toBe(duty.has(row.id));
      }
      const pull = await svc.requestPull(ctxFor(db, account));
      expect(pull.fetching !== null, account).toBe(rows.some((row) => duty.has(row.id)));
    }
  }, 60_000);
});
