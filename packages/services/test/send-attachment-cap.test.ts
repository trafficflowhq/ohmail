import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  attachmentBudgetFor, dbFor, SendService, SEND_ATTACHMENT_MAX_TOTAL_BYTES,
  SEND_MAX_RECIPIENTS, SEND_UNMEASURED_MESSAGE_BYTES, effectiveAttachmentCap,
} from "../src/index.js";
import type { ServiceContext, SendAttachment } from "../src/index.js";

/**
 * THE ATTACHMENT CEILING IS THE SMALLER OF TWO NUMBERS, AND NEITHER IS A CONSTANT.
 *
 * Until this slice there was one: 3 MB, reasoned from the hosted API's serverless request-body
 * limit and base64's inflation. That reasoning is sound about one deployment and
 * describes nothing else, and it was wrong in BOTH directions at once:
 *
 *  · TOO STRICT for the local engine, which runs this same `SendService` in the same process as
 *    its own SMTP dial. There is no request body anywhere between the compose form and the wire,
 *    so the desktop was refusing attachments the user's own mail server would have taken.
 *  · TOO LOOSE for anyone whose provider caps submission below it. The product accepted the send,
 *    spent the user's wait on it, and let their own server bounce it.
 *
 * So the cap is now `min(what this host can carry, what this mailbox's server announced)`, and the
 * second half comes from the connect-time SMTP probe's own EHLO (`mailboxes.smtp_max_size_bytes`,
 * mail 0055). The stingy-provider case below is the acceptance check for this slice — not the
 * generous-provider one, which is merely the feature working.
 */

const svc = new SendService();
const NOW = new Date("2026-08-11T12:00:00Z");
const MIB = 1024 * 1024;

function fakeAdapter() {
  const state = { sendCalls: 0, sent: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to release */ },
  });
  return { factory, state };
}

/** One attachment of exactly `bytes` raw bytes. Content is never inspected by the cap. */
function attachment(bytes: number): SendAttachment {
  return {
    filename: "big.bin",
    contentType: "application/octet-stream",
    content: Buffer.alloc(bytes),
  } as SendAttachment;
}

async function setup(smtpMaxSizeBytes: number | null) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "mila@lichtgrat.example", smtpMaxSizeBytes,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  async function newDraft() {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "with a file", body: "here",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    return d!.id;
  }
  return { db, ctx, newDraft, mailboxId: mb!.id };
}

describe("effectiveAttachmentCap — the min, and what an unknown resolves to", () => {
  it("A STINGY PROVIDER BINDS THE HOSTED SURFACE — this is the acceptance check", () => {
    // The hosted API declares 3 MB; the mailbox's own server announced 2 MB. The answer is the
    // mailbox's, and a `min` that ignored it would let the product accept a send its user's own
    // server will bounce.
    //
    // It is the announcement's BUDGET FOR RAW BYTES, not its face value: `SIZE` bounds the encoded
    // message, so an announced size is about three quarters of it in files. `attachmentBudgetFor` holds the
    // derivation; asserting through it rather than restating a number is what keeps this test from
    // becoming a second copy of the rule.
    expect(effectiveAttachmentCap(SEND_ATTACHMENT_MAX_TOTAL_BYTES, 2 * MIB))
      .toBe(attachmentBudgetFor(2 * MIB));
    expect(attachmentBudgetFor(2 * MIB)).toBeLessThan(2 * MIB);
  });

  it("a generous provider does NOT lift a host that has a limit", () => {
    expect(effectiveAttachmentCap(SEND_ATTACHMENT_MAX_TOTAL_BYTES, 35 * MIB))
      .toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  });

  it("no platform ceiling + a probed mailbox ⇒ the PROBED number (the local engine's case)", () => {
    expect(effectiveAttachmentCap(null, 25 * MIB)).toBe(attachmentBudgetFor(25 * MIB));
    expect(attachmentBudgetFor(25 * MIB)).toBeGreaterThan(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  });

  it("no platform ceiling + an UNPROBED mailbox ⇒ the assumed provider SIZE, never unbounded", () => {
    // An unknown limit is neither "no limit" nor the hosted request body's 3 MB, which refused a
    // 4 MB video on a server that takes it: it is a provider-typical announcement, budgeted.
    const assumed = attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES);
    expect(effectiveAttachmentCap(null, null)).toBe(assumed);
    expect(assumed).toBeGreaterThan(4 * MIB);
    expect(assumed).toBeLessThan(SEND_UNMEASURED_MESSAGE_BYTES);
  });

  it("a host that DECLARED NOTHING gets the strict constant, not the loose branch", () => {
    // `undefined` is not a third spelling of `null`: forgetting to declare a surface must not
    // hand it a bigger allowance than the hosted one.
    expect(effectiveAttachmentCap(undefined, null)).toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(effectiveAttachmentCap(undefined, 30 * MIB)).toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(effectiveAttachmentCap(undefined, 1 * MIB)).toBe(attachmentBudgetFor(1 * MIB));
  });

  it("`0` from either side is IGNORED, never treated as a ceiling of nothing", () => {
    // A server advertising `SIZE 0` means "no fixed maximum" (RFC 1870 §6). Reading it literally
    // refuses every file on a server that said it would take anything.
    expect(effectiveAttachmentCap(null, 0)).toBe(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES));
    expect(effectiveAttachmentCap(0, null)).toBe(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES));
    expect(effectiveAttachmentCap(Number.NaN, 4 * MIB)).toBe(attachmentBudgetFor(4 * MIB));
  });
});

