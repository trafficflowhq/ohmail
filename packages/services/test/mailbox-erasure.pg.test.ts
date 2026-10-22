import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { and, eq, sql } from "drizzle-orm";
import {
  ERASE_BATCH, eraseOwedMailbox,
  accounts, changeLog, contactNotes, drafts, flagState, folderState, mailboxCredentials,
  mailboxFolders, mailboxProfileMirror, mailboxes, messageBodies, messageInstances, messages,
  organizerRequests, threadNotes, threads,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ContactsService, MailboxService, ThreadService, type ServiceContext } from "../src/index.js";
import { NOW, rowsOf, seedFullAccount, type Db } from "./helpers/erasure-fixture.js";

/**
 * PER-MAILBOX ERASURE, ON REAL POSTGRES — because every property here is transactional or a
 * foreign key, and PGlite has been worth nothing for both.
 *
 * Two of these cases are here for defects a fixture with one mailbox cannot express:
 * `drafts.in_reply_to_message_id` references `messages` with no cascade, so a draft in a SIBLING
 * mailbox that replies into the erased one aborts the whole sweep on `23503`; and the sibling's
 * own mail must survive a sweep that selects by subquery. The race case runs two real connections
 * with distinct backends, because the fence is a row lock and a single connection cannot show it.
 *
 * Scoped to the accounts it seeds throughout: rows from other files are present on the shared
 * database and a global count would mean nothing.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: Db;
const svc = new MailboxService({ signatureChecks: false });
const threadSvc = new ThreadService();
const contactsSvc = new ContactsService();

const ctxFor = (accountId: string, userId: string, on: Db = db): ServiceContext => ({
  db: on as unknown as ServiceContext["db"],
  accountId,
  userId,
  now: () => NOW,
  requestId: "mailbox-erasure-pg",
});

/**
 * THE DOOR AS THE PRODUCT RUNS IT: the request stamps, then the worker pass's steps erase. The
 * receipt a case reads is the steps summed, with the anchors the stamp itself cleared added in.
 */
async function eraseViaDoor(ctx: ServiceContext, mailboxId: string, confirm: { confirmAddress: string | null }) {
  const res = await svc.delete(ctx, mailboxId, { erase: confirm });
  const run = await eraseOwedMailbox(db as never, dialect(db as never), {
    accountId: ctx.accountId, mailboxId, now: () => NOW, maxSteps: 50,
  });
  const erased = { ...run, draftsUnanchored: run.draftsUnanchored + (res.erasing?.draftsUnanchored ?? 0) };
  return { res, erased };
}

