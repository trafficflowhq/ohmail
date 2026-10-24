import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import {
  accounts, drafts, eraseOwedMailbox, evictOldestBodies, mailboxCredentials, mailboxFolders, mailboxes,
  messageBodies, messages, reserveBodyBytes, storageUsageOf, threads, type Tx,
} from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * ERASING ONE MAILBOX HAS TO RUN ON THE STORE A STANDALONE PHONE CARRIES.
 *
 * `MailboxService.delete`'s erase arm takes the account's thread-structure lock before the
 * mailbox row. Spelled as a raw `select pg_advisory_xact_lock(…)` it was not a statement the
 * device store refuses but a METHOD its handle does not have — `execute` is a pg-core method and
 * a SQLite handle carries `run`/`all`/`get` — so the removal threw inside the transaction and
 * rolled the whole thing back: the mailbox stayed, its mail stayed, and the person pressing
 * "remove and erase" got an internal error. The sweep's transactional and foreign-key properties
 * belong to `mailbox-erasure.pg.test.ts` on real Postgres; what this file holds is that the
 * removal COMPLETES, and that its refusal is the product's refusal, on either store.
 *
 * The plain removal is the third case and it is the positive control: the lock is taken only
 * under `opts.erase`, so a red confined to the two erase cases is a red about the erase arm.
 */

const NOW = new Date("2026-09-11T10:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 3), 1);
const svc = makeMailboxService({ keyProvider: KP });

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "erase-dialect" });

/** One mailbox with the mail an ordinary sync leaves behind: a folder, a message, a body, a draft. */
async function seed(db: Db): Promise<{
  accountId: string; mailboxId: string; address: string; messageId: string; draftId: string;
}> {
  const [a] = await db.insert(accounts).values({ name: "erase-dialect" }).returning();
  const accountId = a!.id;
  const address = `e-${accountId.slice(0, 8)}@example.test`;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address,
  }).returning();
  const mailboxId = mb!.id;
  await db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: "enc:xxxx", keyVersion: 1,
  });
  await db.insert(mailboxFolders).values({ mailboxId, folder: "INBOX" });
  const [thread] = await db.insert(threads).values({ accountId }).returning();
  const key = `mid:${accountId.slice(0, 8)}`;
  const [msg] = await db.insert(messages).values({
    accountId, mailboxId, threadId: thread!.id, messageIdHeader: key,
    bodyHash: key, dedupKey: key, subject: "one message", fromAddress: "giulia@example.test",
  }).returning();
  await db.insert(messageBodies).values({ messageId: msg!.id, text: "the body" });
  const [draft] = await db.insert(drafts).values({
    accountId, mailboxId, subject: "unsent", body: "unsent",
  }).returning();
  return { accountId, mailboxId, address, messageId: msg!.id, draftId: draft!.id };
}

describe("removing one mailbox WITH erase, on either store", () => {
  it("completes: the receipt counts the mail, the tombstone stands and the mail is gone", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, address, messageId, draftId } = await seed(db);

    const res = await svc.delete(ctxFor(db, accountId), mailboxId, {
      erase: { confirmAddress: address },
    });

    // The request STAMPS and promises; the steps the worker's pass runs do the sweep.
    expect(res.erasing, "the erase arm did not run").toBeDefined();
    expect(res.erasing).toMatchObject({ messages: 1, drafts: 1, done: false });
    expect(await db.select().from(messages).where(eq(messages.id, messageId))).toHaveLength(1);
    const run = await eraseOwedMailbox(db, dialect(db), {
      accountId, mailboxId, now: () => NOW, maxSteps: 10,
    });
    expect(run.done, "the steps did not finish the erasure on this store").toBe(true);
    expect(run.messagesErased).toBe(1);
    expect(run.draftsErased).toBe(1);

    // The mailbox row SURVIVES as the tombstone an ordinary removal has always left — the mail
    // is what goes. `messages.mailbox_id` references it, so a hard delete was never the shape.
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.status).toBe("disabled");
    expect(row!.erasedAt, "the stamp is the fence and the resume point").not.toBeNull();
    expect(row!.erasureDoneAt, "the finish is stamped with the last step").not.toBeNull();
    expect(await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.id, messageId))).toHaveLength(0);
    expect(await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, messageId))).toHaveLength(0);
    expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toHaveLength(0);
    expect(await db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, mailboxId))).toHaveLength(0);
  });

  it("refuses an unconfirmed erase with the PRODUCT's 400 and writes nothing", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, messageId } = await seed(db);

    // The confirmation is read after the lock, so a store that could not take the lock answered
    // this press with an internal error instead of the sentence that tells the person what to do.
    await expect(svc.delete(ctxFor(db, accountId), mailboxId, { erase: { confirmAddress: "" } }))
      .rejects.toMatchObject({ code: "erase_not_confirmed", httpStatus: 400 });

    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.status).toBe("connected");
    expect(await db.select().from(messages).where(eq(messages.id, messageId))).toHaveLength(1);
  });

  it("POSITIVE CONTROL: the plain removal takes no such lock, so it passes on either store", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, messageId } = await seed(db);

    const res = await svc.delete(ctxFor(db, accountId), mailboxId);

    expect(res.erasing).toBeUndefined();
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.status).toBe("disabled");
    // A disconnect is reversible: the mail stays and only the credentials go.
    expect(await db.select().from(messages).where(eq(messages.id, messageId))).toHaveLength(1);
    expect(await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId))).toHaveLength(0);
  });
});

