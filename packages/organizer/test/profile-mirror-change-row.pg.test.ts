import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { accounts, changeLog, mailboxes, mailboxProfileMirror, recordChange } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { applyProfileRead } from "../src/profile.js";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * THE MIRROR WRITE AND ITS CHANGE ROW ARE ONE TRANSACTION — real Postgres, live connections. A
 * reader's cached document reaches every other surface only on the delta, so a mirror row a
 * surface can see without its `mailbox_profile` change row is an arrangement nobody is told of.
 * PGlite is one connection, so neither the visibility window nor the FOR UPDATE race is expressible
 * there.
 */
const PG_UP = await realPgAvailable();
const sqlA = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const holder = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-09-26T08:00:00.000Z");
const noop = (): void => { /* the outcomes are asserted, not the log */ };
const DOC = (tag: string) => ({
  v: 2, updatedAt: "2026-09-26T07:00:00.000Z", producer: { kind: "local", version: tag },
  screener: [], rules: [{ kind: "sender", match: `${tag}@sender.test`, destination: "INBOX", priority: 0, enabled: true, provenance: "promoted" }],
  notifyRules: [], tagNames: [], awayResponder: null, signature: null,
});

async function world(): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: `pmcr-${accountId.slice(0, 8)}` });
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `pmcr-${accountId.slice(0, 8)}@mirror.test`,
    organizerRole: "reader", organizerState: "held", organizedByKind: "local", organizedByName: "Host",
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

const read = (db: typeof dbA, w: { accountId: string; mailboxId: string }, tag: string, uid: number) =>
  applyProfileRead(
    { db: db as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: noop },
    { state: "found", doc: DOC(tag) as never, installId: "host", ref: uid, generation: 1757000000, residue: 0 },
  );

const rings = async (accountId: string): Promise<number> => (await dbA.select().from(changeLog).where(and(
  eq(changeLog.accountId, accountId), eq(changeLog.entityType, "mailbox_profile"),
))).length;

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => {
  await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); await holder.end({ timeout: 5 });
});

describe.skipIf(!PG_UP)("the mirror write rings its change row in the same transaction", () => {
  it("no surface can see the new document before its change row commits", async () => {
    const w = await world();
    // Create the account's counter row, then hold it: the write's seq allocation must wait.
    await dbA.transaction(async (tx) => {
      await recordChange(tx, { accountId: w.accountId, entityType: "settings", entityId: w.accountId, op: "update" });
    });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const held = holder.begin(async (tx) => {
      await tx`select 1 from account_sync_state where account_id = ${w.accountId} for update`;
      locked();
      await released;
    });
    await isLocked;

    const writing = read(dbA, w, "a", 11);
    await new Promise((r) => setTimeout(r, 400));
    const early = await dbB.select().from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    expect(early, "the mirror row was visible while its change row could not yet be written").toHaveLength(0);

    release();
    await held;
    expect(await writing).toMatchObject({ state: "written" });
    expect(await rings(w.accountId)).toBe(1);
  });

  it("a re-read of the same document rings nothing; a new document rings once", async () => {
    const w = await world();
    await read(dbA, w, "a", 11);
    await read(dbA, w, "a", 11);
    expect(await rings(w.accountId)).toBe(1);
    await read(dbA, w, "b", 12);
    expect(await rings(w.accountId)).toBe(2);
  });

  it("two passes writing ONE new document over an old one ring once — the comparison is under the lock", async () => {
    const w = await world();
    await read(dbA, w, "old", 3);
    expect(await rings(w.accountId)).toBe(1);

    // Hold the mirror row so both passes queue behind it; each then compares against what the
    // other committed, not against the old row both would have read without the lock.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const held = holder.begin(async (tx) => {
      await tx`select 1 from mailbox_profile_mirror where mailbox_id = ${w.mailboxId} for update`;
      locked();
      await released;
    });
    await isLocked;
    const both = Promise.all([read(dbA, w, "new", 4), read(dbB, w, "new", 4)]);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await held;
    await both;
    expect(await rings(w.accountId), "a pass compared against a row another pass had replaced").toBe(2);
  });
});
