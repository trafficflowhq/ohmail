import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { drafts, outboundSends } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { SendService, SEND_STALE_AFTER_MS, type ServiceContext } from "@trafficflow/services";
import type { EmailAddress, OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { makeHarness, rawClient, uidInFolder, dbUrlFor } from "./_workerenv.js";

const DB_URL = dbUrlFor(import.meta.url);

// End-to-end (GreenMail SMTP :3025 + IMAP :3143 + Postgres): the gated idempotent
// send actually delivers over SMTP AND appends to Sent, then finalizes the state
// machine — and a same-key retry NEVER re-delivers (the #1 Phase-3c invariant), and
// a stale `pending` reservation is recovered by a REAL Sent-folder search.

const svc = new SendService();

function ctxFor(h: Awaited<ReturnType<typeof makeHarness>>): ServiceContext {
  return { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };
}

/** Wrap the harness's live ImapAdapter (smtp configured) as a counting SendAdapter. */
function liveSend(h: Awaited<ReturnType<typeof makeHarness>>) {
  const state = { sendCalls: 0 };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      const r = await h.adapter.send(msg);
      return { providerMessageId: r.providerMessageId };
    },
    messageInSent: (id: string) => h.adapter.messageInSent(id),
    async close() { /* reuse the harness connection */ },
  });
  return { factory, state };
}

async function seedDraft(
  h: Awaited<ReturnType<typeof makeHarness>>,
  status = "draft",
  extra: { cc?: EmailAddress[]; bcc?: EmailAddress[] } = {},
): Promise<string> {
  const [d] = await h.db.insert(drafts).values({
    accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
    subject: "Re: your enquiry", body: "Thanks for reaching out.",
    to: [{ name: null, address: "recipient@trafficflow.test" }],
    ...(extra.cc ? { cc: extra.cc } : {}),
    ...(extra.bcc ? { bcc: extra.bcc } : {}),
    status,
  }).returning();
  return d!.id;
}

/** The raw RFC822 source of the one message carrying `messageId` in a folder, or null. */
async function sourceOf(c: ImapFlow, serverPath: string, messageId: string): Promise<string | null> {
  const lock = await c.getMailboxLock(serverPath);
  try {
    const uids = await c.search({ header: { "message-id": messageId } }, { uid: true });
    if (!Array.isArray(uids) || uids.length === 0) return null;
    const msg = await c.fetchOne(String(uids[0]), { source: true }, { uid: true });
    return msg && msg.source ? msg.source.toString("utf8") : null;
  } finally {
    lock.release();
  }
}

/** Just the header block of a raw message — the body is not where a Bcc leak would matter. */
function headerBlock(raw: string): string {
  return raw.split(/\r\n\r\n/)[0]!;
}

