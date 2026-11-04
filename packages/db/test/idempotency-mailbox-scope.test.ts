import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import {
  accounts, idempotencyKeys, mailboxes, messages, threads, drafts, eraseIdempotentResponses, type Tx,
} from "../src/index.js";

/*
 * A MAILBOX ERASURE BLANKS THE RESPONSES OF THAT MAILBOX, not the account's
 * (IDEMPOTENCY-ERASURE-IS-ACCOUNT-WIDE-ON-A-MAILBOX-ERASURE). A stored response is read by what it
 * names: spared only when it names another live mailbox and nothing of this one. Unattributable
 * rows keep the wide answer. On whichever store this run is.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "idempotency-scope" });
  const mailbox = async (o: { erasedAt?: Date } = {}) => (await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID().slice(0, 8)}@example.test`, erasedAt: o.erasedAt ?? null,
  }).returning())[0]!.id;
  const [A, B, C] = [await mailbox(), await mailbox(), await mailbox({ erasedAt: NOW })];
  const [thread] = await db.insert(threads).values({ accountId, subject: "t" }).returning();
  const [msg] = await db.insert(messages).values({
    accountId, mailboxId: A, threadId: thread!.id, bodyHash: `h-${randomUUID()}`,
    dedupKey: `d-${randomUUID()}`, subject: "s", fromAddress: "x@example.test",
  }).returning();
  const [draft] = await db.insert(drafts).values({ accountId, mailboxId: A, subject: "s", body: "b" }).returning();
  const store = async (key: string, json: unknown) => {
    await db.insert(idempotencyKeys).values({
      accountId, key, requestHash: `h-${key}`, responseStatus: 200, responseJson: json, seq: null,
      expiresAt: new Date(NOW.getTime() + 3_600_000), createdAt: NOW,
    });
  };
  const erasedKeys = async () => (await db.select().from(idempotencyKeys)
    .where(eq(idempotencyKeys.accountId, accountId)))
    .filter((r) => r.erasedAt !== null).map((r) => r.key).sort();
  const row = async (key: string) => (await db.select().from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key))))[0]!;
  return { db, accountId, A, B, C, threadId: thread!.id, messageId: msg!.id, draftId: draft!.id, store, erasedKeys, row };
}

describe("the response cache at a mailbox erasure, on this store", () => {
  it("spares a response that names only another live mailbox, and blanks the rest", async () => {
    const w = await world();
    await w.store("other", { id: randomUUID(), mailboxId: w.B, body: "kept" });
    await w.store("this", { id: randomUUID(), mailboxId: w.A });
    await w.store("nothing", { ok: true });
    await w.store("both", { from: w.B, to: w.A });
    await w.store("other+message", { mailboxId: w.B, inReplyToMessageId: w.messageId });
    await w.store("other+thread", { mailboxId: w.B, threadId: w.threadId });
    await w.store("other+draft", { mailboxId: w.B, draftId: w.draftId });
    await w.store("erased-sibling", { mailboxId: w.C });

    const n = await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW, { mailboxId: w.A });

    expect(await w.erasedKeys()).toEqual(
      ["both", "erased-sibling", "nothing", "other+draft", "other+message", "other+thread", "this"].sort());
    expect(n).toBe(7);
    // A blanked row keeps no hash of its request either; the spared one keeps its own.
    const blanked = await Promise.all((await w.erasedKeys()).map((k) => w.row(k)));
    expect(new Set(blanked.map((r) => r.requestHash))).toEqual(new Set([""]));
    const kept = await w.row("other");
    expect({ erasedAt: kept.erasedAt, json: kept.responseJson, hash: kept.requestHash })
      .toEqual({ erasedAt: null, json: { id: expect.any(String), mailboxId: w.B, body: "kept" }, hash: "h-other" });
    // A retried erasure keeps the first stamp and blanks nothing new.
    expect(await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW, { mailboxId: w.A })).toBe(0);
  });

  it("THE CONTROL: without a mailbox every row of the account is blanked", async () => {
    const w = await world();
    await w.store("other", { mailboxId: w.B });
    await w.store("this", { mailboxId: w.A });
    expect(await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW)).toBe(2);
    expect(await w.erasedKeys()).toEqual(["other", "this"]);
    expect([(await w.row("other")).requestHash, (await w.row("this")).requestHash]).toEqual(["", ""]);
  });
});