describe("SendService applies the per-mailbox ceiling", () => {
  it("REFUSES at the provider's smaller number on the hosted surface, and says that number", async () => {
    const { ctx, newDraft } = await setup(1 * MIB);
    const { factory, state } = fakeAdapter();
    const err = await svc.send(
      ctx, await newDraft(), "k-stingy",
      { openSendAdapter: factory, surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES },
      { attachments: [attachment(2 * MIB)] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    // The MESSAGE has to carry the EFFECTIVE number, not the constant and not the announcement:
    // 2 MB is under the old ceiling, so a refusal that still said "3145728" would be unactionable,
    // and one that said "1048576" would name a number this send was never measured against.
    expect(String((err as Error).message)).toContain(String(attachmentBudgetFor(1 * MIB)));
    expect(state.sendCalls).toBe(0);
  });

  it("…and nothing is reserved — the draft is still `draft` after the refusal", async () => {
    const { db, ctx, newDraft } = await setup(1 * MIB);
    const draftId = await newDraft();
    const { factory } = fakeAdapter();
    await svc.send(
      ctx, draftId, "k-rollback",
      { openSendAdapter: factory, surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES },
      { attachments: [attachment(2 * MIB)] },
    ).catch(() => undefined);
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("draft");
  });

  it("a send UNDER the provider's number still goes", async () => {
    const { ctx, newDraft } = await setup(1 * MIB);
    const { factory, state } = fakeAdapter();
    const res = await svc.send(
      ctx, await newDraft(), "k-ok",
      { openSendAdapter: factory, surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES },
      { attachments: [attachment(512 * 1024)] },
    );
    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
  });

  it("THE LOCAL-ENGINE PATH: no platform ceiling + a probed server ⇒ past the old constant", async () => {
    // 5 MiB is over `SEND_ATTACHMENT_MAX_TOTAL_BYTES` and well under what this server announced.
    // Before this slice the desktop refused it on the hosted API's behalf.
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    const res = await svc.send(
      ctx, await newDraft(), "k-local",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null },
      { attachments: [attachment(5 * MIB)] },
    );
    expect(5 * MIB).toBeGreaterThan(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
  });

  it("THE UNPROBED LOCAL ENGINE SENDS A 4 MB FILE — the reported refusal", async () => {
    const { ctx, newDraft } = await setup(null);
    const { factory, state } = fakeAdapter();
    const res = await svc.send(
      ctx, await newDraft(), "k-local-unprobed",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null },
      { attachments: [attachment(4 * MIB)] },
    );
    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
  });

  it("…and stays bounded — no ceiling anywhere is not permission", async () => {
    const { ctx, newDraft } = await setup(null);
    const { factory, state } = fakeAdapter();
    const assumed = attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES);
    const err = await svc.send(
      ctx, await newDraft(), "k-local-unprobed-over",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null },
      { attachments: [attachment(assumed + 1)] },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    expect(String((err as Error).message)).toContain(String(assumed));
    expect(state.sendCalls).toBe(0);
  });

  it("a host that declares NOTHING is capped at the constant even on a generous provider", async () => {
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    const err = await svc.send(
      ctx, await newDraft(), "k-silent-host",
      { openSendAdapter: factory },
      { attachments: [attachment(4 * MIB)] },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    expect(state.sendCalls).toBe(0);
  });
});

/**
 * the recipient list, bounded where it becomes network.
 *
 * `to`/`cc`/`bcc` are three `jsonb` columns an autosaving compose surface writes, and the send
 * turns them into one `RCPT TO` command per address on a socket this process holds open.
 * `DraftsService.validAddresses` bounds what ONE REQUEST may name (100 per field); nothing
 * bounded what one MESSAGE may send. Three fields at that ceiling is three times as many recipients — which
 * Outlook and iCloud deliver and Gmail does not, so it is not a number a per-field cap can
 * police, and the per-message ceiling is 500: the largest of the mainstream limits, because a
 * bound derived from the tightest would refuse sends two of the three would have delivered.
 *
 * The check lives beside the attachment cap, inside the reserve transaction, for the reason that
 * one gives: the throw rolls the reservation back, so the draft stays a draft.
 *
 * Watched fail and restored: delete the `recipientCount > SEND_MAX_RECIPIENTS` block and the
 * refusal case returns `status: "sent"` with every address handed to the transport.
 */
describe("SEND_MAX_RECIPIENTS — the per-message total, across all three fields", () => {
  const people = (n: number, at: string): Array<{ name: null; address: string }> =>
    Array.from({ length: n }, (_, i) => ({ name: null, address: `p${i}@${at}` }));

  async function draftWith(
    db: Awaited<ReturnType<typeof setup>>["db"], accountId: string, mailboxId: string,
    to: number, cc: number, bcc: number,
  ): Promise<string> {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "many", body: "hi", status: "draft",
      to: people(to, "to.example"), cc: people(cc, "cc.example"), bcc: people(bcc, "bcc.example"),
    }).returning();
    return d!.id;
  }

  it("refuses a STORED draft whose three fields SUM past the ceiling, and names the total", async () => {
    const { db, ctx, mailboxId } = await setup(null);
    /**
     * Written STRAIGHT TO THE TABLE, past `DraftsService.validAddresses` — which is the only way
     * to reach this ceiling and the reason it exists. Three fields at `DRAFT_MAX_RECIPIENTS`
     * (100 each) is 300, under `SEND_MAX_RECIPIENTS` by construction, so a draft assembled
     * through the compose path can never meet it. What CAN is a row written before either
     * ceiling shipped, or by a later writer that does not go through the validator — the row
     * outliving its validator, exactly as a stored `steps` array does.
     */
    const draftId = await draftWith(db, ctx.accountId, mailboxId, 300, 200, 100);
    const { factory, state } = fakeAdapter();

    const err = await svc.send(
      ctx, draftId, "k-recipients",
      { openSendAdapter: factory, surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES }, {},
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    expect(String((err as Error).message)).toContain("600");
    expect(String((err as Error).message)).toContain(String(SEND_MAX_RECIPIENTS));
    // Nothing left the process.
    expect(state.sendCalls).toBe(0);
    // …and nothing was reserved: the throw is inside the transaction.
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("draft");
  });

  it("sends a message exactly AT the ceiling", async () => {
    const { db, ctx, mailboxId } = await setup(null);
    const draftId = await draftWith(db, ctx.accountId, mailboxId, SEND_MAX_RECIPIENTS, 0, 0);
    const { factory, state } = fakeAdapter();

    const res = await svc.send(
      ctx, draftId, "k-recipients-ok",
      { openSendAdapter: factory, surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES }, {},
    );

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    // The transport really did get all hundred — the ceiling admits what it says it admits.
    expect(state.sent[0]!.to.length + (state.sent[0]!.cc?.length ?? 0) + (state.sent[0]!.bcc?.length ?? 0))
      .toBe(SEND_MAX_RECIPIENTS);
  });
});

