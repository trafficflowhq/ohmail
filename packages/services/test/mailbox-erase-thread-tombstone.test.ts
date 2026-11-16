import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import {
  accounts, eraseOwedMailbox, mailboxes, messages, recordChanges, threads, type LedgerTx,
} from "@trafficflow/db";
import { MemoryMirrorStore } from "@ohmail/client-engine";
import { StaticKeyProvider } from "@trafficflow/core";
import { dbFor, makeMailboxService, SyncService, type ServiceContext } from "@trafficflow/services";

/**
 * AN ERASED MAILBOX'S CONVERSATIONS LEAVE EVERY MIRROR.
 *
 * The sweep deletes a thread only the erased mailbox is in, and the mailbox receipt names no
 * thread, so a mirror kept its subject and participants until it re-bootstrapped. Real path: the
 * change log through `SyncService.getChanges` into the client engine's own store, on both stores.
 * Mutation: drop the `recordChanges` of the thread deletes in `eraseExclusiveThreads` and the
 * exclusive thread stays in the mirror.
 */

const NOW = new Date("2026-09-26T08:00:00.000Z");
const svc = makeMailboxService({ keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 5), 1) });
const sync = new SyncService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "erase-thread-tombstone" });

async function seed(db: Db) {
  const [a] = await db.insert(accounts).values({ name: "erase-thread-tombstone" }).returning();
  const accountId = a!.id;
  const address = `gone-${accountId.slice(0, 8)}@example.test`;
  const [gone] = await db.insert(mailboxes).values({ accountId, provider: "imap", address }).returning();
  const [kept] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `kept-${accountId.slice(0, 8)}@example.test` }).returning();
  const [own] = await db.insert(threads).values({ accountId }).returning();
  const [shared] = await db.insert(threads).values({ accountId }).returning();
  const plant = async (mailboxId: string, threadId: string, n: number) => {
    const key = `mid:${accountId.slice(0, 8)}-${n}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, threadId, messageIdHeader: key, bodyHash: key, dedupKey: key,
      subject: `Glaze order ${n}`, fromAddress: "giulia@example.test",
    }).returning();
    return m!.id;
  };
  const ownMsg = await plant(gone!.id, own!.id, 1);
  const sharedGoneMsg = await plant(gone!.id, shared!.id, 2);
  const sharedKeptMsg = await plant(kept!.id, shared!.id, 3);
  /* Announced the way ingest announces them, so the bootstrap materializes real DTOs. */
  await db.transaction(async (tx) => {
    await recordChanges(tx as unknown as LedgerTx, [
      ...[own!.id, shared!.id].map((id) => ({ accountId, entityType: "thread" as const, entityId: id, op: "create" as const, meta: null })),
      ...[ownMsg, sharedGoneMsg, sharedKeptMsg].map((id) => ({ accountId, entityType: "message" as const, entityId: id, op: "create" as const, meta: null })),
    ]);
  });
  return { accountId, address, goneId: gone!.id, ownThread: own!.id, sharedThread: shared!.id, sharedKeptMsg };
}

/** Drain the feed from `since` into the store, page by page, and return the last cursor. */
async function drain(store: MemoryMirrorStore, ctx: ServiceContext, since?: string): Promise<string> {
  let cursor = since;
  for (;;) {
    const resp = await sync.getChanges(ctx, cursor === undefined ? {} : { since: cursor });
    await store.applyResponse(resp);
    cursor = resp.cursor;
    if (!resp.hasMore) return cursor;
  }
}

describe("erasing a mailbox tells every mirror which conversations went", () => {
  it("the mailbox's own thread leaves the mirror; a shared one and its other message stay", async () => {
    const db = await makeTestDb();
    const s = await seed(db);
    const ctx = ctxFor(db, s.accountId);
    const store = new MemoryMirrorStore();
    await store.load();
    const cursor = await drain(store, ctx);
    expect(store.get("thread", s.ownThread), "the precondition: the mirror holds the thread").toBeDefined();

    await svc.delete(ctx, s.goneId, { erase: { confirmAddress: s.address } });
    const run = await eraseOwedMailbox(db, dialect(db), {
      accountId: s.accountId, mailboxId: s.goneId, now: () => NOW, maxSteps: 10,
    });
    expect(run.done, "the erasure did not finish on this store").toBe(true);
    await drain(store, ctx, cursor);

    expect(store.get("thread", s.ownThread),
      "the erased mailbox's own conversation is still in the mirror").toBeUndefined();
    expect(store.get("thread", s.sharedThread),
      "a conversation another mailbox is in left the mirror").toBeDefined();
    expect(store.get("message", s.sharedKeptMsg), "the other mailbox's message left the mirror").toBeDefined();
    const [row] = await db.select({ id: threads.id }).from(threads);
    expect(row?.id, "the store and the mirror disagree about which thread stands").toBe(s.sharedThread);
  });
});