describe("send e2e (GreenMail SMTP+IMAP + Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("delivers over SMTP, appends to Sent, finalizes draft+reservation to 'sent'", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const draftId = await seedDraft(h);
    const { factory, state } = liveSend(h);

    const res = await svc.send(ctxFor(h), draftId, "e2e-1", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(res.providerMessageId).toMatch(/^<.+@trafficflow\.test>$/);   // minted from the mailbox domain

    // The message was really appended to Sent (found by a raw IMAP header search).
    const inner = res.providerMessageId!.replace(/[<>]/g, "");
    const c = await rawClient(h.cfg);
    const uids = await uidInFolder(c, "Sent", inner);
    await c.logout();
    expect(uids.length).toBeGreaterThan(0);

    // State machine finalized.
    const [d] = await h.db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("sent");
    const [row] = await h.db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");
    expect(row!.providerMessageId).toBe(res.providerMessageId);
  }, 30000);

  it("CRUX — same Idempotency-Key does NOT re-deliver (send-count stays 1)", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const draftId = await seedDraft(h);
    const { factory, state } = liveSend(h);

    const one = await svc.send(ctxFor(h), draftId, "e2e-dup", { openSendAdapter: factory });
    const two = await svc.send(ctxFor(h), draftId, "e2e-dup", { openSendAdapter: factory });

    expect(state.sendCalls).toBe(1);                       // NEVER a second SMTP delivery
    expect(two.status).toBe("sent");
    expect(two.providerMessageId).toBe(one.providerMessageId);
  }, 30000);

  it("CRUX — crash recovery: a stale pending whose id IS in Sent reconciles WITHOUT re-delivering", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const draftId = await seedDraft(h, "sending");

    // Simulate a crashed prior attempt: append the mail to Sent out-of-band, then
    // record a matching `pending` reservation the finalize never reached.
    const minted = `<recover-${Date.now()}@trafficflow.test>`;
    await h.adapter.send({
      from: h.cfg.auth.user, to: "recipient@trafficflow.test",
      subject: "prior attempt", text: "delivered before the crash", messageId: minted,
    });
    await h.db.insert(outboundSends).values({
      accountId: h.accountId, idempotencyKey: "e2e-recover", draftId,
      mintedMessageId: minted, status: "pending",
      // Explicitly STALE. A reservation younger than `SEND_STALE_AFTER_MS` is a send that may
      // still be in flight, and the service now answers `in_flight` for it rather than probing
      // Sent — probing a live send finds nothing yet and would mark it `unverified`.
      createdAt: new Date(Date.now() - SEND_STALE_AFTER_MS - 1000),
    });

    const { factory, state } = liveSend(h);
    const res = await svc.send(ctxFor(h), draftId, "e2e-recover", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(0);                       // verified by real Sent search, NOT resent
    expect(res.providerMessageId).toBe(minted);
    const [row] = await h.db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");
  }, 30000);

  it("CRUX — Cc rides the headers, Bcc rides the ENVELOPE ONLY, over real SMTP+IMAP", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    // Distinct GreenMail recipients so each mailbox can be read independently. GreenMail
    // auto-creates a user on first login and routes SMTP into each recipient's INBOX.
    const stamp = Date.now();
    const ccAddr = `cc-${stamp}@trafficflow.test`;
    const bccAddr = `bcc-${stamp}@trafficflow.test`;
    const draftId = await seedDraft(h, "draft", {
      cc: [{ name: null, address: ccAddr }],
      bcc: [{ name: null, address: bccAddr }],
    });
    const { factory, state } = liveSend(h);

    const res = await svc.send(ctxFor(h), draftId, "e2e-ccbcc", { openSendAdapter: factory });
    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    const inner = res.providerMessageId!.replace(/[<>]/g, "");

    // ── THE SENDER'S SENT COPY: a Cc header, and NO Bcc anywhere ─────────────────────────────
    const sender = await rawClient(h.cfg);
    const sentSource = await sourceOf(sender, "Sent", inner);
    await sender.logout();
    expect(sentSource, "the send appended a copy to Sent").not.toBeNull();
    const sentHeaders = headerBlock(sentSource!);
    expect(sentHeaders).toMatch(/^cc:/im);
    expect(sentHeaders).toContain(ccAddr);
    expect(sentHeaders).not.toMatch(/^bcc:/im);
    expect(sentHeaders).not.toContain(bccAddr);   // the blind recipient is nowhere in the headers

    // ── THE BCC RECIPIENT REALLY RECEIVED IT (envelope delivery), STILL BLIND ────────────────
    const blind = new ImapFlow({
      host: h.cfg.host, port: h.cfg.port, secure: h.cfg.secure,
      auth: { user: bccAddr, pass: "test" }, logger: false,
    });
    await blind.connect();
    const blindSource = await sourceOf(blind, "INBOX", inner);
    await blind.logout();
    // Delivered — proving the RCPT list carried the bcc — yet the delivered message still carries
    // no Bcc header, so a bcc recipient cannot see the other blind recipients either.
    expect(blindSource, "the bcc recipient received the mail via the envelope").not.toBeNull();
    expect(headerBlock(blindSource!)).not.toMatch(/^bcc:/im);

    // ── THE CC RECIPIENT RECEIVED IT, AND CANNOT SEE THE BCC ─────────────────────────────────
    const carbon = new ImapFlow({
      host: h.cfg.host, port: h.cfg.port, secure: h.cfg.secure,
      auth: { user: ccAddr, pass: "test" }, logger: false,
    });
    await carbon.connect();
    const carbonSource = await sourceOf(carbon, "INBOX", inner);
    await carbon.logout();
    expect(carbonSource, "the cc recipient received the mail").not.toBeNull();
    const carbonHeaders = headerBlock(carbonSource!);
    expect(carbonHeaders).toContain(ccAddr);
    expect(carbonHeaders).not.toContain(bccAddr);   // the whole point of Bcc
  }, 30000);
});