/** A second mailbox in the SAME account, with the mail an ordinary sync leaves behind. */
async function seedSibling(accountId: string, label: string): Promise<{
  mailboxId: string; messageId: string; draftId: string; threadId: string;
}> {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${label}@lichtgrat.example`,
  }).returning();
  const mailboxId = mb!.id;
  await db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: "enc:yyyy", keyVersion: 1,
  });
  await db.insert(mailboxFolders).values({ mailboxId, folder: "INBOX" });
  const [thread] = await db.insert(threads).values({ accountId }).returning();
  const dedup = `mid:${label}:${Math.random().toString(36).slice(2)}`;
  const [msg] = await db.insert(messages).values({
    accountId, mailboxId, threadId: thread!.id, messageIdHeader: dedup,
    bodyHash: dedup, dedupKey: dedup, subject: `${label} subject`,
    fromAddress: "giulia@example.test", date: NOW,
    nativeLocator: { folder: "INBOX", ref: "2:2" }, snippet: "hello",
  }).returning();
  await db.insert(messageBodies).values({ messageId: msg!.id, text: `${label} body` });
  await db.insert(folderState).values({
    messageId: msg!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    reconcileStatus: "reconciled", conflict: false,
  });
  await db.insert(messageInstances).values({
    accountId, mailboxId, messageId: msg!.id, folder: "INBOX", uidvalidity: 7n, uid: 2,
    isPrimary: true,
  });
  const [draft] = await db.insert(drafts).values({
    accountId, mailboxId, subject: `${label} draft`, body: "unsent",
  }).returning();
  await db.insert(mailboxProfileMirror).values({
    accountId, mailboxId, uidvalidity: 7n, uid: 3,
    doc: { v: 1, tagNames: ["invoices"] }, readAt: NOW,
  });
  await db.insert(organizerRequests).values({
    accountId, mailboxId, kind: "screener.decide",
    payload: { sender: "giulia@example.test", verdict: "screened_in" },
    decidedAt: NOW, state: "pending",
  });
  return { mailboxId, messageId: msg!.id, draftId: draft!.id, threadId: thread!.id };
}

const countWhere = async (table: string, col: string, id: string): Promise<number> => {
  const rows = await db.execute(
    sql`select count(*)::int as c from ${sql.identifier(table)} where ${sql.identifier(col)} = ${id}`,
  );
  return rowsOf<{ c: number }>(rows)[0]!.c;
};

describe.skipIf(!PG_UP)("per-mailbox erasure — real Postgres, real foreign keys", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Db;
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("erases one mailbox's mail and leaves the sibling's mail whole", async () => {
    const seeded = await seedFullAccount(db, "Two mailboxes");
    const keep = await seedSibling(seeded.accountId, `keep-${Date.now().toString(36)}`);
    const ctx = ctxFor(seeded.accountId, seeded.userId);
    const target = await db.select().from(mailboxes)
      .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);

    const { res, erased } = await eraseViaDoor(ctx, seeded.mailboxId, { confirmAddress: target[0]!.address });

    expect(res.erasing, "the erase arm did not run").toBeDefined();
    expect(erased.messagesErased).toBe(1);
    expect(erased.deleted.messages).toBe(1);
    expect(erased.deleted.message_bodies).toBe(1);
    expect(erased.deleted.flag_state).toBe(1);
    expect(erased.deleted.mailbox_profile_mirror).toBe(1);
    expect(erased.deleted.organizer_requests).toBe(1);

    // The erased mailbox holds nothing.
    expect(await countWhere("messages", "mailbox_id", seeded.mailboxId)).toBe(0);
    expect(await countWhere("message_instances", "mailbox_id", seeded.mailboxId)).toBe(0);
    expect(await countWhere("mailbox_folders", "mailbox_id", seeded.mailboxId)).toBe(0);
    expect(await countWhere("mailbox_profile_mirror", "mailbox_id", seeded.mailboxId)).toBe(0);
    expect(await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, seeded.messageId))).toHaveLength(0);
    expect(await db.select().from(flagState)
      .where(eq(flagState.messageId, seeded.messageId))).toHaveLength(0);

    // THE SIBLING IS UNTOUCHED — the property a one-mailbox fixture cannot state.
    expect(await countWhere("messages", "mailbox_id", keep.mailboxId)).toBe(1);
    expect(await countWhere("message_instances", "mailbox_id", keep.mailboxId)).toBe(1);
    expect(await countWhere("mailbox_folders", "mailbox_id", keep.mailboxId)).toBe(1);
    expect(await countWhere("mailbox_profile_mirror", "mailbox_id", keep.mailboxId)).toBe(1);
    expect(await countWhere("organizer_requests", "mailbox_id", keep.mailboxId)).toBe(1);
    expect(await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, keep.messageId))).toHaveLength(1);
    expect(await db.select().from(drafts).where(eq(drafts.id, keep.draftId))).toHaveLength(1);

    // The ACCOUNT survives, and so does the mailbox row as the tombstone a removal has always
    // left — what went is the mail, not the person and not the list entry.
    expect(await db.select().from(accounts).where(eq(accounts.id, seeded.accountId)))
      .toHaveLength(1);
    const tomb = await db.select().from(mailboxes).where(eq(mailboxes.id, seeded.mailboxId));
    expect(tomb).toHaveLength(1);
    expect(tomb[0]!.status).toBe("disabled");
  });

  it("receipts every erased message and draft in change_log as a delete", async () => {
    const seeded = await seedFullAccount(db, "Receipted");
    const ctx = ctxFor(seeded.accountId, seeded.userId);
    const target = await db.select().from(mailboxes)
      .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);

    const { res, erased } = await eraseViaDoor(ctx, seeded.mailboxId, { confirmAddress: target[0]!.address });

    // The message's own receipt, by entity id — a mirror tombstones from this and nothing else.
    const msgRows = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, seeded.accountId),
      eq(changeLog.entityId, seeded.messageId),
      eq(changeLog.op, "delete"),
    ));
    expect(msgRows, "no delete receipt for the erased message").toHaveLength(1);
    expect(msgRows[0]!.entityType).toBe("message");
    // And the answer's seq is at least the highest receipt, so a client can wait for it.
    expect(erased.seq).not.toBeNull();
    expect(erased.seq!).toBeGreaterThanOrEqual(msgRows[0]!.seq);
    expect(erased.draftsErased).toBe(1);
  });

  it("clears a SIBLING mailbox's reply anchor instead of failing on the foreign key", async () => {
    // Without the unanchoring update this case is not a wrong count — it is `23503` and a mailbox
    // that cannot be erased at all, for any account where one mailbox replies to another's mail.
    const seeded = await seedFullAccount(db, "Cross reply");
    const keep = await seedSibling(seeded.accountId, `x-${Date.now().toString(36)}`);
    const [reply] = await db.insert(drafts).values({
      accountId: seeded.accountId, mailboxId: keep.mailboxId,
      inReplyToMessageId: seeded.messageId, subject: "Re: Glaze order", body: "on its way",
    }).returning();
    const ctx = ctxFor(seeded.accountId, seeded.userId);
    const target = await db.select().from(mailboxes)
      .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);

    const { res, erased } = await eraseViaDoor(ctx, seeded.mailboxId, { confirmAddress: target[0]!.address });

    expect(erased.draftsUnanchored).toBe(1);
    const after = await db.select().from(drafts).where(eq(drafts.id, reply!.id));
    expect(after, "the sibling's unsent draft was deleted, not unanchored").toHaveLength(1);
    expect(after[0]!.inReplyToMessageId).toBeNull();
    expect(after[0]!.subject).toBe("Re: Glaze order");
  });

  it("clears a SIBLING mailbox's forward of a message here, and keeps the note", async () => {
    // The reply case's twin: a forward drafted in one mailbox of a message in the other. Without its
    // own unanchoring update the erase is `23503` on the forward key, and the mailbox cannot go.
    const seeded = await seedFullAccount(db, "Cross forward");
    const keep = await seedSibling(seeded.accountId, `f-${Date.now().toString(36)}`);
    const [forward] = await db.insert(drafts).values({
      accountId: seeded.accountId, mailboxId: keep.mailboxId,
      forwardOfMessageId: seeded.messageId, subject: "Fwd: Glaze order", body: "see below",
    }).returning();
    const ctx = ctxFor(seeded.accountId, seeded.userId);
    const target = await db.select().from(mailboxes)
      .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);

    const { erased } = await eraseViaDoor(ctx, seeded.mailboxId, { confirmAddress: target[0]!.address });

    expect(erased.draftsUnanchored).toBe(1);
    const after = await db.select().from(drafts).where(eq(drafts.id, forward!.id));
    expect(after, "the sibling's unsent forward was deleted, not unanchored").toHaveLength(1);
    expect(after[0]!.forwardOfMessageId).toBeNull();
    expect(after[0]!.body).toBe("see below");
  });

  it("refuses without the address, with the wrong address, and erases nothing either time",
    async () => {
      const seeded = await seedFullAccount(db, "Unconfirmed");
      const ctx = ctxFor(seeded.accountId, seeded.userId);

      await expect(svc.delete(ctx, seeded.mailboxId, { erase: { confirmAddress: null } }))
        .rejects.toThrow(/confirm the erasure/);
      await expect(svc.delete(ctx, seeded.mailboxId, {
        erase: { confirmAddress: "someone-else@lichtgrat.example" },
      })).rejects.toThrow(/confirm the erasure/);

      // Nothing moved — not the mail, and not the tombstone the same transaction would have
      // written: the refusal rolls the whole removal back.
      expect(await countWhere("messages", "mailbox_id", seeded.mailboxId)).toBe(1);
      const still = await db.select().from(mailboxes).where(eq(mailboxes.id, seeded.mailboxId));
      expect(still[0]!.status).not.toBe("disabled");
    });

  it("writes ONE mailbox receipt, and the repeat writes none", async () => {
    /*
     * THE POSITIVE CONTROL for the condition the case below refuses. A sweep that took something
     * emits one `mailbox` delete — the row a client cascades from, so its folder rows, cached
     * bodies and received count go with the mail (`client-engine/src/store.ts`,
     * `cascadeMailboxRemoval`). Without a case saying the receipt IS written, a gate that never
     * fired would pass the idempotency case below and leave the defect this closes wide open.
     *
     * MUTATION-WATCH: make the emission unconditional and the case below goes red (a no-op erase
     * allocates a sequence); drop the emission and THIS one goes red at 0 receipts.
     */
    const seeded = await seedFullAccount(db, "Receipt");
    const ctx = ctxFor(seeded.accountId, seeded.userId);
    const target = await db.select().from(mailboxes)
      .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);
    const confirm = { confirmAddress: target[0]!.address };

    const receipts = async (): Promise<number> => (await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, seeded.accountId),
      eq(changeLog.entityType, "mailbox"),
      eq(changeLog.entityId, seeded.mailboxId),
      eq(changeLog.op, "delete"),
    ))).length;

    expect(await receipts(), "a mailbox nobody erased already has a receipt").toBe(0);
    const first = await eraseViaDoor(ctx, seeded.mailboxId, confirm);
    expect(await receipts(), "the erasure told no mirror the mailbox is gone").toBe(1);
    /* AND IT IS THE SWEEP'S HIGHEST SEQ — a mirror that waited for the answer's seq has seen
       every per-message receipt below it. */
    const rows = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, seeded.accountId), eq(changeLog.entityType, "mailbox")));
    expect(first.erased.seq).toBe(rows[0]!.seq);

    await eraseViaDoor(ctx, seeded.mailboxId, confirm);
    expect(await receipts(), "the repeat re-issued a receipt for a mailbox already erased").toBe(1);
  });

  it("is idempotent: a second erase reports zero and the first receipt is not re-issued",
    async () => {
      const seeded = await seedFullAccount(db, "Twice");
      const ctx = ctxFor(seeded.accountId, seeded.userId);
      const target = await db.select().from(mailboxes)
        .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);
      const confirm = { confirmAddress: target[0]!.address };

      const first = await eraseViaDoor(ctx, seeded.mailboxId, confirm);
      expect(first.erased.messagesErased).toBe(1);

      const second = await eraseViaDoor(ctx, seeded.mailboxId, confirm);
      expect(second.res.erasing, "the repeat stamped an erasure already finished").toMatchObject({ done: true });
      expect(second.erased.messagesErased).toBe(0);
      expect(second.erased.seq, "a no-op erase allocated a sequence").toBeNull();
      expect(Object.values(second.erased.deleted).reduce((a, b) => a + b, 0)).toBe(0);
    });

  it("refuses the removal outright once the account is erased — two live backends", async () => {
    // The fence, driven the only way it can be: `MailboxService.delete` writes `mailboxes`, a
    // table the account sweep empties and which has no foreign key to anything erasure deletes,
    // so without the fence this tombstone commits after the sweep counted zero.
    const seeded = await seedFullAccount(db, "Fenced");
    const other = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    try {
      const otherDb = brandDialect(drizzle(other, { schema }), "pg") as unknown as Db;
      const pids = await Promise.all([db, otherDb].map(async (d) => {
        const r = await d.execute(sql`select pg_backend_pid() as pid`);
        return rowsOf<{ pid: number }>(r)[0]!.pid;
      }));
      expect(pids[0], "both reads came from one backend — the race is not being driven")
        .not.toBe(pids[1]);

      await db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, seeded.accountId));

      await expect(
        svc.delete(ctxFor(seeded.accountId, seeded.userId, otherDb), seeded.mailboxId, {}),
      ).rejects.toThrow(/deleted/);
      // And the mailbox row is exactly as it was: no tombstone, no cleared lease columns.
      const row = await db.select().from(mailboxes).where(eq(mailboxes.id, seeded.mailboxId));
      expect(row[0]!.status).not.toBe("disabled");
    } finally {
      await other.end({ timeout: 5 });
    }
  });

  /**
   * The thread carries the SUBJECT and the PARTICIPANTS and the note carries what the person
   * wrote about the conversation, and both were served after the mailbox that held them was
   * erased. Driven through the two READ doors rather than the tables: the claim the product makes
   * is "nothing for this mailbox", and a row count is not what a person is shown.
   */
  it("erases the thread and the note this mailbox alone held, and both doors then have nothing",
    async () => {
      const seeded = await seedFullAccount(db, "Exclusive thread");
      const ctx = ctxFor(seeded.accountId, seeded.userId);

      // BEFORE: the doors answer, which is what makes the after-reading a measurement.
      const before = await threadSvc.get(ctx, seeded.threadId);
      expect(before.id).toBe(seeded.threadId);
      expect((await contactsSvc.listThreadNotes(ctx, seeded.threadId)).items).toHaveLength(1);

      const target = await db.select().from(mailboxes)
        .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);
      const { res, erased } = await eraseViaDoor(ctx, seeded.mailboxId, { confirmAddress: target[0]!.address });

      expect(erased.deleted.threads).toBe(1);
      expect(erased.deleted.thread_notes).toBe(1);
      await expect(threadSvc.get(ctx, seeded.threadId)).rejects.toThrow(/not found/);
      expect(await db.select().from(threads).where(eq(threads.id, seeded.threadId)))
        .toHaveLength(0);
      expect(await db.select().from(threadNotes)
        .where(eq(threadNotes.threadId, seeded.threadId))).toHaveLength(0);

      // THE NAMED SURVIVOR. A note on a contact card belongs to the account's address book, and
      // the address book outlives one mailbox exactly as `contacts` does.
      expect(await db.select().from(contactNotes)
        .where(eq(contactNotes.accountId, seeded.accountId))).toHaveLength(1);
    });

  /**
   * THE POSITIVE CONTROL, and the hard stop: a thread the sibling mailbox also holds is another
   * person's correspondence as far as this erasure is concerned. It keeps its row, its subject
   * and its note, and loses only the erased mailbox's message.
   */
  it("keeps a thread SHARED with a surviving mailbox, and only its erased half goes", async () => {
    const seeded = await seedFullAccount(db, "Shared thread");
    const label = `share-${Date.now().toString(36)}`;
    const [mb] = await db.insert(mailboxes).values({
      accountId: seeded.accountId, provider: "imap", address: `${label}@lichtgrat.example`,
    }).returning();
    const dedup = `mid:${label}:${Math.random().toString(36).slice(2)}`;
    // The sibling's message on the SAME thread — this is what makes the thread shared.
    const [sib] = await db.insert(messages).values({
      accountId: seeded.accountId, mailboxId: mb!.id, threadId: seeded.threadId,
      messageIdHeader: dedup, bodyHash: dedup, dedupKey: dedup, subject: "shared subject",
      fromAddress: "giulia@example.test", date: NOW,
    }).returning();
    const ctx = ctxFor(seeded.accountId, seeded.userId);

    const target = await db.select().from(mailboxes)
      .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);
    const { res, erased } = await eraseViaDoor(ctx, seeded.mailboxId, { confirmAddress: target[0]!.address });

    expect(erased.deleted.threads).toBe(0);
    expect(erased.deleted.thread_notes).toBe(0);
    const kept = await threadSvc.get(ctx, seeded.threadId);
    expect(kept.id).toBe(seeded.threadId);
    expect((await contactsSvc.listThreadNotes(ctx, seeded.threadId)).items).toHaveLength(1);
    // The sibling's message is still on it; the erased mailbox's is not.
    expect(await db.select().from(messages).where(eq(messages.id, sib!.id))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, seeded.messageId)))
      .toHaveLength(0);
  });

  /**
   * The sibling's UNSENT DRAFT anchored to an exclusive thread. `drafts.thread_id` is the second
   * foreign key into `threads` that outlives this erasure, and without the clearing the sweep is
   * not a wrong count but a `23503` that takes the whole removal with it.
   */
  it("clears a SIBLING draft's thread anchor instead of failing on the foreign key", async () => {
    const seeded = await seedFullAccount(db, "Cross thread anchor");
    const keep = await seedSibling(seeded.accountId, `ta-${Date.now().toString(36)}`);
    const [reply] = await db.insert(drafts).values({
      accountId: seeded.accountId, mailboxId: keep.mailboxId,
      threadId: seeded.threadId, subject: "Re: Glaze order", body: "on its way",
    }).returning();
    const ctx = ctxFor(seeded.accountId, seeded.userId);

    const target = await db.select().from(mailboxes)
      .where(eq(mailboxes.id, seeded.mailboxId)).limit(1);
    const { res, erased } = await eraseViaDoor(ctx, seeded.mailboxId, { confirmAddress: target[0]!.address });

    expect(erased.deleted.threads).toBe(1);
    const after = await db.select().from(drafts).where(eq(drafts.id, reply!.id));
    expect(after, "the sibling's unsent draft was deleted, not unanchored").toHaveLength(1);
    expect(after[0]!.threadId).toBeNull();
    expect(after[0]!.subject).toBe("Re: Glaze order");
  });
  /**
   * A MAILBOX LARGER THAN ONE STEP, erased in bounded steps and resumed from the stamp alone.
   * `2 × ERASE_BATCH + 5` messages over three-message threads, so threads straddle a step; a
   * sibling shares one. Two separate runs stand in for a worker restart: nothing but the tombstone
   * carries the erasure across them. The list counts down and leaves when the finish is stamped.
   */
  it("erases a large mailbox in bounded steps, resumable from the stamp alone", async () => {
    const seeded = await seedFullAccount(db, "Large");
    const keep = await seedSibling(seeded.accountId, `big-${Date.now().toString(36)}`);
    const ctx = ctxFor(seeded.accountId, seeded.userId);
    const total = 2 * ERASE_BATCH + 5;
    const threadIds = (await db.insert(threads).values(
      Array.from({ length: Math.ceil(total / 3) }, () => ({ accountId: seeded.accountId })),
    ).returning()).map((t) => t.id);
    for (let i = 0; i < total; i += 1000) {
      const chunk = Array.from({ length: Math.min(1000, total - i) }, (_, j) => {
        const k = i + j; const d = `big:${seeded.mailboxId}:${k}`;
        return {
          accountId: seeded.accountId, mailboxId: seeded.mailboxId, threadId: threadIds[Math.floor(k / 3)]!,
          messageIdHeader: d, bodyHash: d, dedupKey: d, subject: `m${k}`, fromAddress: "a@example.test",
        };
      });
      const made = await db.insert(messages).values(chunk).returning({ id: messages.id });
      await db.insert(messageBodies).values(made.map((m) => ({ messageId: m.id, text: "body" })));
    }
    // The sibling's message on one of the erased mailbox's threads: that thread must survive.
    const shared = threadIds[5]!;
    await db.update(messages).set({ threadId: shared }).where(eq(messages.id, keep.messageId));
    const before = await countWhere("messages", "mailbox_id", seeded.mailboxId);
    const target = await db.select().from(mailboxes).where(eq(mailboxes.id, seeded.mailboxId)).limit(1);

    const res = await svc.delete(ctx, seeded.mailboxId, { erase: { confirmAddress: target[0]!.address } });
    expect(res.erasing).toMatchObject({ messages: before, done: false });
    const listed = async () => (await svc.list(ctx)).find((m) => m.id === seeded.mailboxId);
    expect((await listed())?.erasure).toEqual({ remaining: before });

    const step = (n: number) => eraseOwedMailbox(db as never, dialect(db as never), {
      accountId: seeded.accountId, mailboxId: seeded.mailboxId, now: () => NOW, maxSteps: n,
    });
    // Drafts go first, a step of their own; the first MESSAGE step is the bound under test.
    let first = await step(1);
    for (let i = 0; i < 3 && first.messagesErased === 0; i += 1) first = await step(1);
    expect(first.messagesErased, "one step named more than ERASE_BATCH messages").toBe(ERASE_BATCH);
    expect((await listed())?.erasure).toEqual({ remaining: before - ERASE_BATCH });
    // THE RESTART: a fresh run, given nothing but the ids, resumes where the first stopped.
    const rest = await step(50);
    expect(rest.done).toBe(true);
    expect(first.messagesErased + rest.messagesErased).toBe(before);
    expect(await listed(), "a finished erasure is still listed").toBeUndefined();
    expect(await countWhere("messages", "mailbox_id", seeded.mailboxId)).toBe(0);
    expect((await db.select().from(threads).where(eq(threads.id, threadIds[0]!))).length,
      "an exclusive thread survived").toBe(0);
    expect((await db.select().from(threads).where(eq(threads.id, shared))).length,
      "the thread the sibling shares was erased").toBe(1);
    expect(await countWhere("messages", "mailbox_id", keep.mailboxId)).toBe(1);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, seeded.mailboxId));
    expect(row!.erasureDoneAt).not.toBeNull();
  }, 120_000);
});