/**
 * The erase gives back what it deletes: `account_storage` is what the trim pays down, so bytes left
 * on the counter after an erase empty the text of letters the person kept.
 */
describe("the storage counter across an erase, on either store", () => {
  const BODY = "x".repeat(1_000);

  async function world(db: Db) {
    const d = dialect(db);
    const [a] = await db.insert(accounts).values({ name: "erase-counter" }).returning();
    const accountId = a!.id;
    const fill = async (mailboxId: string, n: number, daysAgo: number, key: string) => {
      for (let i = 0; i < n; i++) {
        const k = `${key}:${i}`;
        const [m] = await db.insert(messages).values({
          accountId, mailboxId, bodyHash: k, dedupKey: k, subject: k, fromAddress: "a@example.test",
          date: new Date(NOW.getTime() - (daysAgo + i) * 86_400_000),
        }).returning();
        await db.transaction(async (tx) => {
          await reserveBodyBytes(tx as unknown as Tx, d, accountId, BODY.length, null);
          await tx.insert(messageBodies).values({ messageId: m!.id, text: BODY });
        });
      }
    };
    const mailbox = async (label: string, n: number, daysAgo: number, key = label) => {
      const address = `${label}-${accountId.slice(0, 8)}@example.test`;
      const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address }).returning();
      await fill(mb!.id, n, daysAgo, key);
      return { id: mb!.id, address };
    };
    const erase = async (mb: { id: string; address: string }) => {
      await svc.delete(ctxFor(db, accountId), mb.id, { erase: { confirmAddress: mb.address } });
      // The page step itself gives the bytes back, before the finish recounts.
      const page = await eraseOwedMailbox(db, d, { accountId, mailboxId: mb.id, now: () => NOW, maxSteps: 1 });
      expect(page.done).toBe(false);
      expect(await counted(), "the page step kept the bytes of the bodies it deleted").toBe(await real());
      const run = await eraseOwedMailbox(db, d, { accountId, mailboxId: mb.id, now: () => NOW, maxSteps: 10 });
      expect(run.done).toBe(true);
    };
    const counted = () => storageUsageOf(db as unknown as Tx, accountId);
    const real = async () => {
      const [r] = await db.select({
        s: sql<number>`coalesce(sum(octet_length(${messageBodies.text}) + coalesce(octet_length(${messageBodies.html}), 0)), 0)`,
      }).from(messageBodies).innerJoin(messages, eq(messages.id, messageBodies.messageId))
        .where(eq(messages.accountId, accountId));
      return Number(r!.s);
    };
    return { d, accountId, fill, mailbox, erase, counted, real };
  }

  it("an erased mailbox's bytes leave the counter", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await w.mailbox("kept", 5, 100);
    const gone = await w.mailbox("gone", 5, 1);
    expect(await w.counted()).toBe(10_000);
    await w.erase(gone);
    expect(await w.counted(), "the erased mailbox's bytes stayed on the counter").toBe(5_000);
    expect(await w.counted()).toBe(await w.real());
  });

  it("after a trim, erasing the mailbox that holds the emptied letters leaves the real sum", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const gone = await w.mailbox("gone", 5, 100);
    await w.mailbox("kept", 5, 1);
    await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, w.d, w.accountId, { targetBytes: 7_000, maxBodies: 100 }));
    expect(await w.counted()).toBe(7_000);
    await w.erase(gone);
    expect(await w.counted()).toBe(5_000);
    expect(await w.counted()).toBe(await w.real());
  });

  it("a plain removal and a re-import count both copies; erasing the kept copy leaves the new one", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const old = await w.mailbox("same", 4, 10, "same");
    await svc.delete(ctxFor(db, w.accountId), old.id);
    const again = await w.mailbox("again", 0, 0);
    await w.fill(again.id, 4, 10, "same");
    expect(await w.counted()).toBe(8_000);
    expect(await w.counted()).toBe(await w.real());
    await w.erase(old);
    expect(await w.counted()).toBe(4_000);
    expect(await w.counted()).toBe(await w.real());
  });
});
