import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  PROFILE_FOUND_AUDIT_ACTION, accounts, auditLog, drafts, eraseOwedMailbox, mailboxes, messages, outboundSends, recordChanges,
  threadNotes, threads, type LedgerTx,
} from "@trafficflow/db";
import {
  OhmailEngine, consentPartition, presentationReader, screenerSegments,
  type EngineAdapter, type EngineMessage, type StorePolicy, type SyncSnapshotPage,
} from "@ohmail/client-engine";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, SyncService, type ServiceContext } from "@trafficflow/services";

/**
 * AN ERASED MAILBOX LEAVES THE OTHER MAILBOX'S SCREENER WHERE IT STOOD BEFORE THE ADD — the hosted
 * half of that change. The erased mailbox's newer mail displaced the kept one's oldest rows from
 * a windowed mirror; the sweep's deletes and its one `mailbox` receipt took that mail, and nothing
 * brought the displaced rows back. Real path: `MailboxService.delete` with erase, the worker's
 * sweep, and the change log and snapshot through `SyncService` into the client engine.
 * Mutations: drop `refillWindow()` from the drain's settle and the kept mailbox stays two short;
 * widen the sweep's send delete to the account and the second case reds on the kept send.
 */

const NOW = new Date("2026-09-26T08:00:00.000Z");
const DAY = 86_400_000;
const WINDOW: StorePolicy = { mode: "windowed", days: 1, minRows: 4, maxRows: 4 };
const SHARED = "shared@elsewhere.test";
const svc = makeMailboxService({ keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 5), 1) });
const sync = new SyncService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "erasure-refills-the-window" });

