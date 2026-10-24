import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Duplex } from "node:stream";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends, messages, threads } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendNotSubmitted, SentCopyAppendFailed, UNMETERED_STORAGE_CAP, type SendOptions } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { SendService, SEND_STALE_AFTER_MS, SEND_UPLOAD_DROPPED_SENTENCE } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

const svc = new SendService();
const NOW = new Date("2026-07-28T12:00:00Z");

/**
 * A fake SendAdapter factory + a spy state so the double-send tests can COUNT
 * `send` calls and DRIVE `messageInSent` — no network (the crux of Phase 3c). It
 * echoes the pre-minted `messageId` back as the providerMessageId, exactly as the
 * real ImapAdapter does.
 */
function fakeAdapter(opts: { inSent?: boolean; throwOnSend?: boolean; throwAppendFailed?: boolean } = {}) {
  const state = { sendCalls: 0, closes: 0, sentIds: [] as string[], probed: [] as string[], sent: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.sentIds.push(msg.messageId!);
      state.sent.push(msg);
      if (opts.throwOnSend) throw new Error("smtp boom");
      // The real adapter's shape for "SMTP took it, the Sent APPEND did not" — the delivered id rides the error.
      if (opts.throwAppendFailed) throw new SentCopyAppendFailed(msg.messageId!, new Error("append boom"));
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent(id: string) {
      state.probed.push(id);
      return opts.inSent ?? false;
    },
    async close() {
      state.closes += 1;
    },
  });
  return { factory, state };
}

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const B = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "mila@lichtgrat.example" }).returning();
  const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => NOW, requestId: "r" };
  const ctxB: ServiceContext = { db, accountId: B, userId: null, now: () => NOW, requestId: "r" };
  async function newDraft(status = "draft", over: { subject?: string; body?: string } = {}) {
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId: mb!.id, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status,
      ...over,
    }).returning();
    return d!.id;
  }
  return { db, A, B, mailboxId: mb!.id, ctx, ctxB, newDraft };
}

