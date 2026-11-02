import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { drafts, mailboxes } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { DraftsService, SendService, sendContentFingerprint } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * WHAT IS SENT IS WHAT WAS SHOWN AT THE PRESS.
 *
 * Two windows hold one draft. B's autosave departs, A presses Send, and B's PUT commits between
 * A's final PUT and A's send POST. The send then reads the ROW — B's recipients, B's words — and
 * delivers them under A's press, clears A's editor and reports success. The row a send was
 * composed against is named on the request (`ifContentRevision`) and a row that moved under it is
 * refused, `draft_changed`, with nothing sent.
 */
const draftsSvc = new DraftsService();
const sendSvc = new SendService();
const NOW = new Date("2026-09-14T12:00:00Z");

/** A fake SendAdapter — no network. Records every envelope it was asked to deliver. */
function fakeAdapter() {
  const state = { delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to tear down */ },
  });
  return { factory, state };
}

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "author@lichtgrat.example",
  }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
  const { draft } = await draftsSvc.create(ctx, {
    mailboxId: mb!.id,
    subject: "the invoice",
    body: "Here is the invoice you asked for.",
    to: [{ name: null, address: "chosen@example.com" }],
  });
  return { db, ctx, accountId, mailboxId: mb!.id, draft };
}

describe("a send carries the row it was composed against", () => {
  it("refuses when another window wrote the row between the final save and the press", async () => {
    const { ctx, draft } = await setup();
    const fake = fakeAdapter();

    // A's final PUT — the words and the recipient the author is looking at.
    const a = await draftsSvc.update(ctx, draft.id, {
      body: "Here is the invoice you asked for.",
      to: [{ name: null, address: "chosen@example.com" }],
    });

    // B's delayed autosave lands. Different words, a different recipient.
    await draftsSvc.update(ctx, draft.id, {
      body: "scratch notes — do not send",
      to: [{ name: null, address: "someone-else@example.com" }],
    });

    const refusal = await sendSvc.send(
      ctx, draft.id, randomUUID(),
      { openSendAdapter: fake.factory },
      { ifContentRevision: a.draft.contentRevision },
    ).then(() => null).catch((e: unknown) => e as { code?: string; httpStatus?: number });

    // THE PRODUCT FACT FIRST: nothing left, and in particular not the other window's message.
    expect(
      fake.state.delivered.map((m) => m.text),
      "the other window's words were delivered under this press",
    ).toEqual([]);
    expect(refusal, "a row that moved under the press was sent anyway").not.toBeNull();
    expect(refusal!.code).toBe("draft_changed");
    expect(refusal!.httpStatus).toBe(409);

    // AND THE ROW IS LEFT SENDABLE — a refusal is not a wedge; the author reviews and presses again.
    const [row] = await ctx.db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row!.status).toBe("draft");
  });

  it("sends an ordinary press whose row nobody else touched", async () => {
    const { ctx, draft } = await setup();
    const fake = fakeAdapter();

    const a = await draftsSvc.update(ctx, draft.id, { body: "Here is the invoice you asked for." });
    const res = await sendSvc.send(
      ctx, draft.id, randomUUID(),
      { openSendAdapter: fake.factory },
      { ifContentRevision: a.draft.contentRevision },
    );

    expect(res.status).toBe("sent");
    expect(fake.state.delivered).toHaveLength(1);
    expect(fake.state.delivered[0]!.text).toContain("Here is the invoice you asked for.");
  });

  it("sends when the row was rewritten with the SAME content — nothing the author can see moved", async () => {
    const { ctx, draft } = await setup();
    const fake = fakeAdapter();

    const a = await draftsSvc.update(ctx, draft.id, { body: "Here is the invoice you asked for." });
    // The other window autosaves an identical buffer: `updated_at` moves, the message does not.
    await draftsSvc.update(ctx, draft.id, { body: "Here is the invoice you asked for." });

    const res = await sendSvc.send(
      ctx, draft.id, randomUUID(),
      { openSendAdapter: fake.factory },
      { ifContentRevision: a.draft.contentRevision },
    );

    expect(res.status).toBe("sent");
    expect(fake.state.delivered).toHaveLength(1);
  });

  it("sends a press that named no revision — an older client is not locked out of its own mail", async () => {
    const { ctx, draft } = await setup();
    const fake = fakeAdapter();

    const res = await sendSvc.send(ctx, draft.id, randomUUID(), { openSendAdapter: fake.factory });

    expect(res.status).toBe("sent");
    expect(fake.state.delivered).toHaveLength(1);
  });
});

describe("the names on screen travel with the addresses", () => {
  it("To and Cc keep their names, and From carries the mailbox's name", async () => {
    const { ctx, draft, mailboxId } = await setup();
    await ctx.db.update(mailboxes).set({ displayName: " Ada \r\n Lovelace " }).where(eq(mailboxes.id, mailboxId));
    await draftsSvc.update(ctx, draft.id, {
      to: [{ name: "Doe, John", address: "chosen@example.com" }, { name: null, address: "bare@example.com" }],
      cc: [{ name: "Cy", address: "cc@example.com" }],
    });
    const fake = fakeAdapter();
    expect((await sendSvc.send(ctx, draft.id, randomUUID(), { openSendAdapter: fake.factory })).status).toBe("sent");
    const msg = fake.state.delivered[0]!;
    expect(msg.from).toEqual({ name: "Ada Lovelace", address: "author@lichtgrat.example" });
    expect(msg.to).toEqual([{ name: "Doe, John", address: "chosen@example.com" }, "bare@example.com"]);
    expect(msg.cc).toEqual([{ name: "Cy", address: "cc@example.com" }]);
  });

  it("a mailbox with no name sends a bare From, as before", async () => {
    const { ctx, draft } = await setup();
    const fake = fakeAdapter();
    await sendSvc.send(ctx, draft.id, randomUUID(), { openSendAdapter: fake.factory });
    expect(fake.state.delivered[0]!.from).toBe("author@lichtgrat.example");
    expect(fake.state.delivered[0]!.to).toEqual(["chosen@example.com"]);
  });

  it("a name is capped and loses its control characters", async () => {
    const { ctx, draft, mailboxId } = await setup();
    await ctx.db.update(mailboxes).set({ displayName: "\u0007" + "x".repeat(150) }).where(eq(mailboxes.id, mailboxId));
    const fake = fakeAdapter();
    await sendSvc.send(ctx, draft.id, randomUUID(), { openSendAdapter: fake.factory });
    expect(fake.state.delivered[0]!.from).toEqual({ name: "x".repeat(100), address: "author@lichtgrat.example" });
  });

  it("two letters differing only in names are the same message to the duplicate guard", () => {
    const of = (name: string | null) => sendContentFingerprint({
      to: [{ name, address: "a@example.com" }], cc: [], bcc: [], subject: "s", html: null, body: "b",
      inReplyToMessageId: null, forwardOf: null, sendAt: null, attachments: [],
    });
    expect(of("Ada")).toBe(of(null));
  });
});
