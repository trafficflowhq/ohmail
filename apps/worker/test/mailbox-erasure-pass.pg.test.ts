import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, sql } from "drizzle-orm";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  PROFILE_FOUND_AUDIT_ACTION, accounts, accountStorage, auditLog, erasureRemaining, mailboxes, messageBodies, messages,
  reserveBodyBytes, stampMailboxErasure, storageUsageOf, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Logger } from "@trafficflow/core/mail";
import { MAILBOX_ERASURE_PASS_BUDGET_MS, mailboxErasurePass } from "../src/mailbox-erasure-pass.js";
import { STORAGE_RECOUNT_EVERY_MS, storageEvictPass } from "../src/storage-evict.js";

/**
 * THE ERASURE PASS — the sweep a "Remove and erase" press owes, driven the way the worker cycle
 * drives it. One mailbox at a time per account, oldest stamp first; the wall-clock bound ends a
 * pass between steps and the next pass resumes from the stamp alone. Real Postgres: every step
 * takes the account row FOR SHARE and the mailbox row FOR UPDATE. Scoped to its own accounts
 * through the pass's `shard` slot, since other files leave stamps on the same database.
 */

const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-23T10:00:00.000Z");
let client: ReturnType<typeof postgres>;
let db: Tx;

async function mailbox(accountId: string, label: string, n: number): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${label}-${randomUUID().slice(0, 6)}@example.test`,
  }).returning();
  for (let i = 0; i < n; i += 1) {
    const k = `${mb!.id}:${i}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: k, dedupKey: k, subject: `m${i}`, fromAddress: "a@example.test",
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "body" });
  }
  return mb!.id;
}

async function stamp(accountId: string, mailboxId: string, at: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await stampMailboxErasure(tx as unknown as Tx, { accountId, mailboxId, now: at });
  });
}