describe("SendService — gated idempotent send (Phase 3c)", () => {
  it("first send: SMTP once, draft → sent, outbound_sends → sent, providerMessageId captured", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, draftId, "k1", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(res.providerMessageId).toBe(state.sentIds[0]);      // the pre-minted id, echoed back
    expect(res.providerMessageId).toMatch(/^<.+@lichtgrat\.example>$/);  // minted from the mailbox domain
    expect(res.seq).toBeGreaterThan(0);
    expect(state.closes).toBe(1);                               // adapter always closed

    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("sent");
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");
    expect(row!.providerMessageId).toBe(res.providerMessageId);
    expect(row!.mintedMessageId).toBe(res.providerMessageId);   // minted up front == delivered id
    expect(row!.sentAt).toBeInstanceOf(Date);
  });

  it("threads Cc AND Bcc from the draft into the OutboundMessage the adapter is handed", async () => {
    // The service is where the stored recipients become the envelope. The header/envelope
    // asymmetry that makes Bcc blind is one layer down (the MIME builder,
    // `packages/core/test/outbound-cc-bcc.test.ts`); what this proves is that the service does not
    // DROP the bcc on the way there — the bug this slice replaced, where `drafts.cc` was stored and
    // never delivered.
    const { db, ctx, A, mailboxId } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "numbers", body: "see attached",
      to: [{ name: null, address: "to@example.com" }],
      cc: [{ name: "Cee", address: "cc@example.com" }],
      bcc: [{ name: null, address: "bcc@example.com" }],
      status: "draft",
    }).returning();
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, d!.id, "cc-bcc-1", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.to).toEqual(["to@example.com"]);
    expect(state.sent[0]!.cc).toEqual(["cc@example.com"]);
    expect(state.sent[0]!.bcc).toEqual(["bcc@example.com"]);
  });

  it("a draft with recipients ONLY in Bcc is still a real send, not 'no recipients'", async () => {
    // The "no recipients" refusal is about an empty envelope, not an empty To — a mailing-list
    // style blind send addresses everyone in Bcc.
    const { db, ctx, A, mailboxId } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "quiet word", body: "hi",
      to: [], cc: [], bcc: [{ name: null, address: "blind@example.com" }], status: "draft",
    }).returning();
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, d!.id, "bcc-only", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sent[0]!.to).toEqual([]);
    expect(state.sent[0]!.bcc).toEqual(["blind@example.com"]);
  });

  it("CRUX — same Idempotency-Key does NOT resend: send twice → send-count 1, same result", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();

    const first = await svc.send(ctx, draftId, "same", { openSendAdapter: factory });
    const second = await svc.send(ctx, draftId, "same", { openSendAdapter: factory });

    expect(state.sendCalls).toBe(1);                            // NEVER a second send
    expect(second.status).toBe("sent");
    expect(second.providerMessageId).toBe(first.providerMessageId);
  });

  it("CRUX — crash-recovery, DELIVERED: a stale pending whose id IS in Sent reconciles to sent, NO resend", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    // A crashed prior attempt: draft left 'sending', a pending outbound_sends row
    // whose minted id IS present in the Sent folder (fake messageInSent → true).
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    const minted = "<delivered-9f3c@lichtgrat.example>";
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "recover", draftId: d!.id, mintedMessageId: minted, status: "pending",
      // STALE, explicitly: older than `SEND_STALE_AFTER_MS`, so no invocation can still be behind
      // it. A YOUNG pending row is a send in flight and must answer `in_flight` instead of being
      // probed — see the dedicated case below.
      createdAt: new Date(NOW.getTime() - SEND_STALE_AFTER_MS - 1000),
    });
    const { factory, state } = fakeAdapter({ inSent: true });

    const res = await svc.send(ctx, d!.id, "recover", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(0);                            // reconciled, NOT resent
    expect(state.probed).toContain(minted);                    // verified by Sent
    expect(res.providerMessageId).toBe(minted);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.id, (await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id)))[0]!.id));
    expect(row!.status).toBe("sent");
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(draft!.status).toBe("sent");
  });

  it("CRUX — crash-recovery, AMBIGUOUS: a stale pending NOT in Sent → unverified, NO resend", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    const minted = "<ambiguous-2b1a@lichtgrat.example>";
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "amb", draftId: d!.id, mintedMessageId: minted, status: "pending",
      createdAt: new Date(NOW.getTime() - SEND_STALE_AFTER_MS - 1000),     // stale: no live sender
    });
    const { factory, state } = fakeAdapter({ inSent: false });

    const res = await svc.send(ctx, d!.id, "amb", { openSendAdapter: factory });

    expect(res.status).toBe("unverified");
    expect(state.sendCalls).toBe(0);                            // NEVER auto-resend on ambiguity
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id));
    expect(row!.status).toBe("unverified");
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(draft!.status).toBe("unverified");
  });

  it("a YOUNG pending reservation is in_flight — the recovery path must not probe a live send", async () => {
    // The double-tap. The first attempt is still mid-SMTP; probing Sent now finds nothing (the
    // message has not landed YET) and writing `unverified` would report a SUCCEEDING send as
    // ambiguous and tell the user to go check their Sent folder. It also made the `in_flight`
    // outcome this service declares unreachable.
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "live", draftId: d!.id,
      mintedMessageId: "<inflight-1@lichtgrat.example>", status: "pending",
      createdAt: new Date(NOW.getTime() - 5_000),        // 5 s old: an invocation could still be alive
    });
    const { factory, state } = fakeAdapter({ inSent: false });

    const res = await svc.send(ctx, d!.id, "live", { openSendAdapter: factory });

    expect(res.status).toBe("in_flight");
    expect(state.sendCalls).toBe(0);                     // never resent
    expect(state.probed).toEqual([]);                    // and never even probed
    // The reservation is UNTOUCHED, so the real sender can still finalize it.
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id));
    expect(row!.status).toBe("pending");
    const [draftRow] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(draftRow!.status).toBe("sending");
  });

  it("the cutoff is a boundary, not a vibe: one ms past it, recovery runs", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "edge", draftId: d!.id,
      mintedMessageId: "<edge-1@lichtgrat.example>", status: "pending",
      createdAt: new Date(NOW.getTime() - SEND_STALE_AFTER_MS - 1),
    });
    const { factory } = fakeAdapter({ inSent: true });
    expect((await svc.send(ctx, d!.id, "edge", { openSendAdapter: factory })).status).toBe("sent");
  });

  /**
   * THIS CASE USED TO ASSERT THE DEFECT, AND THE EXPECTATION MOVED BY RULING.
   *
   * It read: two drafts from the same fixture, sent under `key-A` and `key-B`, expecting TWO
   * deliveries and two reservation rows. That is not an incidental fixture collision — it is
   * exactly the sequence a duplicate send takes, written down as a passing test: one message, two
   * drafts, two keys, two copies in somebody's inbox. The account now claims a message's CONTENT
   * for `SEND_DUPLICATE_WINDOW_MS`, so the second one is refused whatever key it carries and
   * whatever draft it names.
   *
   * The original intent is worth keeping and is kept: a FRESH KEY IS NOT BLOCKED BY THE KEY GATE.
   * That is now asserted where it is actually true — on a different message — and the case the old
   * one really covered is asserted beside it, so this file is stricter than it was rather than
   * looser. Splitting them is what makes each one able to fail alone.
   */
  it("a DIFFERENT key on a DIFFERENT message sends again (a second outbound_sends row)", async () => {
    const { db, ctx, newDraft } = await setup();
    const d1 = await newDraft();
    const d2 = await newDraft("draft", { body: "Thanks — one more thing." });
    const { factory, state } = fakeAdapter();

    await svc.send(ctx, d1, "key-A", { openSendAdapter: factory });
    await svc.send(ctx, d2, "key-B", { openSendAdapter: factory });

    expect(state.sendCalls).toBe(2);
    const rows = await db.select().from(outboundSends);
    expect(rows).toHaveLength(2);
  });

  it("a DIFFERENT key on the SAME message is refused — one submission, and the second reservation rolls back", async () => {
    const { db, ctx, newDraft } = await setup();
    const d1 = await newDraft();
    const d2 = await newDraft();                     // byte-identical: the measured duplicate shape
    const { factory, state } = fakeAdapter();

    await svc.send(ctx, d1, "key-A", { openSendAdapter: factory });
    const err = await svc.send(ctx, d2, "key-B", { openSendAdapter: factory })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 409, code: "duplicate_send" });
    // The assertion is the SUBMISSION count, not the row count: the submission is the harm.
    expect(state.sendCalls).toBe(1);
    // And the refusal rolled its own reservation back rather than leaving a spent row behind.
    const rows = await db.select().from(outboundSends);
    expect(rows).toHaveLength(1);
    const [second] = await db.select().from(drafts).where(eq(drafts.id, d2));
    expect(second!.status, "the refused draft is untouched and still sendable").toBe("draft");
  });

  it("SMTP throws but the id IS in Sent → sent (verify-on-throw, no assumption)", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter({ throwOnSend: true, inSent: true });

    const res = await svc.send(ctx, draftId, "throw-ok", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);                            // the single (throwing) attempt
    expect(state.probed.length).toBe(1);                       // then verified by Sent
  });

  it("SMTP throws and the id is NOT in Sent → unverified (never blindly failed/resent)", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter({ throwOnSend: true, inSent: false });

    const res = await svc.send(ctx, draftId, "throw-amb", { openSendAdapter: factory });

    expect(res.status).toBe("unverified");
    expect(state.sendCalls).toBe(1);
  });

  /**
   * THE SENT COPY FAILED, NOT THE SEND. `ImapAdapter.send` appends to Sent AFTER `sendMail`
   * resolved, and one `catch` over both used to read an append fault as "SMTP threw": probe, miss
   * (nothing was appended), `unverified` — a person sent to look for their own delivered mail.
   * Mutation: drop the `SentCopyAppendFailed` arm in `send()`'s catch → status reads `unverified`.
   */
  it("the Sent APPEND fails after SMTP accepted the message → sent, no probe, the copy's absence logged", async () => {
    const { ctx, newDraft, db } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter({ throwAppendFailed: true, inSent: false });
    const lines: string[] = [];
    const log = { info() {}, warn(ev: string) { lines.push(ev); }, error() {}, debug() {} } as never;

    const res = await svc.send(ctx, draftId, "append-failed", { openSendAdapter: factory, log });

    expect(res.status, "a delivered message was recorded as ambiguous because its Sent copy failed").toBe("sent");
    expect(state.probed.length, "the Sent folder was probed for a message the adapter said it delivered").toBe(0);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");
    expect(row!.providerMessageId).toBe(state.sentIds[0]);
    expect(lines, "the missing copy is not said anywhere").toContain("send_sent_copy_append_failed");
  });

  it("cross-account draft → 404, and the adapter is never opened", async () => {
    const { ctxB, newDraft } = await setup();
    const draftId = await newDraft();                          // belongs to account A
    const { factory, state } = fakeAdapter();
    await expect(svc.send(ctxB, draftId, "x", { openSendAdapter: factory }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect(state.sendCalls).toBe(0);
  });

  it("an already-sent draft cannot be re-sent into a duplicate under a NEW key → 409, no resend, no orphan row", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();
    await svc.send(ctx, draftId, "first", { openSendAdapter: factory });  // draft → sent
    expect(state.sendCalls).toBe(1);

    await expect(svc.send(ctx, draftId, "second", { openSendAdapter: factory }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect(state.sendCalls).toBe(1);                            // no second send
    const rows = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(rows).toHaveLength(1);                               // the 409 rolled back its reservation
  });

  it("a draft with no recipients → 400", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b", status: "draft",
    }).returning();
    const { factory, state } = fakeAdapter();
    await expect(svc.send(ctx, d!.id, "no-to", { openSendAdapter: factory }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect(state.sendCalls).toBe(0);
    const rows = await db.select().from(outboundSends).where(and(eq(outboundSends.draftId, d!.id)));
    expect(rows).toHaveLength(0);                               // no orphan reservation
  });
});

