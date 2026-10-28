import { describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { Duplex } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends, outboundSentCopies, messages, threads } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendNotSubmitted, SentCopyAppendFailed, UNMETERED_STORAGE_CAP, type SendOptions, type StorageCap } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import {
  SendService, SEND_COPY_OWED_MAX_ATTEMPTS, SEND_COPY_OWED_WAITS_MS, SEND_STALE_AFTER_MS, SEND_UPLOAD_DROPPED_SENTENCE,
  OWED_COPY_CLOUD, OWED_COPY_SELF_HOST, SEND_COPY_OWED_DEFER_MS, SEND_COPY_OWED_HOLD_MS, SEND_COPY_OWED_SETTLE_MS,
  runOwedSentCopyPass,
} from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { SENT_COPY_MAILBOX_WAITS_MS, SENT_COPY_TURN_MAX, SENT_COPY_TURN_UNIT } from "../src/sent-copy-pass.js";

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
function slowSmtp(o: {
  copyDiesOnFirst?: boolean; dropMidUpload?: boolean; lostReply?: boolean; reopenUnreachable?: boolean; bodyBytes?: number;
  /** The first connection's APPEND never answers: before it lands, or after. */
  appendHangs?: "before" | "after";
} = {}) {
  const sentFolder: string[] = [];
  const state = { dials: 0, released: 0, delivered: 0, looks: [] as boolean[], probes: 0, raws: [] as Buffer[], filed: [] as Buffer[], forceCloses: 0 };
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
        // The padding is incompressible, like an attachment: the store's size readings depend on it.
        const pad = randomBytes(Math.ceil(((o.bodyBytes ?? 0) * 3) / 4)).toString("base64").slice(0, o.bodyBytes ?? 0);
        const raw = Buffer.from(`Message-ID: ${msg.messageId!}\r\nTo: you@example.com\r\nSubject: Re: hi\r\n\r\nThanks!\r\n${pad}`);
        state.raws.push(raw);
        return opts?.copy === "caller" ? { providerMessageId: msg.messageId!, unfiledCopy: raw } : { providerMessageId: msg.messageId! };
      },
      async fileSentCopy(raw: Buffer, id: string, look?: { look?: boolean }) {
        if (!live) throw dead();
        state.looks.push(look?.look === true);
        if (look?.look === true && sentFolder.includes(id)) return null;
        if (n === 1 && o.appendHangs === "before") return new Promise<never>(() => undefined);
        sentFolder.push(id);
        state.filed.push(raw);
        if (n === 1 && o.appendHangs === "after") return new Promise<never>(() => undefined);
        return { locator: { folder: "Sent", ref: `9:${sentFolder.length}` }, raw };
      },
      // The old adapter's answer on a dead connection: "not there".
      async messageInSent(id: string) { state.probes += 1; if (!live && n > 1) throw dead(); return live && sentFolder.includes(id); },
      isLive: () => live,
      async close() { live = false; },
      forceClose() { state.forceCloses += 1; live = false; },
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
 * THE OWED COPY ON DISK: a delivered send whose copy cannot land is recorded, answered `pending`,
 * and filed once by the late pass of a later engine (a new `SendService` stands in for the restart).
 */
