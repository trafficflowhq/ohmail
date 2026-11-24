import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { allocateSeq, recordChange, minRetainedSeq } from "../src/change-log.js";
import {
  accountSyncState, changeLog, mailboxes, messages, threads, messageBodies,
  routingDecisions, approvals, messageStates,
} from "../src/schema.js";

const ACCT = "00000000-0000-0000-0000-0000000000aa";

async function seedMailbox(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCT, provider: "imap", address: "a@x.example" }).returning();
  const [msg] = await db.insert(messages).values({
    accountId: ACCT, mailboxId: mb.id, bodyHash: "h", dedupKey: "k1", subject: "s", fromAddress: "f@x.example",
  }).returning();
  return { mailboxId: mb.id, messageId: msg.id };
}

describe("allocateSeq / recordChange (PGlite)", () => {
  it("allocates a strictly monotonic, gap-free per-account seq across statements and transactions", async () => {
    const db = await makeTestDb();

    const first = await db.transaction(async (tx) => {
      const a = await allocateSeq(tx, ACCT);
      const b = await allocateSeq(tx, ACCT);
      const c = await allocateSeq(tx, ACCT);
      return [a, b, c];
    });
    expect(first).toEqual([1n, 2n, 3n]);

    // A fresh transaction continues from the committed counter — no gap, no reset.
    const next = await db.transaction((tx) => allocateSeq(tx, ACCT));
    expect(next).toBe(4n);

    const state = await db.select().from(accountSyncState).where(eq(accountSyncState.accountId, ACCT));
    expect(state[0]!.nextSeq).toBe(4n);
  });

  it("scopes the counter per account", async () => {
    const db = await makeTestDb();
    const other = "00000000-0000-0000-0000-0000000000bb";
    const a1 = await db.transaction((tx) => allocateSeq(tx, ACCT));
    const b1 = await db.transaction((tx) => allocateSeq(tx, other));
    const a2 = await db.transaction((tx) => allocateSeq(tx, ACCT));
    expect([a1, a2]).toEqual([1n, 2n]);
    expect(b1).toBe(1n); // independent counter
  });

  it("recordChange writes a change_log row in-tx and returns the seq", async () => {
    const db = await makeTestDb();
    const { messageId } = await seedMailbox(db);

    const seq = await db.transaction((tx) =>
      recordChange(tx, { accountId: ACCT, entityType: "message", entityId: messageId, op: "create" }),
    );
    expect(seq).toBe(1n);

    const rows = await db.select().from(changeLog).where(eq(changeLog.accountId, ACCT));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1n, entityType: "message", entityId: messageId, op: "create" });
  });

  it("rolls back the change_log row AND its entity together when the tx aborts", async () => {
    const db = await makeTestDb();
    const { mailboxId } = await seedMailbox(db);

    await expect(
      db.transaction(async (tx) => {
        const [m] = await tx.insert(messages).values({
          accountId: ACCT, mailboxId, bodyHash: "h2", dedupKey: "k2", subject: "boom", fromAddress: "f@x.example",
        }).returning();
        await recordChange(tx, { accountId: ACCT, entityType: "message", entityId: m.id, op: "create" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    // Neither the entity nor its change_log row survived; the seq counter is unwound too.
    const boom = await db.select().from(messages).where(eq(messages.dedupKey, "k2"));
    expect(boom).toHaveLength(0);
    const cl = await db.select().from(changeLog).where(eq(changeLog.accountId, ACCT));
    expect(cl).toHaveLength(0);
    expect(await minRetainedSeq(db, ACCT)).toBeNull();
  });

  it("carries move metadata {from,to} on move rows", async () => {
    const db = await makeTestDb();
    const { messageId } = await seedMailbox(db);
    await db.transaction((tx) =>
      recordChange(tx, {
        accountId: ACCT, entityType: "message", entityId: messageId, op: "move",
        meta: { from: "ohmail/Screener", to: "INBOX" },
      }),
    );
    const [row] = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.op, "move")));
    expect(row!.meta).toEqual({ from: "ohmail/Screener", to: "INBOX" });
  });
});

describe("migration 0002 round-trip — every new table persists (PGlite)", () => {
  it("persists account_sync_state, change_log, threads, message_bodies, routing_decisions, approvals, message_states", async () => {
    const db = await makeTestDb();
    const { messageId } = await seedMailbox(db);

    const [th] = await db.insert(threads).values({ accountId: ACCT, subject: "T" }).returning();
    const [body] = await db.insert(messageBodies).values({ messageId, accountId: ACCT, text: "hello", headers: {} }).returning();
    const [rd] = await db.insert(routingDecisions).values({
      accountId: ACCT, messageId, inputProvenance: "ai", destination: "INBOX", confidence: 0.9, status: "pending_approval",
    }).returning();
    const [ap] = await db.insert(approvals).values({
      accountId: ACCT, kind: "routing", messageId, routingDecisionId: rd.id, action: "move",
      summary: "route to Imbox", payload: { folder: "INBOX" }, confidence: 0.9,
    }).returning();
    const [ms] = await db.insert(messageStates).values({
      accountId: ACCT, messageId, state: "reply_later",
    }).returning();

    expect(th.subject).toBe("T");
    expect(body.text).toBe("hello");
    expect(rd.confidence).toBeCloseTo(0.9);
    expect(ap.status).toBe("pending"); // default
    expect(ms.state).toBe("reply_later");
  });
});