/**
 * RFC 5322 §3.6.4 — References is the parent's chain PLUS the parent, not the parent alone.
 *
 * The shipped code sent `references: inReplyTo`. A recipient whose client threads on the
 * LEFTMOST reference then anchors the reply mid-chain and mints a second conversation for one
 * exchange — and our own ingest threads on the leftmost entry precisely because that is the
 * behaviour that converges (`threads.rootMessageIdHeader`). We were sending other people mail
 * we would have mis-threaded ourselves.
 *
 * We do not persist the arriving `References` header, so the full chain is unavailable; root +
 * parent is what the data supports and it is what carries the meaning. These guards assert
 * that contract, including its ORDER, which is the half that actually matters.
 */
describe("SendService — reply threading (RFC 5322 §3.6.4)", () => {
  async function replyTo(opts: { root: string | null; parentHeader: string }) {
    const { db, ctx, mailboxId, A } = await setup();
    const [th] = await db.insert(threads)
      .values({ accountId: A, subject: "Re: hi", rootMessageIdHeader: opts.root })
      .returning();
    const [parent] = await db.insert(messages).values({
      accountId: A, mailboxId, subject: "hi", messageIdHeader: opts.parentHeader,
      threadId: th!.id, nativeLocator: `INBOX:${randomUUID()}`,
      bodyHash: randomUUID(), dedupKey: opts.parentHeader,
    }).returning();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
      inReplyToMessageId: parent!.id,
    }).returning();
    const { factory, state } = fakeAdapter();
    const sent: OutboundMessage[] = [];
    const spy: OpenSendAdapter = async () => {
      const a = await factory();
      return { ...a, async send(m: OutboundMessage) { sent.push(m); return a.send(m); } };
    };
    await svc.send(ctx, d!.id, "k-" + randomUUID(), { openSendAdapter: spy });
    expect(state.sendCalls).toBe(1);
    return sent[0]!;
  }

  it("carries the thread ROOT before the parent — a mid-chain reply keeps its conversation", async () => {
    const msg = await replyTo({ root: "<root@a.invalid>", parentHeader: "<parent@a.invalid>" });
    expect(msg.inReplyTo).toBe("<parent@a.invalid>");
    // Order is the assertion. `<parent> <root>` would anchor leftmost-threading clients on the
    // wrong id, which is the whole defect wearing different clothes.
    expect(msg.references).toBe("<root@a.invalid> <parent@a.invalid>");
  });

  it("does not repeat one id twice when replying to the root itself", async () => {
    const msg = await replyTo({ root: "<root@a.invalid>", parentHeader: "<root@a.invalid>" });
    expect(msg.references).toBe("<root@a.invalid>");
  });

  it("falls back to the parent alone when the thread has no root header", async () => {
    const msg = await replyTo({ root: null, parentHeader: "<parent@a.invalid>" });
    expect(msg.references).toBe("<parent@a.invalid>");
  });

  it("a message that is not a reply carries neither header", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "new", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    const sent: OutboundMessage[] = [];
    const { factory } = fakeAdapter();
    const spy: OpenSendAdapter = async () => {
      const a = await factory();
      return { ...a, async send(m: OutboundMessage) { sent.push(m); return a.send(m); } };
    };
    await svc.send(ctx, d!.id, "k-" + randomUUID(), { openSendAdapter: spy });
    expect(sent[0]!.inReplyTo).toBeUndefined();
    expect(sent[0]!.references).toBeUndefined();
  });
});

