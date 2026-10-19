import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { attachments, drafts, outboundSends } from "@trafficflow/db";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { normalizeMime } from "@trafficflow/core/mail";
import type { ImapConfig } from "@trafficflow/core/adapters/imap-types";
import { sendService, type ServiceContext } from "@trafficflow/services/mail";
import { ServiceError } from "../src/errors.js";
import { makeTestDb } from "@trafficflow/db/testing";
import { FIXED_NOW, seedBody, seedMailbox, seedMessage, seedSession } from "../../api/test/helpers.js";
import { greenmailConfig } from "../../core/test/adapters/_imapenv.js";
import { startFaultProxy } from "../../core/test/adapters/_fault-proxy.js";

/**
 * A FORWARD WHOSE ORIGINAL'S READ DIES ONCE GOES ON THE FIRST PRESS, WHOLE. GreenMail holds the
 * original with a PDF; the forward reads it through a proxy that closes the connection on the first
 * part FETCH, and submits through GreenMail's own SMTP. The first attempt fails before any SMTP
 * command; its answer is retryable and the same-key replay re-arms the reservation. The recipient's
 * INBOX and the sender's Sent each hold exactly one copy under the one minted Message-ID, the PDF's
 * digest intact. Before: the read's fault was a 500 and the key was spent (the replay met `failed`).
 */

const PDF = randomBytes(96_000);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function original(messageId: string): string {
  return [
    `Message-ID: <${messageId}>`, "From: Newsletter <news@sender.example>", "To: list@sender.example",
    "Subject: The autumn list", "Date: Thu, 01 Oct 2026 09:00:00 +0200", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B"', "",
    "--B", "Content-Type: text/plain; charset=utf-8", "", "The list is attached.",
    "--B", 'Content-Type: application/pdf; name="list.pdf"', 'Content-Disposition: attachment; filename="list.pdf"',
    "Content-Transfer-Encoding: base64", "", PDF.toString("base64").replace(/.{76}/g, "$&\r\n"), "--B--", "",
  ].join("\r\n");
}

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => { /* already down */ }); });

/** Every copy of a Message-ID in one folder of one GreenMail user, read past the proxy. */
async function copies(cfg: ImapConfig, user: string, folder: string, messageId: string): Promise<Buffer[]> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: { user, pass: "test" }, logger: false });
  await c.connect();
  open.push(() => c.logout());
  const lock = await c.getMailboxLock(folder);
  try {
    const uids = await c.search({ header: { "message-id": messageId.replace(/[<>]/g, "") } }, { uid: true });
    const out: Buffer[] = [];
    for (const uid of Array.isArray(uids) ? uids : []) {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (m && typeof m !== "boolean" && m.source) out.push(m.source);
    }
    return out;
  } finally { lock.release(); }
}

describe("a forward whose original's read dies once (GreenMail, through the fault proxy)", () => {
  it("goes on the first press: one copy for the recipient, one in Sent, the PDF whole", async () => {
    const cfg = greenmailConfig();
    const sender = (cfg.auth as { user: string }).user;
    const recipient = `r-${randomUUID()}@trafficflow.test`;
    const seed = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
    await seed.connect();
    open.push(() => seed.logout());
    await seed.append("INBOX", original(`${randomUUID()}@sender.example`));
    const lock = await seed.getMailboxLock("INBOX");
    const uid = Math.max(...(await seed.search({ all: true }, { uid: true }) as number[]));
    const epoch = String((seed.mailbox as { uidValidity: bigint }).uidValidity);
    lock.release();
    // The recipient's mailbox exists before anything is delivered to it.
    const rcpt = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: { user: recipient, pass: "test" }, logger: false });
    await rcpt.connect();
    await rcpt.logout();

    const proxy = await startFaultProxy({ host: cfg.host, port: cfg.port });
    open.push(() => proxy.close());

    const db = await makeTestDb();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: sender });
    const orig = await seedMessage(db, {
      accountId: s.accountId, mailboxId, subject: "The autumn list", fromAddress: "news@sender.example",
      date: FIXED_NOW, nativeLocator: { folder: "INBOX", ref: `${epoch}:${uid}` },
    });
    await seedBody(db, { messageId: orig.id, text: "The list is attached.", html: null });
    await db.insert(attachments).values({
      accountId: s.accountId, messageId: orig.id, filename: "list.pdf", contentType: "application/pdf",
      sizeBytes: PDF.byteLength, partId: "2", inline: false, contentSha256: sha(PDF),
    });
    const [d] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "Fwd: The autumn list", body: "For you.",
      to: [{ name: null, address: recipient }], cc: [], bcc: [], status: "draft",
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).returning();
    const ctx: ServiceContext = { db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "rearm-forward" };
    const deps = {
      rearmTransient: true,
      openFetchAdapter: async () => {
        const a = new ImapAdapter({ ...cfg, host: "127.0.0.1", port: proxy.port });
        await a.connect();
        return a;
      },
      openSendAdapter: async () => {
        const a = new ImapAdapter({ ...cfg, sentDomain: "trafficflow.test" });
        await a.connect();
        return a;
      },
    };
    // The first read of the PDF's part never gets its answer: the connection dies under it.
    proxy.drop = (command, args) => command === "UID FETCH" && /(BODY|BINARY)(\.PEEK)?\[2\]/i.test(args);

    const key = `fwd-${randomUUID()}`;
    const first = await sendService.send(ctx, d!.id, key, deps as never, { forwardOf: orig.id }).catch((e: unknown) => e);
    expect(proxy.log.some((e) => e.faulted), "the rig: the part read was dropped").toBe(true);
    expect(first).toBeInstanceOf(ServiceError);
    expect({ retryable: (first as ServiceError).retryable, httpStatus: (first as ServiceError).httpStatus })
      .toEqual({ retryable: true, httpStatus: 424 });

    const replay = await sendService.send(ctx, d!.id, key, deps as never, { forwardOf: orig.id });
    expect(replay.status).toBe("sent");
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id));
    expect({ status: row!.status, attempts: row!.attempts }).toEqual({ status: "sent", attempts: 2 });

    const delivered = await copies(cfg, recipient, "INBOX", row!.mintedMessageId);
    expect(delivered, "not exactly one copy reached the recipient").toHaveLength(1);
    expect(await copies(cfg, sender, "Sent", row!.mintedMessageId), "not exactly one copy in Sent").toHaveLength(1);
    const parsed = await normalizeMime(delivered[0]!);
    expect(parsed.attachments.map((a) => [a.filename, a.sizeBytes, a.contentSha256])).toEqual([["list.pdf", PDF.byteLength, sha(PDF)]]);
  }, 60_000);
});