describe("a delivered send's Sent copy, owed on disk until it is filed", () => {
  const cap = async (): Promise<StorageCap> => UNMETERED_STORAGE_CAP;
  const owedRows = async (db: Awaited<ReturnType<typeof setup>>["db"]) => db.select().from(outboundSentCopies);
  /** Delivered, its copy dead on the lease and the re-dial refused: answered, the copy owed. */
  async function owedSend(
    more: Record<string, unknown> = { keepOwedCopy: true, copyOutlivesAnswer: true }, bodyBytes = 0,
    mail: Parameters<typeof slowSmtp>[0] = {}, input: Record<string, unknown> = {},
  ) {
    const w = await setup();
    const draftId = await w.newDraft();
    const opts = { copyDiesOnFirst: true, reopenUnreachable: true, bodyBytes, ...mail };
    const smtp = slowSmtp(opts);
    const sentAt = Date.now();
    const res = await svc.send(w.ctx, draftId, `owed-${randomUUID()}`, {
      openSendAdapter: smtp.factory, resolveStorageCap: cap, copyTiming: { graceMs: 2_000, deadlineMs: 2_000, waitsMs: [0] }, ...more,
    }, input as never);
    const forceClosedBy = smtp.state.forceCloses;
    return { ...w, draftId, smtp, res, sentAt, forceClosedBy, reachable: () => { opts.reopenUnreachable = false; } };
  }
  /** The server's late pass, as a restarted host runs it (a new `SendService`). */
  const serverPass = (o: Awaited<ReturnType<typeof owedSend>>, more: Partial<Parameters<typeof runOwedSentCopyPass>[1]> = {}) =>
    runOwedSentCopyPass(o.db, { openSendAdapter: o.smtp.factory, resolveStorageCap: cap, sends: new SendService(), now: () => NOW, ...more });
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  /** Cloud's clock: the next poke is armed five minutes and its jitter after the last one started. */
  const POKE_MS = 5 * MIN + 15_000;
  /** The first `steps` waits of a mailbox's ladder (its last repeats), each with the poke after it. */
  const ladderSteps = (steps: number): number => Array.from({ length: steps }, (_, i) =>
    SENT_COPY_MAILBOX_WAITS_MS[Math.min(i, SENT_COPY_MAILBOX_WAITS_MS.length - 1)]! + POKE_MS).reduce((s, ms) => s + ms, 0);
  /** A NO as imapflow raises it: the response code on the error, not only in its text. */
  const refusedWith = (code: string): Error =>
    Object.assign(new Error(`NO [${code}] refused`), { responseStatus: "NO", serverResponseCode: code });
  /** An owed copy as a send door leaves it: `sent`, recorded `i` seconds after NOW, due at NOW (or `due`). */
  const oweRow = async (
    w: Awaited<ReturnType<typeof setup>>, i: number, o: { due?: number; accountId?: string; mailboxId?: string } = {},
  ): Promise<string> => {
    const id = `<${randomUUID()}@lichtgrat.example>`;
    const accountId = o.accountId ?? w.A;
    const [s] = await w.db.insert(outboundSends).values({
      accountId, idempotencyKey: `owed-${randomUUID()}`, mintedMessageId: id, providerMessageId: id, status: "sent",
    }).returning();
    await w.db.insert(outboundSentCopies).values({
      sendId: s!.id, accountId, mailboxId: o.mailboxId ?? w.mailboxId, nextAttemptAt: new Date(o.due ?? NOW.getTime()),
      createdAt: new Date(NOW.getTime() + i * 1000), rawB64: Buffer.from(`Message-ID: ${id}\r\n\r\nThanks\r\n`).toString("base64"),
    });
    return id;
  };
  /**
   * The server's pokes from `clock.at`: one {@link POKE_MS} after the last started, or when the next owed row or
   * letter is due, whichever is later (`cadence`: the first of Cloud's pokes, every {@link POKE_MS}, at or after
   * it). A letter (`letters`, its time) is recorded owed when its time comes, due a minute later as Cloud's door
   * leaves it, its id added to `recorded` then. Until nothing is owed and no letter is left, or past `until`.
   */
  const pokeUntilFiled = async (
    w: Awaited<ReturnType<typeof setup>>, open: OpenSendAdapter, clock: { at: number },
    more: Partial<Parameters<typeof runOwedSentCopyPass>[1]> = {},
    o: { letters?: number[]; until?: number; cadence?: boolean; recorded?: string[] } = {},
  ) => {
    const sum = { passes: 0, gaveUp: 0, dropped: 0, letters: o.recorded ?? [] };
    const letters = [...(o.letters ?? [])];
    while (sum.passes < 2_000) {
      while (letters.length > 0 && letters[0]! <= clock.at) {
        const at = letters.shift()!;
        sum.letters.push(await oweRow(w, (at - NOW.getTime()) / 1000, { due: at + MIN }));
      }
      const started = clock.at;
      const r = await runOwedSentCopyPass(w.db, {
        openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => new Date(clock.at), ...more,
      });
      sum.passes += 1;
      sum.gaveUp += r.gaveUp;
      sum.dropped += r.dropped;
      const due = (await owedRows(w.db)).filter((row) => row.seq === 0).map((row) => row.nextAttemptAt.getTime());
      if (due.length === 0 && letters.length === 0) break;
      const next = Math.min(...due, letters[0] ?? Infinity);
      clock.at = o.cadence === true
        ? started + POKE_MS * Math.max(1, Math.ceil((next - started) / POKE_MS))
        : Math.max(started + POKE_MS, next);
      if (o.until !== undefined && clock.at > o.until) break;
    }
    return sum;
  };

  it("is answered `pending`, and a later engine files it once with the delivered bytes, projected", async () => {
    const o = await owedSend();
    expect({ status: o.res.status, sentCopy: o.res.sentCopy }).toEqual({ status: "sent", sentCopy: "pending" });
    expect(await owedRows(o.db)).toHaveLength(1);
    o.reachable();
    const out = await new SendService().fileOwedCopies(o.ctx, o.mailboxId, { openSendAdapter: o.smtp.factory, resolveStorageCap: cap });
    expect(out).toEqual({ filed: 1, dropped: 0, failed: 0 });
    expect(o.smtp.state.looks, "the late filing looks in Sent first").toEqual([true]);
    expect(o.smtp.sentFolder).toEqual([o.res.providerMessageId]);
    expect(o.smtp.state.filed[0]!.equals(o.smtp.state.raws[0]!), "the filed bytes are the delivered bytes").toBe(true);
    expect(o.smtp.state.released, "the pass never submits").toBe(1);
    const mirrored = await o.db.select({ id: messages.id }).from(messages)
      .where(eq(messages.messageIdHeader, o.res.providerMessageId!.replace(/[<>]/g, "")));
    expect(mirrored, "the copy is projected").toHaveLength(1);
    expect(await owedRows(o.db)).toEqual([]);
    const again = await new SendService().fileOwedCopies(o.ctx, o.mailboxId, { openSendAdapter: o.smtp.factory, resolveStorageCap: cap });
    expect({ again, dials: o.smtp.state.dials, folder: o.smtp.sentFolder.length }).toEqual({ again: { filed: 0, dropped: 0, failed: 0 }, dials: 3, folder: 1 });
  });

  it("a 14 MB message's copy is kept and filed byte for byte (the desktop store refuses one 17 MB value)", async () => {
    const o = await owedSend(undefined, 14 * 1024 * 1024);
    expect(o.res.sentCopy).toBe("pending");
    o.reachable();
    const out = await new SendService().fileOwedCopies(o.ctx, o.mailboxId, { openSendAdapter: o.smtp.factory, resolveStorageCap: cap });
    expect(out.filed).toBe(1);
    expect(o.smtp.state.filed[0]!.equals(o.smtp.state.raws[0]!), "the filed bytes are the delivered bytes").toBe(true);
    expect(await o.db.select({ id: outboundSentCopies.sendId }).from(outboundSentCopies)).toEqual([]);
  }, 60_000);

  it("a copy whose APPEND landed before the engine went is found in Sent, and nothing is appended", async () => {
    const o = await owedSend();
    o.smtp.sentFolder.push(o.res.providerMessageId!);
    o.reachable();
    const out = await new SendService().fileOwedCopies(o.ctx, o.mailboxId, { openSendAdapter: o.smtp.factory, resolveStorageCap: cap });
    expect(out.filed).toBe(1);
    expect(o.smtp.sentFolder, "a second copy").toEqual([o.res.providerMessageId]);
    expect(await owedRows(o.db)).toEqual([]);
  });

  it("a copy still in its in-memory back-off is left to it: one copy in the end", async () => {
    const w = await setup();
    const draftId = await w.newDraft();
    const opts = { copyDiesOnFirst: true, reopenUnreachable: true };
    const smtp = slowSmtp(opts);
    const res = await svc.send(w.ctx, draftId, "owed-backoff", {
      openSendAdapter: smtp.factory, resolveStorageCap: cap, keepOwedCopy: true, copyOutlivesAnswer: true,
      copyTiming: { graceMs: 0, deadlineMs: 0, waitsMs: [0, 300] },
    });
    expect(res.sentCopy).toBe("pending");
    for (let i = 0; i < 100 && (smtp.state.dials < 2 || (await owedRows(w.db)).length === 0); i += 1) await new Promise((r) => { setTimeout(r, 5); });
    opts.reopenUnreachable = false;
    const out = await svc.fileOwedCopies(w.ctx, w.mailboxId, { openSendAdapter: smtp.factory, resolveStorageCap: cap });
    expect(out, "the pass took a copy this process is filing").toEqual({ filed: 0, dropped: 0, failed: 0 });
    for (let i = 0; i < 100 && smtp.sentFolder.length === 0; i += 1) await new Promise((r) => { setTimeout(r, 10); });
    expect(smtp.sentFolder).toEqual([res.providerMessageId]);
    for (let i = 0; i < 100 && (await owedRows(w.db)).length > 0; i += 1) await new Promise((r) => { setTimeout(r, 10); });
    expect(await owedRows(w.db)).toEqual([]);
  });

  it("files nothing for a send no longer recorded `sent`, or gone, and drops the row", async () => {
    const o = await owedSend();
    o.reachable();
    await o.db.update(outboundSends).set({ status: "unverified" }).where(eq(outboundSends.draftId, o.draftId));
    const out = await new SendService().fileOwedCopies(o.ctx, o.mailboxId, { openSendAdapter: o.smtp.factory, resolveStorageCap: cap });
    expect({ out, folder: o.smtp.sentFolder, rows: await owedRows(o.db) }).toEqual({ out: { filed: 0, dropped: 1, failed: 0 }, folder: [], rows: [] });
    const p = await owedSend();
    p.reachable();
    await p.db.delete(outboundSends).where(eq(outboundSends.draftId, p.draftId));
    await new SendService().fileOwedCopies(p.ctx, p.mailboxId, { openSendAdapter: p.smtp.factory, resolveStorageCap: cap });
    expect({ folder: p.smtp.sentFolder, rows: await owedRows(p.db) }).toEqual({ folder: [], rows: [] });
  });

  it("a refusing server: each failure waits its turn, a failed dial costs nothing, and the eighth gives up", async () => {
    const o = await owedSend();
    let clock = NOW.getTime();
    const ctx = { ...o.ctx, now: () => new Date(clock) };
    const tries = { dials: 0, files: 0, sends: 0, dial: "ok" as "ok" | "refused" };
    const refusing: OpenSendAdapter = async () => {
      tries.dials += 1;
      if (tries.dial === "refused") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return {
        async send() { tries.sends += 1; return { providerMessageId: "x" }; },
        async fileSentCopy() { tries.files += 1; throw new Error("NO [OVERQUOTA] mailbox full"); },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      };
    };
    const pass = () => new SendService().fileOwedCopies(ctx, o.mailboxId, { openSendAdapter: refusing, resolveStorageCap: cap });
    tries.dial = "refused";
    expect(await pass()).toEqual({ filed: 0, dropped: 0, failed: 0 });
    expect((await owedRows(o.db))[0]!.attempts, "a failed dial is no attempt").toBe(0);
    tries.dial = "ok";
    for (let n = 1; n < SEND_COPY_OWED_MAX_ATTEMPTS; n += 1) {
      expect(await pass()).toEqual({ filed: 0, dropped: 0, failed: 1 });
      const [row] = await owedRows(o.db);
      const wait = SEND_COPY_OWED_WAITS_MS[Math.min(n, SEND_COPY_OWED_WAITS_MS.length) - 1]!;
      expect({ attempts: row!.attempts, next: row!.nextAttemptAt.getTime() }).toEqual({ attempts: n, next: clock + wait });
      clock += wait - 1;
      expect(await pass(), "retried before its time").toEqual({ filed: 0, dropped: 0, failed: 0 });
      clock += 1;
    }
    expect(await pass()).toEqual({ filed: 0, dropped: 0, failed: 1 });
    expect(await owedRows(o.db), "given up at the eighth failure").toEqual([]);
    expect({ files: tries.files, sends: tries.sends }).toEqual({ files: SEND_COPY_OWED_MAX_ATTEMPTS, sends: 0 });
  });

  it("deps that keep no owed copy record nothing and a copy that cannot land is `missing`", async () => {
    const o = await owedSend({});
    expect({ status: o.res.status, sentCopy: o.res.sentCopy }).toEqual({ status: "sent", sentCopy: "missing" });
    expect(await owedRows(o.db)).toEqual([]);
  });

  it("self-host: a restart between the accept and the APPEND, then the server's pass files it once", async () => {
    const o = await owedSend({ keepOwedCopy: OWED_COPY_SELF_HOST, copyOutlivesAnswer: true });
    expect({ status: o.res.status, sentCopy: o.res.sentCopy }).toEqual({ status: "sent", sentCopy: "pending" });
    const rows = await owedRows(o.db);
    expect(rows.map((r) => ({ seq: r.seq, due: r.nextAttemptAt.getTime() }))).toEqual([{ seq: 0, due: NOW.getTime() }]);
    o.reachable();
    const out = await serverPass(o);
    expect(out).toEqual({ claimed: 1, filed: 1, dropped: 0, failed: 0, onLadder: 0, deferred: 0, gaveUp: 0, remaining: 0 });
    expect(o.smtp.state.looks.at(-1), "it looks in Sent first").toBe(true);
    expect(o.smtp.sentFolder).toEqual([o.res.providerMessageId]);
    expect(o.smtp.state.filed[0]!.equals(o.smtp.state.raws[0]!), "the delivered bytes").toBe(true);
    expect(o.smtp.state.released, "the pass never submits").toBe(1);
    const mirrored = await o.db.select({ id: messages.id }).from(messages)
      .where(eq(messages.messageIdHeader, o.res.providerMessageId!.replace(/[<>]/g, "")));
    expect(mirrored, "projected once").toHaveLength(1);
    expect(await owedRows(o.db)).toEqual([]);
    const dials = o.smtp.state.dials;
    expect((await serverPass(o)).claimed).toBe(0);
    expect(o.smtp.state.dials, "a second pass does not dial").toBe(dials);
  });

  it("Cloud: a hung APPEND is abandoned at the deadline, and a new instance files it once a minute later", async () => {
    const o = await owedSend({ keepOwedCopy: OWED_COPY_CLOUD, copyTiming: { graceMs: 200, deadlineMs: 200, waitsMs: [0] } }, 0,
      { copyDiesOnFirst: false, appendHangs: "before" });
    expect({ status: o.res.status, sentCopy: o.res.sentCopy }).toEqual({ status: "sent", sentCopy: "pending" });
    expect(o.forceClosedBy, "the hung APPEND's connection is torn down before the answer").toBe(1);
    expect(Date.now() - o.sentAt, "answered by the deadline").toBeLessThan(2_000);
    const due = NOW.getTime() + 200 + SEND_COPY_OWED_SETTLE_MS;
    expect((await owedRows(o.db)).map((r) => r.nextAttemptAt.getTime())).toEqual([due]);
    o.reachable();
    const early = await serverPass(o, { now: () => new Date(due - 1) });
    expect({ claimed: early.claimed, dials: o.smtp.state.dials }).toEqual({ claimed: 0, dials: 1 });
    const out = await serverPass(o, { now: () => new Date(due) });
    expect({ filed: out.filed, folder: o.smtp.sentFolder }).toEqual({ filed: 1, folder: [o.res.providerMessageId] });
    expect(await owedRows(o.db)).toEqual([]);
  });

  it("Cloud: an APPEND that landed before it was abandoned is found in Sent, and nothing is appended", async () => {
    const o = await owedSend({ keepOwedCopy: OWED_COPY_CLOUD, copyTiming: { graceMs: 200, deadlineMs: 200, waitsMs: [0] } }, 0,
      { copyDiesOnFirst: false, appendHangs: "after" });
    expect(o.res.sentCopy).toBe("pending");
    o.reachable();
    const out = await serverPass(o, { now: () => new Date(NOW.getTime() + 200 + SEND_COPY_OWED_SETTLE_MS) });
    expect({ filed: out.filed, appended: o.smtp.state.filed.length, folder: o.smtp.sentFolder.length }).toEqual({ filed: 1, appended: 1, folder: 1 });
    expect(await owedRows(o.db)).toEqual([]);
  });

  it("Cloud: a letter with a photo writes no row, and a copy that cannot land is `missing`", async () => {
    const photo = { filename: "photo.jpg", contentType: "image/jpeg", content: Buffer.alloc(1024, 7) };
    const o = await owedSend({ keepOwedCopy: OWED_COPY_CLOUD }, 0, {}, { attachments: [photo] });
    expect({ status: o.res.status, sentCopy: o.res.sentCopy }).toEqual({ status: "sent", sentCopy: "missing" });
    expect(await owedRows(o.db)).toEqual([]);
    const plain = await owedSend({ keepOwedCopy: OWED_COPY_CLOUD });
    expect({ sentCopy: plain.res.sentCopy, rows: (await owedRows(plain.db)).length }).toEqual({ sentCopy: "pending", rows: 1 });
  });

  it("the server's pass drops past the hold or on a disabled mailbox, and dials no `error`, stamped, parked or unsent row", async () => {
    const policy = { keepOwedCopy: OWED_COPY_SELF_HOST, copyOutlivesAnswer: true };
    const old = await owedSend(policy);
    await old.db.update(outboundSentCopies).set({ createdAt: new Date(NOW.getTime() - SEND_COPY_OWED_HOLD_MS - 1) });
    const disabled = await owedSend(policy);
    await disabled.db.update(mailboxes).set({ status: "disabled" });
    for (const o of [old, disabled]) {
      o.reachable();
      expect(await serverPass(o)).toMatchObject({ dropped: 1, filed: 0, remaining: 0 });
      expect({ dials: o.smtp.state.dials, folder: o.smtp.sentFolder }).toEqual({ dials: 2, folder: [] });
    }
    const failing = await owedSend(policy);
    await failing.db.update(mailboxes).set({ status: "error" });
    const stamped = await owedSend(policy);
    await stamped.db.update(mailboxes).set({ erasedAt: NOW });
    for (const o of [failing, stamped]) {
      o.reachable();
      expect(await serverPass(o)).toMatchObject({ claimed: 0, dropped: 0, remaining: 1 });
      expect(o.smtp.state.dials).toBe(2);
    }
    const parked = await owedSend(policy);
    parked.reachable();
    expect(await serverPass(parked, { accountEligible: async () => false })).toMatchObject({ claimed: 1, deferred: 1, filed: 0 });
    expect({ dials: parked.smtp.state.dials, due: (await owedRows(parked.db))[0]!.nextAttemptAt.getTime() })
      .toEqual({ dials: 2, due: NOW.getTime() + SEND_COPY_OWED_DEFER_MS });
    const unsent = await owedSend(policy);
    unsent.reachable();
    await unsent.db.update(outboundSends).set({ status: "unverified" }).where(eq(outboundSends.draftId, unsent.draftId));
    expect(await serverPass(unsent)).toMatchObject({ claimed: 1, dropped: 1, filed: 0, remaining: 0 });
    expect({ dials: unsent.smtp.state.dials, folder: unsent.smtp.sentFolder }).toEqual({ dials: 2, folder: [] });
  });

  it("the server's pass gives a copy the server refuses for itself (TOOBIG) up at its eighth refusal, its own wait between", async () => {
    const o = await owedSend({ keepOwedCopy: OWED_COPY_SELF_HOST, copyOutlivesAnswer: true });
    let clock = NOW.getTime();
    let files = 0;
    const tooBig: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy() { files += 1; throw refusedWith("TOOBIG"); },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    const pass = () => serverPass(o, { openSendAdapter: tooBig, now: () => new Date(clock) });
    for (let n = 1; n < SEND_COPY_OWED_MAX_ATTEMPTS; n += 1) {
      expect(await pass()).toMatchObject({ claimed: 1, failed: 1 });
      const next = (await owedRows(o.db))[0]!.nextAttemptAt.getTime();
      expect(next - clock, `its own wait after refusal ${n}`).toBe(SEND_COPY_OWED_WAITS_MS[Math.min(n, SEND_COPY_OWED_WAITS_MS.length) - 1]);
      clock = next;
    }
    expect(await pass()).toMatchObject({ gaveUp: 1, remaining: 0 });
    expect(files).toBe(SEND_COPY_OWED_MAX_ATTEMPTS);
  });

  it("a lone copy its mailbox refuses spends none of its attempts: it waits 1 min, 10 min, 1 h, 6 h, then a day at a time", async () => {
    const o = await owedSend({ keepOwedCopy: OWED_COPY_SELF_HOST, copyOutlivesAnswer: true });
    let clock = NOW.getTime();
    let files = 0;
    const full: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy() { files += 1; throw refusedWith("OVERQUOTA"); },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    const waits: number[] = [];
    for (let n = 0; n < 10; n += 1) {
      expect(await serverPass(o, { openSendAdapter: full, now: () => new Date(clock) })).toMatchObject({ claimed: 1, failed: 1, gaveUp: 0 });
      const next = (await owedRows(o.db))[0]!.nextAttemptAt.getTime();
      waits.push((next - clock) / MIN);
      clock = next;
    }
    expect(waits, "minutes until the next try").toEqual([1, 10, 60, 360, 1440, 1440, 1440, 1440, 1440, 1440]);
    expect({ files, owed: (await owedRows(o.db)).length }, "ten refusals and the copy is still owed").toEqual({ files: 10, owed: 1 });
  });

  it.each([["its APPEND"], ["its dial"]] as const)(
    "a mailbox refusing %s backs off as one: another account's copy waits one poke, and the mailbox is dialled 4 times in 2 hours",
    async (refused) => {
      const w = await setup();
      const [mbB] = await w.db.insert(mailboxes).values({ accountId: w.B, provider: "imap", address: "jon@lichtgrat.example" }).returning();
      const owe = async (ctx: ServiceContext, mailboxId: string) => {
        const [d] = await w.db.insert(drafts).values({
          accountId: ctx.accountId, mailboxId, subject: "Re: hi", body: `Thanks ${randomUUID()}`, to: [{ name: null, address: "you@example.com" }], status: "draft",
        }).returning();
        const smtp = slowSmtp({ copyDiesOnFirst: true, reopenUnreachable: true });
        const res = await svc.send(ctx, d!.id, `owed-${randomUUID()}`, {
          openSendAdapter: smtp.factory, resolveStorageCap: cap, keepOwedCopy: OWED_COPY_SELF_HOST, copyOutlivesAnswer: true,
          copyTiming: { graceMs: 0, deadlineMs: 0, waitsMs: [0] },
        });
        expect(res.sentCopy).toBe("pending");
      };
      for (let i = 0; i < 9; i += 1) await owe(w.ctx, w.mailboxId);
      await owe(w.ctxB, mbB!.id);
      const seen = { dials: 0, appends: 0, filedB: 0 };
      const open: OpenSendAdapter = async (mailboxId) => {
        const refusing = mailboxId === w.mailboxId;
        if (refusing) seen.dials += 1;
        if (refusing && refused === "its dial") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        return {
          async send() { throw new Error("never"); },
          async fileSentCopy(raw: Buffer) {
            if (refusing) { seen.appends += 1; throw new Error("NO [OVERQUOTA] mailbox full"); }
            seen.filedB += 1;
            return { locator: { folder: "Sent", ref: "9:1" }, raw };
          },
          async messageInSent() { return false; },
          async close() { /* nothing held */ },
        };
      };
      let clock = NOW.getTime();
      const poke = () => runOwedSentCopyPass(w.db, { openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => new Date(clock) });
      await poke();
      clock += POKE_MS;
      await poke();
      expect(seen.filedB, "the other account's copy is filed at the next poke").toBe(1);
      for (let i = 2; i < 24; i += 1) { clock += POKE_MS; await poke(); }
      expect(seen.dials, "two hours of pokes: the ladder's first four steps").toBeLessThanOrEqual(4);
      expect((await owedRows(w.db)).filter((r) => r.seq === 0), "the refused copies are still owed").toHaveLength(9);
    },
  );

  it.each([12, 40, 80])("%i owed copies of a refusing mailbox hold no other account's copy: it is filed at the next poke", async (count) => {
    const w = await setup();
    const [mbB] = await w.db.insert(mailboxes).values({ accountId: w.B, provider: "imap", address: "jon@lichtgrat.example" }).returning();
    for (let i = 0; i < count; i += 1) await oweRow(w, i);
    await oweRow(w, count, { accountId: w.B, mailboxId: mbB!.id });
    const seen = { dialsA: 0, filedBAtPoke: 0 };
    let poke = 0;
    const open: OpenSendAdapter = async (mailboxId) => {
      const refusing = mailboxId === w.mailboxId;
      if (refusing) seen.dialsA += 1;
      return {
        async send() { throw new Error("never"); },
        async fileSentCopy() {
          if (refusing) throw refusedWith("OVERQUOTA");
          seen.filedBAtPoke = poke;
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      };
    };
    for (poke = 1; poke <= 24; poke += 1) {
      await runOwedSentCopyPass(w.db, {
        openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => new Date(NOW.getTime() + (poke - 1) * POKE_MS),
      });
    }
    expect(seen.filedBAtPoke, "the poke that filed the other account's copy").toBe(2);
    expect(seen.dialsA, "two hours of pokes: the ladder's first four steps").toBeLessThanOrEqual(4);
    expect((await owedRows(w.db)).filter((r) => r.seq === 0), "the refused copies are all still owed").toHaveLength(count);
  });

  it.each([1, 3])(
    "%i copies the server refuses for themselves (TOOBIG) hold no other copy: the rest are filed at the first poke, each refused one given up at its eighth refusal",
    async (refused) => {
      const w = await setup();
      const ids: string[] = [];
      for (let i = 0; i < refused + 4; i += 1) ids.push(await oweRow(w, i));
      const clock = { at: NOW.getTime() };
      const filedAt = new Map<string, number>();
      const tries = new Map<string, number>();
      const open: OpenSendAdapter = async () => ({
        async send() { throw new Error("never"); },
        async fileSentCopy(_raw: Buffer, id: string) {
          if (ids.indexOf(id) < refused) {
            tries.set(id, (tries.get(id) ?? 0) + 1);
            throw refusedWith("TOOBIG");
          }
          filedAt.set(id, clock.at);
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      });
      const sum = await pokeUntilFiled(w, open, clock);
      expect(ids.slice(refused).map((id) => filedAt.get(id)), "filed at the first poke").toEqual(ids.slice(refused).map(() => NOW.getTime()));
      expect(ids.slice(0, refused).map((id) => tries.get(id)), "each refused copy is tried 8 times").toEqual(ids.slice(0, refused).map(() => SEND_COPY_OWED_MAX_ATTEMPTS));
      expect({ gaveUp: sum.gaveUp, dropped: sum.dropped }).toEqual({ gaveUp: refused, dropped: 0 });
    },
  );

  it.each([8, 10])(
    "%i copies refused for a reason the server does not name, older than 4 healthy ones: the probe tries the newest first and the 4 are in Sent within the hour",
    async (poisons) => {
      const w = await setup();
      const ids: string[] = [];
      for (let i = 0; i < poisons + 4; i += 1) ids.push(await oweRow(w, i));
      const clock = { at: NOW.getTime() };
      const filedAt = new Map<string, number>();
      const open: OpenSendAdapter = async () => ({
        async send() { throw new Error("never"); },
        async fileSentCopy(_raw: Buffer, id: string) {
          if (ids.indexOf(id) < poisons) throw refusedWith("OVERQUOTA");
          filedAt.set(id, clock.at);
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      });
      await pokeUntilFiled(w, open, clock, {}, { until: NOW.getTime() + 2 * HOUR });
      const after = ids.slice(poisons).map((id) => (filedAt.get(id) ?? Infinity) - NOW.getTime());
      expect(Math.max(...after) / MIN, "minutes until the last healthy copy is in Sent").toBeLessThan(60);
    },
  );

  it.each([["says so", true], ["cannot say so", false]] as const)(
    "a refusal that ends a connection that %s: the probe dials once more, and the 4 healthy copies are filed at the first poke",
    async (_label, saysSo) => {
      const w = await setup();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await oweRow(w, i));
      const seen = { dials: 0, filed: 0 };
      const open: OpenSendAdapter = async () => {
        seen.dials += 1;
        let alive = true;
        return {
          async send() { throw new Error("never"); },
          async fileSentCopy(_raw: Buffer, id: string) {
            if (!alive) throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
            // The oldest copy is refused, and the server hangs up after saying so.
            if (id === ids[0]) { alive = false; throw refusedWith("LIMIT"); }
            seen.filed += 1;
            return null;
          },
          async messageInSent() { return false; },
          async close() { alive = false; },
          ...(saysSo ? { isLive: () => alive } : {}),
        };
      };
      const r = await runOwedSentCopyPass(w.db, { openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => NOW });
      expect({ filed: r.filed, dials: seen.dials, onLadder: r.onLadder }).toEqual({ filed: 4, dials: 2, onLadder: 0 });
    },
  );

  it("a mailbox refusing every copy for thirty hours backs off as one: 5 dials in its first day, no attempt spent, then each copy filed", async () => {
    const w = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) ids.push(await oweRow(w, i));
    const clock = { at: NOW.getTime() };
    const seen = { dialsFirstDay: 0, filed: [] as string[] };
    const open: OpenSendAdapter = async () => {
      if (clock.at < NOW.getTime() + 24 * HOUR) seen.dialsFirstDay += 1;
      return {
        async send() { throw new Error("never"); },
        async fileSentCopy(_raw: Buffer, id: string) {
          if (clock.at < NOW.getTime() + 30 * HOUR) throw new Error("NO [OVERQUOTA] mailbox full");
          seen.filed.push(id);
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      };
    };
    const sum = await pokeUntilFiled(w, open, clock);
    expect(seen.dialsFirstDay, "the mailbox's ladder, not each copy's").toBeLessThanOrEqual(5);
    expect({ filed: seen.filed.sort(), gaveUp: sum.gaveUp, dropped: sum.dropped }).toEqual({ filed: [...ids].sort(), gaveUp: 0, dropped: 0 });
  });

  it("on Cloud, a whole-mailbox refusal answered 11 s into the pass: the same 5 dials its first day, no attempt spent, each copy filed after", async () => {
    const w = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) ids.push(await oweRow(w, i));
    const clock = { at: NOW.getTime() };
    const seen = { dialsFirstDay: 0, filed: [] as string[] };
    const open: OpenSendAdapter = async () => {
      if (clock.at < NOW.getTime() + 24 * HOUR) seen.dialsFirstDay += 1;
      return {
        async send() { throw new Error("never"); },
        async fileSentCopy(_raw: Buffer, id: string) {
          // Answered past the pass's dial deadline: no other copy can be started to tell whose it is.
          if (clock.at < NOW.getTime() + 30 * HOUR) { clock.at += 11_000; throw refusedWith("OVERQUOTA"); }
          seen.filed.push(id);
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      };
    };
    const sum = await pokeUntilFiled(w, open, clock, { budgetMs: 60_000 });
    expect(seen.dialsFirstDay, "the mailbox's ladder, not each copy's").toBeLessThanOrEqual(5);
    expect({ filed: seen.filed.sort(), gaveUp: sum.gaveUp, dropped: sum.dropped }).toEqual({ filed: [...ids].sort(), gaveUp: 0, dropped: 0 });
  });

  it.each([[1, 11_000], [2, 11_000], [1, 1_000], [2, 1_000]] as const)(
    "on Cloud, over quota 6 days with %i letter(s) a day refused after %i ms: 0 copies deleted, each filed within one ladder step of recovery",
    async (perDay, slowMs) => {
      const w = await setup();
      const healAt = NOW.getTime() + 6 * 24 * HOUR;
      const letters: number[] = [];
      for (let at = NOW.getTime(); at < healAt; at += (24 / perDay) * HOUR) letters.push(at);
      const clock = { at: NOW.getTime() };
      const filedAt = new Map<string, number>();
      const open: OpenSendAdapter = async () => ({
        async send() { throw new Error("never"); },
        async fileSentCopy(_raw: Buffer, id: string) {
          if (clock.at < healAt) { clock.at += slowMs; throw refusedWith("OVERQUOTA"); }
          filedAt.set(id, clock.at);
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      });
      const sum = await pokeUntilFiled(w, open, clock, { budgetMs: 60_000 }, { letters });
      expect({ letters: sum.letters.length, filed: filedAt.size, gaveUp: sum.gaveUp, dropped: sum.dropped })
        .toEqual({ letters: 6 * perDay, filed: 6 * perDay, gaveUp: 0, dropped: 0 });
      expect((Math.max(...filedAt.values()) - healAt) / HOUR, "hours from recovery to the last copy in Sent").toBeLessThanOrEqual(24);
    },
  );

  it("a filed copy starts its mailbox's ladder over: after it, a refusal waits a minute again, not a day", async () => {
    const w = await setup();
    for (let i = 0; i < 3; i += 1) await oweRow(w, i);
    const clock = { at: NOW.getTime() };
    const blipAt = NOW.getTime() + 31 * HOUR;
    let took = false;
    const asked: number[] = [];
    const open: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy() {
        if (asked.at(-1) !== clock.at) asked.push(clock.at);
        // At its first look after `blipAt` the mailbox takes one copy, and is full again.
        if (clock.at >= blipAt && !took) { took = true; return null; }
        throw refusedWith("OVERQUOTA");
      },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    await pokeUntilFiled(w, open, clock, {}, { until: blipAt + 3 * HOUR });
    const after = asked.filter((t) => t >= blipAt);
    expect(took).toBe(true);
    expect((after[2]! - after[0]!) / MIN, "minutes from the filed copy to the second look after it").toBeLessThan(20);
  });

  it("a mailbox refusing every copy past 7 days spends no attempt: each copy's last try comes in its last hour, and it is deleted at 7 days", async () => {
    const w = await setup();
    const ids = [await oweRow(w, 0), await oweRow(w, 2 * 3600)];
    const bounds = ids.map((_, i) => NOW.getTime() + i * 2 * HOUR + SEND_COPY_OWED_HOLD_MS);
    const clock = { at: NOW.getTime() };
    const tries = new Map<string, number[]>();
    const open: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy(_raw: Buffer, id: string) {
        tries.set(id, [...(tries.get(id) ?? []), clock.at]);
        throw refusedWith("OVERQUOTA");
      },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    const sum = await pokeUntilFiled(w, open, clock, {}, { until: bounds[1]! });
    // A poke a minute past the second copy's seventh day, whatever its mailbox's ladder says.
    const last = await runOwedSentCopyPass(w.db, {
      openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => new Date(bounds[1]! + MIN),
    });
    expect({ gaveUp: sum.gaveUp + last.gaveUp, dropped: sum.dropped + last.dropped, owed: (await owedRows(w.db)).length })
      .toEqual({ gaveUp: 0, dropped: 2, owed: 0 });
    const lastTry = ids.map((id, i) => (bounds[i]! - Math.max(...tries.get(id)!)) / MIN);
    expect(lastTry.map((m) => m > 0 && m <= 60), `minutes from each copy's last try to its seventh day: ${lastTry}`).toEqual([true, true]);
  });

  it("on Cloud, a copy the server refuses for itself 11 s into the pass waits alone: the healthy ones are filed within the hour, it is given up at its eighth", async () => {
    const w = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await oweRow(w, i));
    const clock = { at: NOW.getTime() };
    const filedAt = new Map<string, number>();
    const open: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy(_raw: Buffer, id: string) {
        // Refused slowly: past the pass's dial deadline, so no other copy is started after it.
        if (id === ids[0]) { clock.at += 11_000; throw refusedWith("TOOBIG"); }
        filedAt.set(id, clock.at);
        return null;
      },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    const sum = await pokeUntilFiled(w, open, clock, { budgetMs: 60_000 });
    const last = Math.max(...ids.slice(1).map((id) => filedAt.get(id) ?? Infinity));
    expect((last - NOW.getTime()) / MIN, "minutes until the healthy copies are in Sent").toBeLessThan(60);
    expect({ gaveUp: sum.gaveUp, dropped: sum.dropped }).toEqual({ gaveUp: 1, dropped: 0 });
  });

  it.each([
    [1, 4, "owed with it", 1, false],
    // Written after its first refusal, they are due after it: it is tried first once more.
    [1, 4, "written a minute apart after it", 2, true],
    [2, 4, "owed with them", 2, false],
    // More than one claim takes: the copies left out of a claim keep their turn.
    [1, 10, "owed with it", 2, false],
    [2, 7, "owed with them", 3, false],
    [2, 10, "owed with them", 3, false],
    [3, 6, "owed with them", 4, false],
    [5, 4, "owed with them", 6, false],
  ] as const)(
    "on Cloud, the %i oldest copies refused 'NO [LIMIT]' 11 s into the pass, %i healthy ones %s: these are in Sent within %i step(s) of the ladder, and each refused one is kept to its seventh day, never given up",
    async (refusing, healthyCount, _label, steps, later) => {
      const w = await setup();
      const refused: string[] = [];
      for (let i = 0; i < refusing; i += 1) refused.push(await oweRow(w, i));
      const healthy: string[] = [];
      if (!later) for (let k = 1; k <= healthyCount; k += 1) healthy.push(await oweRow(w, k * 20));
      const clock = { at: NOW.getTime() };
      const filedAt = new Map<string, number>();
      const open: OpenSendAdapter = async () => ({
        async send() { throw new Error("never"); },
        async fileSentCopy(_raw: Buffer, id: string) {
          // A code that names no letter, answered past the dial deadline: whose refusal it is cannot be told.
          if (refused.includes(id)) { clock.at += 11_000; throw refusedWith("LIMIT"); }
          filedAt.set(id, clock.at);
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      });
      const letters = later ? Array.from({ length: healthyCount }, (_, k) => NOW.getTime() + (k + 1) * MIN) : [];
      const sum = await pokeUntilFiled(w, open, clock, { budgetMs: 60_000 }, { letters, cadence: true });
      healthy.push(...sum.letters);
      const last = Math.max(...healthy.map((id) => filedAt.get(id) ?? Infinity));
      expect((last - NOW.getTime()) / MIN, "minutes until the healthy copies are in Sent").toBeLessThanOrEqual(ladderSteps(steps) / MIN);
      // Once the mailbox takes one, those the claim left out follow at the next poke: their turn outlasts the ladder's.
      const first = Math.min(...healthy.map((id) => filedAt.get(id)!));
      expect((last - first) / MIN, "minutes from the first healthy copy in Sent to the last").toBeLessThanOrEqual(POKE_MS / MIN);
      expect({ gaveUp: sum.gaveUp, dropped: sum.dropped, owed: (await owedRows(w.db)).length })
        .toEqual({ gaveUp: 0, dropped: refusing, owed: 0 });
    },
  );

  it("on Cloud, an outage piles up 9 letters half an hour apart, then the 2 oldest are refused 'NO [OVERQUOTA]' 11 s into the pass: the 7 others are in Sent within three steps of the ladder, not at the seventh day", async () => {
    const w = await setup();
    const outageEnd = NOW.getTime() + 5 * HOUR;
    const ids: string[] = [];
    const clock = { at: NOW.getTime() };
    const filedAt = new Map<string, number>();
    const open: OpenSendAdapter = async () => {
      if (clock.at < outageEnd) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return {
        async send() { throw new Error("never"); },
        async fileSentCopy(_raw: Buffer, id: string) {
          // The two oldest no longer fit the nearly full mailbox; the server says so slowly and names no letter.
          if (id === ids[0] || id === ids[1]) { clock.at += 11_000; throw refusedWith("OVERQUOTA"); }
          filedAt.set(id, clock.at);
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      };
    };
    const letters = Array.from({ length: 9 }, (_, j) => NOW.getTime() + j * 30 * MIN);
    const sum = await pokeUntilFiled(w, open, clock, { budgetMs: 60_000 }, { letters, cadence: true, recorded: ids });
    const last = Math.max(...ids.slice(2).map((id) => filedAt.get(id) ?? Infinity));
    // The outage climbed the ladder to its day-long step; past it the 2 refused copies take one step each.
    expect((last - outageEnd) / HOUR, "hours from the outage's end to the last healthy copy in Sent").toBeLessThanOrEqual(3 * 24 + 1);
    expect({ gaveUp: sum.gaveUp, dropped: sum.dropped, owed: (await owedRows(w.db)).length }).toEqual({ gaveUp: 0, dropped: 2, owed: 0 });
  });

  it("a mailbox's turns at the column's limit are numbered again: the copy refused goes behind the other, which is filed at the next try", async () => {
    const w = await setup();
    const refused = await oweRow(w, 0);
    const healthy = await oweRow(w, 1);
    // Both on a long run of refusals; the refused copy tried a turn before the healthy one, at the limit.
    const run = 50 * 100;
    await w.db.update(outboundSentCopies).set({ attempts: run + (SENT_COPY_TURN_MAX - 1) * SENT_COPY_TURN_UNIT })
      .where(eq(outboundSentCopies.createdAt, NOW));
    await w.db.update(outboundSentCopies).set({ attempts: run + SENT_COPY_TURN_MAX * SENT_COPY_TURN_UNIT })
      .where(eq(outboundSentCopies.createdAt, new Date(NOW.getTime() + 1000)));
    const clock = { at: NOW.getTime() };
    const filedAt = new Map<string, number>();
    const open: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy(_raw: Buffer, id: string) {
        if (id === refused) { clock.at += 11_000; throw refusedWith("LIMIT"); }
        filedAt.set(id, clock.at);
        return null;
      },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    await pokeUntilFiled(w, open, clock, { budgetMs: 60_000 }, { cadence: true, until: NOW.getTime() + 3 * 24 * HOUR });
    expect(((filedAt.get(healthy) ?? Infinity) - NOW.getTime()) / HOUR, "hours until the healthy copy is in Sent").toBeLessThanOrEqual(25);
  });

  it("a mailbox's wait moves no copy earlier: another pass's lease and a door row's settle stand, and each copy is appended once", async () => {
    const w = await setup();
    const inFlight = await oweRow(w, 0);
    const refused = await oweRow(w, 1, { due: NOW.getTime() + 1_000 });
    // As Cloud's door leaves it: first due after its settle.
    const settling = await oweRow(w, 2, { due: NOW.getTime() + 85_000 });
    const clock = { at: NOW.getTime() };
    const appended: string[] = [];
    const filedAt = new Map<string, number>();
    let reached!: () => void;
    const atAppend = new Promise<void>((r) => { reached = r; });
    let land!: () => void;
    const landed = new Promise<void>((r) => { land = r; });
    let slow = true;
    const open: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy(_raw: Buffer, id: string) {
        if (appended.includes(id)) return null;
        // The first pass's APPEND, looked for in Sent before it is answered, lands late.
        if (id === inFlight && slow) { slow = false; reached(); await landed; }
        else if (clock.at < NOW.getTime() + MIN) throw refusedWith("OVERQUOTA");
        appended.push(id);
        filedAt.set(id, clock.at);
        return null;
      },
      async messageInSent(id: string) { return appended.includes(id); },
      async close() { /* nothing held */ },
    });
    const pass = (at: number) => runOwedSentCopyPass(w.db, {
      openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => new Date(at),
    });
    const firstPass = pass(NOW.getTime());
    await atAppend;
    clock.at = NOW.getTime() + 1_000;
    await pass(clock.at);
    clock.at = NOW.getTime() + 62_000;
    await pass(clock.at);
    land();
    await firstPass;
    clock.at = NOW.getTime() + 85_000;
    await pass(clock.at);
    expect([...appended].sort(), "each copy appended once").toEqual([inFlight, refused, settling].sort());
    expect((filedAt.get(settling) ?? 0) - NOW.getTime(), "ms until the door's row is filed").toBeGreaterThanOrEqual(85_000);
  });

  it("a copy charged in the pass keeps its own wait when its mailbox then waits on its ladder", async () => {
    const w = await setup();
    const tooBig = await oweRow(w, 0);
    const other = await oweRow(w, 1);
    // Its fourth refusal of its own comes next: six hours of its own wait follow.
    await w.db.update(outboundSentCopies).set({ attempts: 3 });
    const clock = { at: NOW.getTime() };
    const tries = new Map<string, number>();
    const open: OpenSendAdapter = async () => ({
      async send() { throw new Error("never"); },
      async fileSentCopy(_raw: Buffer, id: string) {
        tries.set(id, (tries.get(id) ?? 0) + 1);
        if (id === tooBig) throw refusedWith("TOOBIG");
        // The other is refused past the dial deadline: its mailbox waits.
        if (clock.at < NOW.getTime() + MIN) { clock.at += 11_000; throw refusedWith("OVERQUOTA"); }
        return null;
      },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    const pass = () => runOwedSentCopyPass(w.db, {
      openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => new Date(clock.at), budgetMs: 60_000,
    });
    await pass();
    clock.at = NOW.getTime() + POKE_MS;
    await pass();
    expect({ tooBig: tries.get(tooBig), other: tries.get(other), owed: (await owedRows(w.db)).map((r) => r.nextAttemptAt.getTime()) })
      .toEqual({ tooBig: 1, other: 2, owed: [NOW.getTime() + SEND_COPY_OWED_WAITS_MS[3]!] });
  });

  it.each([["files it", true], ["is refused", false]] as const)(
    "a copy past its seventh day that another pass is filing is not deleted under it: that pass %s, and a pass after it deletes what is left",
    async (_label, takes) => {
      const w = await setup();
      // Recorded half a minute short of seven days before NOW: past its hold a minute later.
      await oweRow(w, 30 - SEND_COPY_OWED_HOLD_MS / 1000);
      let reached!: () => void;
      const atAppend = new Promise<void>((r) => { reached = r; });
      let answer!: () => void;
      const answered = new Promise<void>((r) => { answer = r; });
      const open: OpenSendAdapter = async () => ({
        async send() { throw new Error("never"); },
        async fileSentCopy() {
          reached();
          await answered;
          if (!takes) throw refusedWith("OVERQUOTA");
          return null;
        },
        async messageInSent() { return false; },
        async close() { /* nothing held */ },
      });
      const pass = (at: number) => runOwedSentCopyPass(w.db, {
        openSendAdapter: open, resolveStorageCap: cap, sends: new SendService(), now: () => new Date(at),
      });
      const filing = pass(NOW.getTime());
      await atAppend;
      const meanwhile = await pass(NOW.getTime() + MIN);
      answer();
      const filer = await filing;
      const after = await pass(NOW.getTime() + 2 * MIN);
      expect({ meanwhile: meanwhile.dropped, filed: filer.filed, after: after.dropped, owed: (await owedRows(w.db)).length })
        .toEqual({ meanwhile: 0, filed: takes ? 1 : 0, after: takes ? 0 : 1, owed: 0 });
    },
  );

  // The desktop's store (PGlite) has no autovacuum; SQLite reuses freed pages on its own.
  const tableBytes = async (db: Awaited<ReturnType<typeof setup>>["db"]) => Number(((await db.execute(
    sql`select pg_total_relation_size('outbound_sent_copies')::text as n`)) as unknown as { rows: { n: string }[] }).rows[0]!.n);
  const MB = 1024 * 1024;

  it.skipIf(process.env.OHMAIL_TEST_DIALECT === "sqlite")("a healthy 10 MB send leaves none of its bytes in the store once its copy is filed", async () => {
    const w = await setup();
    const empty = await tableBytes(w.db);
    const smtp = slowSmtp({ bodyBytes: 10 * MB });
    const res = await svc.send(w.ctx, await w.newDraft(), "owed-healthy", {
      openSendAdapter: smtp.factory, resolveStorageCap: cap, keepOwedCopy: true, copyOutlivesAnswer: true,
      copyTiming: { graceMs: 30_000, deadlineMs: 30_000, waitsMs: [0] },
    });
    expect(res.sentCopy).toBe("filed");
    expect(await owedRows(w.db)).toEqual([]);
    // The indexes keep their emptied pages for reuse (about 0.3 MB here); the 13 MB of bytes go.
    expect(await tableBytes(w.db) - empty, "dead space left behind").toBeLessThan(MB);
  }, 60_000);

  it.skipIf(process.env.OHMAIL_TEST_DIALECT === "sqlite")("an owed 10 MB copy takes about its encoded size, and none once filed late", async () => {
    const o = await owedSend(undefined, 10 * MB);
    expect(o.res.sentCopy).toBe("pending");
    expect(await tableBytes(o.db), "bytes on disk for one owed copy").toBeLessThan(1.6 * o.smtp.state.raws[0]!.length);
    o.reachable();
    const out = await new SendService().fileOwedCopies(o.ctx, o.mailboxId, { openSendAdapter: o.smtp.factory, resolveStorageCap: cap });
    expect(out.filed).toBe(1);
    expect(await tableBytes(o.db), "dead space left behind").toBeLessThan(MB);
  }, 60_000);

  it.skipIf(process.env.OHMAIL_TEST_DIALECT === "sqlite")("a server's store is left to its own vacuum: no VACUUM after a filed copy", async () => {
    const w = await setup();
    const empty = await tableBytes(w.db);
    const res = await svc.send(w.ctx, await w.newDraft(), "owed-server", {
      openSendAdapter: slowSmtp({ bodyBytes: 4 * MB }).factory, resolveStorageCap: cap,
      keepOwedCopy: OWED_COPY_SELF_HOST, copyOutlivesAnswer: true, copyTiming: { graceMs: 30_000, deadlineMs: 30_000, waitsMs: [0] },
    });
    expect({ sentCopy: res.sentCopy, rows: await owedRows(w.db) }).toEqual({ sentCopy: "filed", rows: [] });
    expect(await tableBytes(w.db) - empty, "the deleted bytes' space is not reclaimed here").toBeGreaterThan(2 * MB);
  }, 60_000);
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