/**
 * A SLOW SUBMISSION, over a double that fails the way the real adapter does: the end of the
 * message waits for `beforeRelease`, the IMAP leg dialled before SMTP idles out while the 250 is
 * slow (its `isLive` reads false and every command throws `NoConnection`), and a fresh dial works.
 */
function slowSmtp(o: { copyDiesOnFirst?: boolean; dropMidUpload?: boolean; lostReply?: boolean; reopenUnreachable?: boolean } = {}) {
  const sentFolder: string[] = [];
  const state = { dials: 0, released: 0, delivered: 0, looks: [] as boolean[], probes: 0 };
  const dead = () => Object.assign(new Error("Connection not available"), { code: "NoConnection" });
  const factory: OpenSendAdapter = async () => {
    state.dials += 1;
    const n = state.dials;
    if (n > 1 && o.reopenUnreachable) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    let live = true;
    return {
      async send(msg: OutboundMessage, opts?: SendOptions) {
        await new Promise((r) => { setTimeout(r, 20); });
        if (o.dropMidUpload) {
          throw new SendNotSubmitted("data", Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" }));
        }
        await opts?.beforeRelease?.();
        state.released += 1;
        if (o.copyDiesOnFirst || o.lostReply) live = false;   // the IMAP leg idled out under the slow 250
        if (o.lostReply) throw Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
        state.delivered += 1;
        const raw = Buffer.from(`Message-ID: ${msg.messageId!}\r\nTo: you@example.com\r\nSubject: Re: hi\r\n\r\nThanks!\r\n`);
        return opts?.copy === "caller" ? { providerMessageId: msg.messageId!, unfiledCopy: raw } : { providerMessageId: msg.messageId! };
      },
      async fileSentCopy(raw: Buffer, id: string, look?: { look?: boolean }) {
        if (!live) throw dead();
        state.looks.push(look?.look === true);
        if (look?.look === true && sentFolder.includes(id)) return null;
        sentFolder.push(id);
        return { locator: { folder: "Sent", ref: `9:${sentFolder.length}` }, raw };
      },
      // The old adapter's answer on a dead connection: "not there".
      async messageInSent(id: string) { state.probes += 1; if (!live && n > 1) throw dead(); return live && sentFolder.includes(id); },
      isLive: () => live,
      async close() { live = false; },
    };
  };
  return { factory, state, sentFolder };
}

/**
 * The real adapter over a link that carries `rate` bytes a second (bytes wait in the socket's own
 * write queue, as on a phone), to a submission server that drops the connection after `dropAt`
 * bytes of DATA. Its Sent folder never holds the message.
 */
async function slowLinkSmtp(rate: number, dropAt: number) {
  const seen = { dataBytes: 0, mark: false };
  const server = net.createServer((s) => {
    s.on("error", () => undefined);
    s.write("220 fake ESMTP\r\n");
    let inData = false;
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf = inData ? (buf + d.toString("latin1")).slice(-8) : buf + d.toString("latin1");
      if (inData) {
        seen.dataBytes += d.length;
        seen.mark ||= buf.includes("\r\n.\r\n");
        if (seen.dataBytes > dropAt) s.destroy();
        return;
      }
      for (let i = buf.indexOf("\r\n"); i >= 0 && !inData; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^DATA/i.test(line)) { s.write("354 go\r\n"); inData = true; buf = ""; }
        else s.write(/^EHLO/i.test(line) ? "250-fake\r\n250 AUTH PLAIN\r\n" : /^AUTH/i.test(line) ? "235 ok\r\n" : "250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const factory: OpenSendAdapter = async () => {
    const imap = { list: async () => [{ path: "INBOX", delimiter: "/", flags: new Set() }], on: () => undefined, logout: async () => undefined, close: () => undefined };
    const a = new ImapAdapter({
      host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: "p" },
      smtp: { host: "127.0.0.1", port, secure: false, allowInsecure: true, auth: { user: "u", pass: "p" } },
    } as never, { client: imap as never });
    await a.connect();
    (a as unknown as { transporter: { getSocket: unknown } }).transporter.getSocket = (_o: unknown, cb: (e: null, s: { connection: Duplex }) => void) => {
      const sock = net.connect(port, "127.0.0.1", () => cb(null, { connection: link }));
      const link = new Duplex({
        write(chunk: Buffer, _e, done) { setTimeout(() => { if (!sock.destroyed) sock.write(chunk); done(); }, (chunk.length / rate) * 1000); },
        read() { /* pushed from the socket */ },
      });
      Object.assign(link, { setTimeout: () => link, setKeepAlive: () => link });
      sock.on("data", (d: Buffer) => link.push(d)).on("error", () => undefined).on("close", () => link.destroy());
    };
    return {
      send: (m: OutboundMessage, o?: SendOptions) => a.send(m, o), fileSentCopy: async () => null,
      messageInSent: async () => false, isLive: () => true, close: async () => undefined,
    };
  };
  return { factory, seen, close: () => server.close() };
}

describe("a slow submission: the Sent copy follows every accepted send exactly once", () => {
  const quick = { graceMs: 2_000, deadlineMs: 2_000, waitsMs: [0, 10, 10] };

  it("the first connection's copy dies; the reopened one files exactly one copy, projected, `sentCopy: filed`", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const smtp = slowSmtp({ copyDiesOnFirst: true });
    const res = await svc.send(ctx, draftId, "slow-1", {
      openSendAdapter: smtp.factory, copyTiming: quick, resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
    });
    expect({ status: res.status, sentCopy: res.sentCopy }).toEqual({ status: "sent", sentCopy: "filed" });
    expect(smtp.state).toMatchObject({ delivered: 1, dials: 2, looks: [true] });
    expect(smtp.sentFolder, "one copy, under the minted id").toEqual([res.providerMessageId]);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect({ status: row!.status, offerState: row!.offerState }).toEqual({ status: "sent", offerState: "complete" });
    const mirrored = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.messageIdHeader, res.providerMessageId!.replace(/[<>]/g, "")));
    expect(mirrored, "the copy is projected").toHaveLength(1);
  });

  it("on a host that outlives the answer, a copy that cannot land yet answers `pending` and is filed after", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const smtp = slowSmtp({ copyDiesOnFirst: true });
    const res = await svc.send(ctx, draftId, "slow-2", {
      openSendAdapter: smtp.factory, copyOutlivesAnswer: true, copyTiming: { graceMs: 0, deadlineMs: 0, waitsMs: [50] },
    });
    expect({ status: res.status, sentCopy: res.sentCopy }).toEqual({ status: "sent", sentCopy: "pending" });
    for (let i = 0; i < 100 && smtp.sentFolder.length === 0; i += 1) await new Promise((r) => { setTimeout(r, 10); });
    expect(smtp.sentFolder).toEqual([res.providerMessageId]);
  });

  it("a connection dropped mid-upload is `failed` and the draft a draft again; the key's replay says why", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const smtp = slowSmtp({ dropMidUpload: true });
    const out = await svc.send(ctx, draftId, "slow-3", { openSendAdapter: smtp.factory }).then((r) => r, (e: unknown) => e);
    expect(out).toMatchObject({ code: "send_upload_dropped", httpStatus: 424, retryable: false });
    expect((out as Error).message).toBe(SEND_UPLOAD_DROPPED_SENTENCE);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect({ status: row!.status, retryRefusal: row!.retryRefusal }).toEqual({ status: "failed", retryRefusal: "send_upload_dropped" });
    expect((await db.select().from(drafts).where(eq(drafts.id, draftId)))[0]!.status).toBe("draft");
    const replay = await svc.send(ctx, draftId, "slow-3", { openSendAdapter: smtp.factory }).then((r) => r, (e: unknown) => e);
    expect(replay).toMatchObject({ code: "send_upload_dropped" });
    expect(smtp.state.delivered).toBe(0);
  });

  it("over the real adapter, a photo on a slow link dropped half-way is `send_upload_dropped`, the draft a draft again", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const smtp = await slowLinkSmtp(2_000_000, 450_000);
    const photo = { filename: "photo.jpg", contentType: "image/jpeg", content: Buffer.alloc(684 * 1024, 7) };
    const out = await svc.send(ctx, draftId, "slow-5", { openSendAdapter: smtp.factory }, { attachments: [photo] })
      .then((r) => r, (e: unknown) => e);
    smtp.close();
    expect(out).toMatchObject({ code: "send_upload_dropped" });
    expect(smtp.seen.mark, "the server never received the end of the message").toBe(false);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect({ status: row!.status, draft: (await db.select().from(drafts).where(eq(drafts.id, draftId)))[0]!.status })
      .toEqual({ status: "failed", draft: "draft" });
  });

  it("an unanswered 250 on a dead connection is probed on a fresh one; unreachable there, it stays `pending` (`queued`)", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const smtp = slowSmtp({ lostReply: true, reopenUnreachable: true });
    const res = await svc.send(ctx, draftId, "slow-4", { openSendAdapter: smtp.factory });
    expect(res.status).toBe("queued");
    expect(smtp.state.probes, "the dead connection's \"not there\" is never asked").toBe(0);
    expect(smtp.state.dials).toBe(2);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect({ status: row!.status, offerState: row!.offerState }).toEqual({ status: "pending", offerState: "complete" });
  });
});

