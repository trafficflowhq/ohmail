import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { changeLog, drafts, mailboxes, messages } from "@trafficflow/db";
import { asc, eq } from "drizzle-orm";
import { DraftsService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * ═══ A DRAFT THAT PINS A MESSAGE CARRIES THE MESSAGE ═══════════════════════════════════════
 *
 * A windowed mirror evicts old mail and pins whatever the product is still using; a draft
 * replying to a message pins that message. A pin arriving for a row the client has already
 * evicted protects nothing — the reply renders a hole, and the `message_tags` precedent says the
 * row can never be re-delivered on its own, because its own change sits below the cursor.
 *
 * Five of the six server writers of a pinning row already re-emit the message beside it; this one
 * did not. The guards below are the emit and its two controls.
 *
 * WATCHED RED: forcing `DraftsService.recordDraftChange` down its unpaired branch reddens 3 here,
 * and dropping the `message` entry from its `recordChanges` list reddens the writer census beside
 * it. The client half — a mirror that has already evicted the row — is
 * `packages/client-engine/test/store-window.a2.test.ts`.
 */

const svc = new DraftsService();

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "a@x-ch.example" }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [msg] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "the old thread", fromAddress: "s@x-ch.example",
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  const now = new Date("2026-07-28T12:00:00Z");
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => now, requestId: "r" };
  return { db, accountId, ctx, mailboxId: mb!.id, messageId: msg!.id };
}

/** Every change row this account has, oldest first. */
async function log(db: Awaited<ReturnType<typeof setup>>["db"], accountId: string) {
  return db.select({ type: changeLog.entityType, op: changeLog.op, id: changeLog.entityId, seq: changeLog.seq })
    .from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));
}

describe("a draft's pin re-materializes its message", () => {
  it("a create naming a reply target emits the message update beside the draft", async () => {
    const { db, accountId, ctx, mailboxId, messageId } = await setup();

    const { draft, seq } = await svc.create(ctx, {
      mailboxId, subject: "Re: the old thread", body: "answering", inReplyToMessageId: messageId,
    });

    const rows = await log(db, accountId);
    expect(rows.map((r) => `${r.type}:${r.op}:${r.id}`)).toEqual([
      // THE MESSAGE FIRST: a page boundary between the two must deliver the mail before the row
      // that points at it, never the other way round.
      `message:update:${messageId}`,
      `draft:create:${draft.id}`,
    ]);
    // The returned seq is the higher of the pair, so a caller waiting on it sees BOTH.
    expect(Number(rows[1]!.seq)).toBe(seq);
    expect(Number(rows[0]!.seq)).toBeLessThan(seq);
  });

  it("an update that sets a reply target emits it too", async () => {
    const { db, accountId, ctx, mailboxId, messageId } = await setup();
    const { draft } = await svc.create(ctx, { mailboxId, subject: "new", body: "x" });

    const { seq } = await svc.update(ctx, draft.id, { inReplyToMessageId: messageId });

    const rows = await log(db, accountId);
    expect(rows.map((r) => `${r.type}:${r.op}:${r.id}`)).toEqual([
      `draft:create:${draft.id}`,
      `message:update:${messageId}`,
      `draft:update:${draft.id}`,
    ]);
    expect(Number(rows[2]!.seq)).toBe(seq);
    // And the reference really is stored — the emit would be a lie about an unwritten row.
    const [after] = await db.select({ ref: drafts.inReplyToMessageId }).from(drafts)
      .where(eq(drafts.id, draft.id));
    expect(after!.ref).toBe(messageId);
  });

  /**
   * THE CONTROL, and it is what stops the rule degenerating into "always emit two". A draft that
   * names no message pins nothing, so a second change row would be a message update about a
   * message id that does not exist — and on a busy composer the autosave writes one every two
   * seconds.
   */
  it("a draft that names no message emits one change, not two", async () => {
    const { db, accountId, ctx, mailboxId } = await setup();

    const { draft } = await svc.create(ctx, { mailboxId, subject: "nobody", body: "x" });
    await svc.update(ctx, draft.id, { body: "still nobody" });

    const rows = await log(db, accountId);
    expect(rows.map((r) => `${r.type}:${r.op}`)).toEqual(["draft:create", "draft:update"]);
  });

  /**
   * And a later save of a draft that ALREADY names a target does not re-emit it: the reference is
   * not new, every client holding this draft has already been handed the message once, and the
   * pin it establishes has been standing since the create.
   */
  it("a later save of the same reply does not re-emit the message", async () => {
    const { db, accountId, ctx, mailboxId, messageId } = await setup();
    const { draft } = await svc.create(ctx, {
      mailboxId, subject: "Re: the old thread", body: "a", inReplyToMessageId: messageId,
    });

    await svc.update(ctx, draft.id, { body: "ab" });

    const rows = await log(db, accountId);
    expect(rows.map((r) => `${r.type}:${r.op}`)).toEqual([
      "message:update", "draft:create", "draft:update",
    ]);
  });
});