/** Mail as ingest leaves it: a row plus its `create` on the change log. */
async function deliver(db: Db, accountId: string, mailboxId: string, mail: Array<[string, number]>): Promise<void> {
  const ids: string[] = [];
  for (const [from, daysAgo] of mail) {
    const key = `mid:${mailboxId.slice(0, 8)}-${from}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, messageIdHeader: key, bodyHash: key, dedupKey: key,
      subject: `from ${from}`, fromAddress: from, date: new Date(NOW.getTime() - daysAgo * DAY),
      nativeLocator: { folder: "INBOX", ref: `1:${ids.length + 1}` },
    }).returning();
    ids.push(m!.id);
  }
  await db.transaction(async (tx) => {
    await recordChanges(tx as unknown as LedgerTx, ids.map((id) => ({
      accountId, entityType: "message" as const, entityId: id, op: "create" as const, meta: null,
    })));
  });
}

/** The client engine over the hosted feed and snapshot, as the web client's adapter serves them. */
function engineOver(ctx: ServiceContext): OhmailEngine {
  const adapter = {
    sync: async (p: { since: string; limit?: number }) => sync.getChanges(ctx, {
      ...(p.since !== "0" ? { since: p.since } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}),
    }),
    snapshot: async (p: { cursor?: string; limit?: number; phase?: "tail" }) =>
      (await sync.getSnapshot(ctx, p)) as unknown as SyncSnapshotPage,
    mutate: async () => { throw new Error("no mutations in this rig"); },
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, storePolicy: WINDOW, now: () => NOW });
}

function waitingIn(e: OhmailEngine, own: string[]): string[] {
  const r = e.read();
  const presented = presentationReader(r, consentPartition(r, { now: NOW, dormancyDays: 365, ownAddresses: own }));
  return screenerSegments(presented, NOW, "en", "UTC", own).waiting.map((x) => x.from.address).sort();
}

describe("erasing a mailbox on the hosted door", () => {
  it("keeps the other mailbox's waiting senders, the shared one included, at the count before the add", async () => {
    const db = await makeTestDb();
    const [a] = await db.insert(accounts).values({ name: "erasure-refills-the-window" }).returning();
    const accountId = a!.id;
    const ctx = ctxFor(db, accountId);
    const keptAddress = `kept-${accountId.slice(0, 8)}@example.test`;
    const goneAddress = `gone-${accountId.slice(0, 8)}@example.test`;
    const own = [keptAddress, goneAddress];
    const [kept] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: keptAddress }).returning();
    await deliver(db, accountId, kept!.id, [
      ["a1@elsewhere.test", 100], ["a2@elsewhere.test", 99], ["a3@elsewhere.test", 98], [SHARED, 97],
    ]);

    const engine = engineOver(ctx);
    await engine.start();
    const before = waitingIn(engine, own);
    expect(before).toEqual(["a1@elsewhere.test", "a2@elsewhere.test", "a3@elsewhere.test", SHARED]);

    const [gone] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: goneAddress }).returning();
    await deliver(db, accountId, gone!.id, [[SHARED, 5], ["b1@elsewhere.test", 4]]);
    await engine.syncOnce();
    expect(waitingIn(engine, own), "the precondition: the window was displaced").not.toContain("a1@elsewhere.test");

    await svc.delete(ctx, gone!.id, { erase: { confirmAddress: goneAddress } });
    const run = await eraseOwedMailbox(db, dialect(db), {
      accountId, mailboxId: gone!.id, now: () => NOW, maxSteps: 20,
    });
    expect(run.done, "the precondition: the sweep finished and wrote its receipt").toBe(true);
    await engine.syncOnce();

    const after = waitingIn(engine, own);
    expect(after, "the kept mailbox's Screener is not where it was before the add").toEqual(before);
    expect(after, "the shared sender left the kept mailbox's Screener").toContain(SHARED);
    expect(after, "the erased mailbox's own sender still waits").not.toContain("b1@elsewhere.test");
    const rows = engine.read().list<EngineMessage>("message");
    expect(rows.filter((m) => m.mailboxId === gone!.id), "the erased mailbox's mail is still on screen").toEqual([]);
    expect(rows.length, "the window was not refilled").toBe(4);
  });

  it("keeps what the other mailbox still holds — its reply's words, a shared conversation and its note, its send, its signature's receipt", async () => {
    /* The census's SHARED writes, measured on this door (`erasure-coverage-census.test.ts`
       names this case): each is a row that is not the erased mailbox's alone. */
    const db = await makeTestDb();
    const [a] = await db.insert(accounts).values({ name: "erasure-keeps-the-shared" }).returning();
    const accountId = a!.id;
    const ctx = ctxFor(db, accountId);
    const goneAddress = `gone-${accountId.slice(0, 8)}@example.test`;
    const [kept] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `kept-${accountId.slice(0, 8)}@example.test` }).returning();
    const [gone] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: goneAddress }).returning();
    const [shared] = await db.insert(threads).values({ accountId }).returning();
    const [own] = await db.insert(threads).values({ accountId }).returning();
    const plant = async (mailboxId: string, threadId: string): Promise<string> => {
      const key = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, threadId, messageIdHeader: key, bodyHash: key, dedupKey: key, fromAddress: SHARED,
      }).returning();
      return m!.id;
    };
    const keptMsg = await plant(kept!.id, shared!.id);
    await plant(gone!.id, shared!.id);
    const goneOwn = await plant(gone!.id, own!.id);
    await db.insert(threadNotes).values([
      { accountId, threadId: shared!.id, body: "both mailboxes" }, { accountId, threadId: own!.id, body: "gone alone" },
    ]);
    const [reply] = await db.insert(drafts).values({
      accountId, mailboxId: kept!.id, threadId: own!.id, inReplyToMessageId: goneOwn, subject: "Re: from the other mailbox",
    }).returning();
    const [goneDraft] = await db.insert(drafts).values({ accountId, mailboxId: gone!.id, subject: "gone's own" }).returning();
    const [keptSend] = await db.insert(outboundSends).values({
      accountId, draftId: reply!.id, idempotencyKey: randomUUID(), mintedMessageId: "<k@y>",
    }).returning();
    const [goneSend] = await db.insert(outboundSends).values({
      accountId, draftId: goneDraft!.id, idempotencyKey: randomUUID(), mintedMessageId: "<g@y>",
    }).returning();
    // The organizer's found-markers, each naming its copy's signature by receipt.
    const marker = (mailboxId: string, signatureReceipt: string) => ({
      accountId, action: PROFILE_FOUND_AUDIT_ACTION, inverse: null,
      payload: { mailboxId, state: "found", fingerprint: "f".repeat(64), heldForImport: true, signatureReceipt },
    });
    const [keptMarker, goneMarker] = await db.insert(auditLog)
      .values([marker(kept!.id, "1".repeat(32)), marker(gone!.id, "2".repeat(32))]).returning({ id: auditLog.id });

    await svc.delete(ctx, gone!.id, { erase: { confirmAddress: goneAddress } });
    expect((await eraseOwedMailbox(db, dialect(db), { accountId, mailboxId: gone!.id, now: () => NOW, maxSteps: 20 })).done).toBe(true);

    const [words] = await db.select().from(drafts).where(eq(drafts.id, reply!.id));
    expect(words?.subject, "a reply drafted in the other mailbox was deleted").toBe("Re: from the other mailbox");
    expect(words?.inReplyToMessageId, "the reply still points at an erased message").toBeNull();
    expect(words?.threadId, "the reply still points at a conversation that is gone").toBeNull();
    expect((await db.select().from(drafts).where(eq(drafts.id, goneDraft!.id))).length).toBe(0);
    const sends = (await db.select({ id: outboundSends.id }).from(outboundSends)).map((r) => r.id);
    expect(sends, "the other mailbox's send record was taken").toContain(keptSend!.id);
    expect(sends, "the erased mailbox's send record stayed").not.toContain(goneSend!.id);
    const threadIds = (await db.select({ id: threads.id }).from(threads)).map((r) => r.id);
    expect(threadIds).toContain(shared!.id);
    expect(threadIds).not.toContain(own!.id);
    const notes = await db.select({ threadId: threadNotes.threadId }).from(threadNotes);
    expect(notes.map((n) => n.threadId)).toEqual([shared!.id]);
    const [survivor] = await db.select().from(messages).where(eq(messages.id, keptMsg));
    expect(survivor?.threadId, "the other mailbox's message lost its conversation").toBe(shared!.id);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, kept!.id));
    expect([row?.status, row?.erasedAt], "the other mailbox's own row was written").toEqual([kept!.status, null]);
    const payloadOf = async (id: string) => (await db.select({ p: auditLog.payload }).from(auditLog).where(eq(auditLog.id, id)))[0]?.p;
    expect(await payloadOf(keptMarker!.id), "the other mailbox's marker lost a hash")
      .toMatchObject({ signatureReceipt: "1".repeat(32), fingerprint: "f".repeat(64) });
    expect(await payloadOf(goneMarker!.id), "the erased mailbox's marker still names its signature").not.toHaveProperty("signatureReceipt");
    expect(await payloadOf(goneMarker!.id), "the erased mailbox's marker still names its settings").not.toHaveProperty("fingerprint");
    expect(await payloadOf(goneMarker!.id), "the marker row went with its receipt").toMatchObject({ mailboxId: gone!.id, state: "found" });
  });
});
