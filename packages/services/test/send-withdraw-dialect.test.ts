import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { drafts, mailboxes, outboundSends } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, ServiceError, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * A CANCEL ON THE STORE A PHONE CARRIES. The standalone phone answers its own Cancel through the
 * same `SendService.withdraw`, so the tombstone, the replay gate's refusal and a settled row's
 * answer run on SQLite too. Both projects run this file (PGlite here, the device store under
 * `pnpm test:sqlite`); the race lives in `send-withdraw.pg.test.ts`, since one writer has none.
 */
const NOW = new Date("2026-10-05T12:00:00.000Z");
const SENT_AT = new Date("2026-10-05T11:40:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "me@withdraw.test",
  }).returning();
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the cancelled send", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "draft", createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  const rowOf = async (key: string) => {
    const [row] = await db.select().from(outboundSends)
      .where(and(eq(outboundSends.accountId, accountId), eq(outboundSends.idempotencyKey, key)));
    return row ?? null;
  };
  return { db, ctx, accountId, draftId: d!.id, rowOf };
}

/** An SMTP spy: every `send` it takes is a delivery to a real person. */
function smtp() {
  const delivered: OutboundMessage[] = [];
  const open: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId! }; },
    async messageInSent() { return false; },
    async close() { /* nothing to tear down */ },
  });
  return { open, delivered };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; return "answered"; } catch (err) {
    return err instanceof ServiceError ? `${err.httpStatus} ${err.code}` : `threw ${String(err)}`;
  }
}

describe("a Cancel the server decides, on either store", () => {
  it("a key nobody reserved is tombstoned; its send is refused with nothing sent; asked again, the same word", async () => {
    const w = await world();
    const spy = smtp();
    const svc = new SendService();

    const said = await svc.withdraw(w.ctx, "key-a", w.draftId, { openSendAdapter: spy.open });
    const tomb = await w.rowOf("key-a");
    const replay = await refusal(svc.send(w.ctx, w.draftId, "key-a", { openSendAdapter: spy.open }));
    const again = await svc.withdraw(w.ctx, "key-a", w.draftId, { openSendAdapter: spy.open });

    expect(said).toEqual({ outcome: "withdrawn" });
    expect({ status: tomb?.status, resolvedBy: tomb?.resolvedBy, draftId: tomb?.draftId })
      .toEqual({ status: "withdrawn", resolvedBy: "person", draftId: w.draftId });
    expect(replay, "a cancelled key's send was not refused on this store").toBe("409 send_withdrawn");
    expect(spy.delivered, "a cancelled key delivered").toHaveLength(0);
    expect(again).toEqual({ outcome: "withdrawn" });
  });

  it("a key whose send went answers already_sent with the delivery's instant, and its row is untouched", async () => {
    const w = await world();
    const spy = smtp();
    await w.db.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "key-b", draftId: w.draftId,
      mintedMessageId: `<${randomUUID()}@withdraw.test>`, status: "sent", sentAt: SENT_AT, createdAt: SENT_AT,
    });

    const said = await new SendService().withdraw(w.ctx, "key-b", w.draftId, { openSendAdapter: spy.open });
    const row = await w.rowOf("key-b");

    expect(said).toEqual({ outcome: "already_sent", firstSend: { status: "sent", at: SENT_AT.toISOString() } });
    expect(row?.status, "a Cancel rewrote a delivered send's row").toBe("sent");
    expect(spy.delivered, "a Cancel opened SMTP").toHaveLength(0);
  });

  it("a young pending reservation is in flight: nothing claimed, the row left to its attempt", async () => {
    const w = await world();
    const spy = smtp();
    await w.db.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "key-c", draftId: w.draftId,
      mintedMessageId: `<${randomUUID()}@withdraw.test>`, status: "pending", createdAt: NOW,
    });

    const said = await new SendService().withdraw(w.ctx, "key-c", w.draftId, { openSendAdapter: spy.open });

    expect(said).toEqual({ outcome: "in_flight" });
    expect((await w.rowOf("key-c"))?.status).toBe("pending");
    expect(spy.delivered).toHaveLength(0);
  });
});