const owedIn = (ids: string[]) => inArray(mailboxes.accountId, ids);
const done = async (id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!.erasureDoneAt !== null;

describe.skipIf(!PG_UP)("mailboxErasurePass — the worker's half of the per-mailbox erase", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Tx;
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("one mailbox at a time per account, oldest stamp first, each finished and stamped", async () => {
    const x = randomUUID(); const y = randomUUID();
    await db.insert(accounts).values([{ id: x, name: "erase-x" }, { id: y, name: "erase-y" }]);
    const x1 = await mailbox(x, "x1", 3);
    const x2 = await mailbox(x, "x2", 3);
    const y1 = await mailbox(y, "y1", 2);
    const kept = await mailbox(x, "kept", 2);
    await stamp(x, x1, new Date(NOW.getTime() - 60_000));
    await stamp(x, x2, NOW);
    await stamp(y, y1, NOW);

    const first = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([x, y]) });
    expect(first.finished, "the pass did not finish one mailbox per account").toBe(2);
    expect(await done(x1)).toBe(true);
    expect(await done(y1)).toBe(true);
    expect(await done(x2), "a second mailbox of one account ran in the same pass").toBe(false);
    expect(await erasureRemaining(db, x, x2)).toBe(3);

    const second = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([x, y]) });
    expect(second.finished).toBe(1);
    expect(await done(x2)).toBe(true);
    expect(await erasureRemaining(db, x, x2)).toBe(0);
    // POSITIVE CONTROL: the account's mailbox nobody asked to erase keeps every message.
    expect(await erasureRemaining(db, x, kept)).toBe(2);
    expect(await done(kept)).toBe(false);
    const third = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([x, y]) });
    expect(third, "a pass with nothing owed did work").toMatchObject({ steps: 0, finished: 0 });
  });

  it("the wall-clock bound ends a pass between steps, and the next pass resumes from the stamp", async () => {
    const z = randomUUID();
    await db.insert(accounts).values({ id: z, name: "erase-z" });
    const z1 = await mailbox(z, "z1", 4);
    await stamp(z, z1, NOW);
    let reads = 0;
    // The pass's start, its check before the mailbox, the check before step one — then past it.
    const clock = () => (reads++ < 3 ? 0 : MAILBOX_ERASURE_PASS_BUDGET_MS);
    const cut = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([z]), clock });
    expect(cut.steps, "the bound did not stop the pass after one step").toBe(1);
    expect(await done(z1)).toBe(false);
    expect(await erasureRemaining(db, z, z1)).toBe(0);

    const resumed = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([z]) });
    expect(resumed.finished).toBe(1);
    expect(await done(z1)).toBe(true);
  });

  it("an erasure an older worker finished keeps no signature and no settings hash after the next pass, in its shard only", async () => {
    const w = randomUUID(); const o = randomUUID();
    await db.insert(accounts).values([{ id: w, name: "erase-w" }, { id: o, name: "erase-o" }]);
    const sig = { signature: "-- \nAnna", signatureHtml: "<p>Anna</p>" };
    // The old last step: the finish stamp alone, the signature and the marker's fingerprint left.
    const old = { status: "disabled" as const, erasedAt: NOW, erasureDoneAt: NOW, ...sig };
    const w1 = await mailbox(w, "w1", 0);
    const o1 = await mailbox(o, "o1", 0);
    await db.update(mailboxes).set(old).where(inArray(mailboxes.id, [w1, o1]));
    const FP = `2:${"b5".repeat(32)}`;
    const [wMarker, oMarker] = await db.insert(auditLog).values([[w, w1], [o, o1]].map(([accountId, mailboxId]) => ({
      accountId: accountId!, action: PROFILE_FOUND_AUDIT_ACTION, inverse: null,
      payload: { mailboxId, state: "found", fingerprint: FP, heldForImport: true },
    }))).returning({ id: auditLog.id });
    const read = async (id: string) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
    const payloadOf = async (id: string) => (await db.select({ p: auditLog.payload }).from(auditLog).where(eq(auditLog.id, id)))[0]!.p;

    const r = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([w]) });
    expect(r).toMatchObject({ steps: 0, signaturesCleared: 1, settingsHashesCleared: 1 });
    expect(await read(w1)).toMatchObject({ signature: null, signatureHtml: null });
    expect(await payloadOf(wMarker!.id)).toEqual({ mailboxId: w1, state: "found", heldForImport: true });
    expect(await read(o1), "another shard's row was touched").toMatchObject(sig);
    expect(await payloadOf(oMarker!.id), "another shard's marker was touched").toMatchObject({ fingerprint: FP });
    expect(await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([w]) }))
      .toMatchObject({ signaturesCleared: 0, settingsHashesCleared: 0 });
  });

  describe("and the storage counter", () => {
    const BODY = "y".repeat(1_000);
    /** A mailbox whose bodies are counted through the reserve, oldest first by `daysAgo`. */
    async function counted(accountId: string, label: string, n: number, daysAgo: number): Promise<string> {
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", address: `${label}-${randomUUID().slice(0, 6)}@example.test`,
      }).returning();
      for (let i = 0; i < n; i += 1) {
        const k = `${mb!.id}:${i}`;
        const [m] = await db.insert(messages).values({
          accountId, mailboxId: mb!.id, bodyHash: k, dedupKey: k, subject: `m${i}`, fromAddress: "a@example.test",
          date: new Date(NOW.getTime() - (daysAgo + i) * 86_400_000),
        }).returning();
        await db.transaction(async (tx) => {
          await reserveBodyBytes(tx as unknown as Tx, dialect(db), accountId, BODY.length, null);
          await (tx as unknown as Tx).insert(messageBodies).values({ messageId: m!.id, text: BODY });
        });
      }
      return mb!.id;
    }
    const account = async (): Promise<string> => {
      const id = randomUUID();
      await db.insert(accounts).values({ id, name: "erase-counter" });
      return id;
    };
    const emptied = async (accountId: string) => (await db.select({ id: messageBodies.id }).from(messageBodies)
      .innerJoin(messages, eq(messages.id, messageBodies.messageId))
      .where(sql`${messages.accountId} = ${accountId} and ${messageBodies.withheldReason} = 'storage_cap'`)).length;
    const real = async (accountId: string) => {
      const [r] = await db.select({
        s: sql<string>`coalesce(sum(octet_length(${messageBodies.text}) + coalesce(octet_length(${messageBodies.html}), 0)), 0)`,
      }).from(messageBodies).innerJoin(messages, eq(messages.id, messageBodies.messageId))
        .where(eq(messages.accountId, accountId));
      return Number(r!.s);
    };
    const trim = (accountId: string, cap: number) =>
      storageEvictPass(db, { accountId, storageCap: async () => cap }, NOW);

    it("after the pass, a trim at a cap the kept letters fit under empties none of them", async () => {
      const a = await account();
      await counted(a, "kept", 5, 100);
      const gone = await counted(a, "gone", 5, 1);
      await stamp(a, gone, NOW);
      expect((await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([a]) })).finished).toBe(1);
      expect(await storageUsageOf(db, a)).toBe(await real(a));
      const r = await trim(a, 6_000);
      expect(r.evicted, "the trim paid down bytes the erase had already deleted").toBe(0);
      expect(await emptied(a)).toBe(0);
    });

    it("a stamped erasure not yet swept holds the trim, so the person's kept letters keep their text", async () => {
      const a = await account();
      await counted(a, "kept", 5, 100);
      const gone = await counted(a, "gone", 5, 1);
      await stamp(a, gone, NOW);
      const r = await trim(a, 10_000);
      expect(r).toMatchObject({ ran: false, evicted: 0, waitsForErasure: true });
      expect(await emptied(a)).toBe(0);
      // Once the sweep is done the trim runs again, on the real bytes.
      await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([a]) });
      expect((await trim(a, 10_000)).waitsForErasure ?? false).toBe(false);
    });

    it("the finish recounts: bytes an older erase left on the counter are gone", async () => {
      const a = await account();
      await counted(a, "kept", 3, 100);
      const gone = await counted(a, "gone", 3, 1);
      await db.transaction(async (tx) => {
        await reserveBodyBytes(tx as unknown as Tx, dialect(db), a, 9_999, null);
      });
      await stamp(a, gone, NOW);
      await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([a]) });
      expect(await storageUsageOf(db, a)).toBe(3_000);
      expect(await storageUsageOf(db, a)).toBe(await real(a));
    });

    it("an erase an older worker finished left its bytes on the counter: the trim recounts and empties nothing", async () => {
      const a = await account();
      await counted(a, "kept", 5, 100);
      const gone = await counted(a, "gone", 5, 1);
      await stamp(a, gone, NOW);
      // The pre-release sweep: bodies and messages deleted, the stamp finished, the counter untouched.
      const ids = db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, gone));
      await db.delete(messageBodies).where(inArray(messageBodies.messageId, ids));
      await db.delete(messages).where(eq(messages.mailboxId, gone));
      await db.update(mailboxes).set({ erasureDoneAt: NOW }).where(eq(mailboxes.id, gone));
      expect(await storageUsageOf(db, a)).toBe(10_000);

      const r = await trim(a, 10_000);
      expect(r.evicted, "the trim paid down bytes an older erase had deleted").toBe(0);
      expect(await emptied(a)).toBe(0);
      expect(await storageUsageOf(db, a)).toBe(5_000);
      // POSITIVE CONTROL: real bytes over the mark are still trimmed after the recount.
      expect((await trim(a, 5_000)).evicted).toBe(1);
      expect(await emptied(a)).toBe(1);
    });

    describe("the daily recount", () => {
      const CAP = 10_000;
      /** The pass with a logger that keeps its lines, at `at`. */
      const pass = async (accountId: string, at: Date) => {
        const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
        const keep = (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); };
        const log: Logger = { level: "debug", child: () => log, debug: keep, info: keep, warn: keep, error: keep };
        const r = await storageEvictPass(db, { accountId, storageCap: async () => CAP, log }, at);
        return { ...r, drift: lines.filter((l) => l.event === "storage_counter_drift").map((l) => l.fields) };
      };
      const inflate = (accountId: string, bytes: number) => db.transaction(async (tx) => {
        await reserveBodyBytes(tx as unknown as Tx, dialect(db), accountId, bytes, null);
      });
      const checked = async (accountId: string) => (await db.select({
        at: accountStorage.recountedAt, drift: accountStorage.recountDrift,
      }).from(accountStorage).where(eq(accountStorage.accountId, accountId)))[0]!;

      it("at 90% of the cap a counter never checked is recounted: corrected, logged, and nothing emptied", async () => {
        const a = await account();
        await counted(a, "kept", 5, 100);
        await inflate(a, 4_200);
        const r = await pass(a, NOW);
        expect(r).toMatchObject({ ran: false, evicted: 0 });
        expect(r.drift).toEqual([{ accountId: a, drift: 4_200, bytes: 5_000 }]);
        expect(await storageUsageOf(db, a)).toBe(5_000);
        expect(await checked(a)).toEqual({ at: NOW, drift: 4_200 });
        expect(await emptied(a)).toBe(0);
      });

      it("a check younger than a day is not repeated; a day later it is", async () => {
        const a = await account();
        await counted(a, "kept", 5, 100);
        await inflate(a, 4_200);
        await pass(a, NOW);
        await inflate(a, 4_200);
        expect((await pass(a, new Date(NOW.getTime() + STORAGE_RECOUNT_EVERY_MS - 1))).drift).toEqual([]);
        expect(await storageUsageOf(db, a), "the counter was recounted inside the day").toBe(9_200);
        const later = new Date(NOW.getTime() + STORAGE_RECOUNT_EVERY_MS);
        expect((await pass(a, later)).drift).toEqual([{ accountId: a, drift: 4_200, bytes: 5_000 }]);
        expect(await checked(a)).toEqual({ at: later, drift: 4_200 });
      });

      it("below 90% nothing is recounted, drift or not", async () => {
        const a = await account();
        await counted(a, "kept", 5, 100);
        await inflate(a, 3_000);
        expect((await pass(a, NOW)).drift).toEqual([]);
        expect(await storageUsageOf(db, a)).toBe(8_000);
        expect(await checked(a)).toEqual({ at: null, drift: null });
      });

      it("bytes no letter holds, over the trim's mark, are recounted away before anything is emptied", async () => {
        const a = await account();
        await counted(a, "kept", 5, 100);
        await inflate(a, 4_600);
        const r = await pass(a, NOW);
        expect(r.evicted, "the trim paid down bytes no letter holds").toBe(0);
        expect(await emptied(a)).toBe(0);
        expect(r.drift).toEqual([{ accountId: a, drift: 4_600, bytes: 5_000 }]);
      });

      it("POSITIVE CONTROL: a true count over the mark is checked, matches, logs nothing, and trims", async () => {
        const a = await account();
        await counted(a, "kept", 10, 100);
        const r = await pass(a, NOW);
        expect(r.drift).toEqual([]);
        expect(await checked(a)).toEqual({ at: NOW, drift: 0 });
        expect(r.evicted).toBe(1);
        expect(await emptied(a)).toBe(1);
      });
    });
  });
});