/**
 * THE REPLAY CONTRACT, which the recipient cap broke when it sat above the INSERT.
 *
 * A draft written before `SEND_MAX_RECIPIENTS` existed can hold more than it allows. If the cap
 * is checked before the `outbound_sends` conflict branch, a client retrying its original key
 * after a send that SUCCEEDED is answered 413 instead of the stored result — the service's own
 * no-lie contract, broken by the guard meant to protect it. That is the exact reason the
 * disabled-mailbox check and the held staged fault sit where they do, in their own words.
 *
 * Watched fail and restored: move the `recipientCount > SEND_MAX_RECIPIENTS` block above the
 * `tx.insert(outboundSends)` and this case throws 413 where it should replay.
 */
describe("an over-cap LEGACY draft still replays its stored result", () => {
  it("a same-key retry of a completed send is not turned into a 413", async () => {
    const { db, ctx, mailboxId } = await setup(null);
    // Inside the cap, so the first send is ordinary.
    const [d] = await db.insert(drafts).values({
      accountId: ctx.accountId, mailboxId, subject: "legacy", body: "hi", status: "draft",
      to: Array.from({ length: 10 }, (_, i) => ({ name: null, address: `p${i}@to.example` })),
    }).returning();
    const { factory, state } = fakeAdapter();
    const first = await svc.send(
      ctx, d!.id, "k-legacy",
      { openSendAdapter: factory, surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES }, {},
    );
    expect(first.status).toBe("sent");
    expect(state.sendCalls).toBe(1);

    // Now the row looks like one written before the ceiling: over the cap, already sent.
    await db.update(drafts)
      .set({ cc: Array.from({ length: SEND_MAX_RECIPIENTS + 1 }, (_, i) => ({ name: null, address: `c${i}@cc.example` })) })
      .where(eq(drafts.id, d!.id));

    const replay = await svc.send(
      ctx, d!.id, "k-legacy",
      { openSendAdapter: factory, surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES }, {},
    );

    // The STORED result, verbatim — and nothing was sent a second time.
    expect(replay.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
  });
});