/**
 * SEND AGAIN: the held attempt goes again under its own Message-ID and content claim, Sent checked
 * first, one row per press. A mail server double: what it took, what its Sent folder holds, and how
 * the next submission and the next look end.
 */
function heldServer() {
  const s = {
    sentFolder: [] as string[], taken: [] as OutboundMessage[], dials: 0, looks: 0,
    submit: "ok" as "ok" | "lost" | "drop" | "hold", look: "answer" as "answer" | "hang", dial: "ok" as "ok" | "refused",
  };
  let hold: () => void = () => undefined;
  const factory: OpenSendAdapter = async () => {
    s.dials += 1;
    if (s.dial === "refused") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return {
      async send(msg: OutboundMessage, opts?: SendOptions) {
        if (s.submit === "drop") throw new SendNotSubmitted("data", Object.assign(new Error("closed"), { code: "ECONNECTION" }));
        if (s.submit === "hold") await new Promise<void>((r) => { hold = r; });
        await opts?.beforeRelease?.();
        s.taken.push(msg);
        // Taken, and the answer lost on the way back.
        if (s.submit === "lost") throw Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent(id: string) {
        s.looks += 1;
        if (s.look === "hang") return new Promise<boolean>(() => undefined);
        return s.sentFolder.includes(id);
      },
      async close() { /* nothing held */ },
    };
  };
  return { s, factory, release: () => hold() };
}

const PHOTO = { filename: "photo.jpg", contentType: "image/jpeg", content: Buffer.alloc(684 * 1024, 7) };

/** A photo letter the server took and whose answer was lost: held `unverified`, nothing in Sent. */
async function heldLetter() {
  const w = await setup();
  const draftId = await w.newDraft();
  const mail = heldServer();
  mail.s.submit = "lost";
  const first = await svc.send(w.ctx, draftId, "first", { openSendAdapter: mail.factory }, { attachments: [PHOTO] });
  expect(first.status).toBe("unverified");
  const rows = async () => w.db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
  const held = (await rows())[0]!;
  const draft = async () => (await w.db.select().from(drafts).where(eq(drafts.id, draftId)))[0]!;
  const again = (key: string, input: Record<string, unknown> = { attachments: [PHOTO] }, more: Record<string, unknown> = {}) =>
    svc.send(w.ctx, draftId, key, { openSendAdapter: mail.factory, ...more } as never, { again: true, ...input } as never)
      .then((r) => r, (e: unknown) => e);
  return { ...w, draftId, mail, held, rows, draft, again };
}

describe("Send again: the held message, once, under its own Message-ID", () => {
  it("found in Sent on the press's own look: nothing is submitted and the press says the earlier send", async () => {
    const h = await heldLetter();
    h.mail.s.sentFolder.push(h.held.mintedMessageId);
    h.mail.s.submit = "ok";
    const out = await h.again("again-1") as { status: string; firstSend?: unknown };
    expect(out).toMatchObject({ status: "sent", firstSend: { status: "sent" } });
    expect(h.mail.s.taken, "only the first press was taken").toHaveLength(1);
    const rows = await h.rows();
    expect(rows.map((r) => [r.idempotencyKey, r.status, r.resolvedBy]).sort()).toEqual([
      ["again-1", "sent", "sent_folder"], ["first", "unverified", "resent"],
    ]);
    expect((await h.draft()).status).toBe("sent");
    expect(await h.again("again-1"), "its replay still says the earlier send").toMatchObject({ firstSend: { status: "sent" } });
    const fresh = await svc.send(h.ctx, h.draftId, "fresh", { openSendAdapter: h.mail.factory }).then((r) => r, (e: unknown) => e);
    expect(fresh, "an ordinary fresh-key press is still refused").toMatchObject({ httpStatus: 409 });
  });

  it("found in the mirror: answered without a dial", async () => {
    const h = await heldLetter();
    const dials = h.mail.s.dials;
    await h.db.insert(messages).values({
      accountId: h.A, mailboxId: h.mailboxId, messageIdHeader: h.held.mintedMessageId.replace(/[<>]/g, ""),
      bodyHash: randomUUID(), dedupKey: randomUUID(), subject: "Re: hi", fromAddress: "mila@lichtgrat.example",
      snippet: "Thanks!", nativeLocator: { folder: "Sent", ref: "1:9" },
    });
    expect(await h.again("again-m")).toMatchObject({ status: "sent", firstSend: { status: "sent" } });
    expect(h.mail.s.dials, "no dial").toBe(dials);
    expect(h.mail.s.taken).toHaveLength(1);
  });

  it("not in Sent: exactly one submission, with the held Message-ID and the photo", async () => {
    const h = await heldLetter();
    h.mail.s.submit = "ok";
    const went = await h.again("again-2") as { status: string; firstSend?: unknown };
    expect(went).toMatchObject({ status: "sent" });
    expect(went.firstSend, "this press sent it").toBeUndefined();
    expect(h.mail.s.taken).toHaveLength(2);
    expect(h.mail.s.taken[1]!.messageId, "the same message, not a new one").toBe(h.held.mintedMessageId);
    expect(h.mail.s.taken[1]!.attachments?.map((a) => [a.filename, a.content.byteLength])).toEqual([["photo.jpg", 684 * 1024]]);
    expect(h.mail.s.looks, "Sent was looked in before it went").toBe(2);
    expect((await h.draft()).status).toBe("sent");
    const replay = await h.again("again-2") as { status: string; firstSend?: unknown };
    expect(replay, "its key answers its replay").toMatchObject({ status: "sent" });
    expect(replay.firstSend, "the replay of the press that sent it never says nothing went").toBeUndefined();
    expect(h.mail.s.taken).toHaveLength(2);
  });

  it("a Send later held unverified goes again with its own Message-ID", async () => {
    const w = await setup();
    // As the schedule pass leaves it: a draft again, its appointment and key standing.
    const [d] = await w.db.insert(drafts).values({
      accountId: w.A, mailboxId: w.mailboxId, subject: "later", body: "words", to: [{ name: null, address: "you@example.com" }],
      status: "draft", sendAt: new Date(NOW.getTime() - 60_000), sendKey: "sched-key",
    }).returning();
    const mail = heldServer();
    mail.s.submit = "lost";
    expect((await svc.send(w.ctx, d!.id, "sched-key", { openSendAdapter: mail.factory })).status).toBe("unverified");
    mail.s.submit = "ok";
    expect(await svc.send(w.ctx, d!.id, "again-s", { openSendAdapter: mail.factory }, { again: true }).then((r) => r, (e: unknown) => e))
      .toMatchObject({ status: "sent" });
    expect(mail.s.taken.map((m) => m.messageId)).toEqual([mail.s.taken[0]!.messageId, mail.s.taken[0]!.messageId]);
  });

  it("other files are refused, and nothing is written", async () => {
    const h = await heldLetter();
    const dials = h.mail.s.dials;
    expect(await h.again("again-3", {})).toMatchObject({ code: "send_again_changed", httpStatus: 409, retryable: false });
    const rows = await h.rows();
    expect(rows.map((r) => [r.idempotencyKey, r.status, r.resolvedBy])).toEqual([["first", "unverified", null]]);
    expect({ draft: (await h.draft()).status, dials: h.mail.s.dials }).toEqual({ draft: "unverified", dials });
  });

  it("a replay of an unconfirmed Send again submits nothing more", async () => {
    const h = await heldLetter();
    expect(await h.again("again-4")).toMatchObject({ status: "unverified" });
    expect(h.mail.s.taken).toHaveLength(2);
    expect(await h.again("again-4")).toMatchObject({ status: "unverified" });
    expect(await svc.send(h.ctx, h.draftId, "first", { openSendAdapter: h.mail.factory }).then((r) => r, (e: unknown) => e))
      .toMatchObject({ status: "unverified" });
    expect(h.mail.s.taken, "no replay sends").toHaveLength(2);
    expect(h.mail.s.taken.map((m) => m.messageId)).toEqual([h.held.mintedMessageId, h.held.mintedMessageId]);
  });

  it("a second key while one runs is refused as in flight, never retryable", async () => {
    const h = await heldLetter();
    h.mail.s.submit = "hold";
    const running = h.again("again-5", { attachments: [PHOTO] }, { attemptCeilingMs: 60_000 });
    for (let i = 0; i < 200 && (await h.draft()).status !== "sending"; i += 1) await new Promise((r) => { setTimeout(r, 5); });
    expect(await h.again("again-6")).toMatchObject({ code: "send_again_in_flight", retryable: false });
    h.mail.release();
    expect(await running).toMatchObject({ status: "sent" });
    expect(h.mail.s.taken).toHaveLength(2);
  });

  it("a refused dial, a dropped upload or a look that never answers holds it again, never re-armed", async () => {
    const h = await heldLetter();
    h.mail.s.dial = "refused";
    expect(await h.again("again-7", { attachments: [PHOTO] }, { rearmTransient: true }))
      .toMatchObject({ code: "send_unreachable", retryable: false });
    h.mail.s.dial = "ok";
    h.mail.s.submit = "drop";
    expect(await h.again("again-8")).toMatchObject({ code: "send_upload_dropped", retryable: false });
    h.mail.s.look = "hang";
    expect(await h.again("again-9", { attachments: [PHOTO] }, { attemptCeilingMs: 50 }))
      .toMatchObject({ code: "send_again_unchecked", httpStatus: 424, retryable: false });
    const rows = (await h.rows()).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    expect(rows.map((r) => [r.idempotencyKey, r.status, r.retryUntil, r.resolvedBy, r.mintedMessageId === h.held.mintedMessageId])).toEqual([
      ["again-7", "unverified", null, "resent", true], ["again-8", "unverified", null, "resent", true],
      ["again-9", "unverified", null, null, true], ["first", "unverified", null, "resent", true],
    ]);
    expect((await h.draft()).status).toBe("unverified");
    expect(h.mail.s.taken).toHaveLength(1);
  });
});
