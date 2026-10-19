import { createHash, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { attachments, drafts, messages } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { normalizeMime } from "@trafficflow/core/mail";
import type { ImapConfig } from "@trafficflow/core/adapters/imap-types";
import { sendService, type ServiceContext } from "@trafficflow/services/mail";
import { ServiceError } from "../src/errors.js";
import { makeTestDb } from "@trafficflow/db/testing";
import { FIXED_NOW, seedBody, seedMailbox, seedMessage, seedSession } from "../../api/test/helpers.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "../../core/test/adapters/_imapenv.js";
import { startFaultProxy } from "../../core/test/adapters/_fault-proxy.js";
import { overlongLines, startStrictSmtpSink, SMTP_MAX_LINE_OCTETS } from "./_strict-smtp-sink.js";

/**
 * THE FORWARD REFUSED ON 2026-10-19, END TO END. A newsletter (42 recipients on its To line, an HTML
 * body of one 1 033-character line, one 268 662-byte PDF) was opened and forwarded at once, and the
 * send was refused "Sending didn't work"; the same forward went out 76 s later. The sync worker set
 * \Seen on the message about three seconds into the send, while it was reading the PDF; the server
 * told the forward's connection about it ahead of a chunk's answer (what the timing says iCloud
 * did), and the read came back short. No SMTP command had been sent.
 *
 * Here the real send path runs it: `SendService.send`, the forward's original read by a real
 * `ImapAdapter` through a proxy that parks one chunk while another session marks the message read
 * and then hands the server's own flag update back first, and the message submitted by a real
 * `ImapAdapter` to a loopback server that refuses any line over 998 octets. Measured on the tree
 * before the fix, on both servers: the race case is refused `attachment_part_mismatch` (409), the
 * answer that forward got, while the three controls send. Each of the two layers alone sends it: the
 * connection's `fetchOne` (`answerForTheAskedMessage`), and the part gate's re-read of a section
 * the server's tree vouches for (`PART_REREAD_WAITS_MS`).
 */

const DOVECOT = await probeCondstore();
const PDF = randomBytes(268_662);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
/** 42 addresses of the length real ones have: the To line runs past 1 700 characters unfolded. */
const RECIPIENTS = Array.from({ length: 42 }, (_, i) => `reader.number${i + 1}@neighbourhood-list.example.test`);
/** One line, as the newsletter's was: 1 033 characters of markup with no break in it. */
const HTML = `<div dir="ltr"><p>Dear readers,</p><p>${"The autumn list is open again; please send your order by the first of the month. ".repeat(14)}</p></div>`.slice(0, 1033);

function newsletter(messageId: string): string {
  return [
    `Message-ID: <${messageId}>`, "From: Newsletter <news@sender.example>", `To: ${RECIPIENTS.join(", ")}`,
    "Subject: Autumn newsletter", "Date: Thu, 01 Oct 2026 09:00:00 +0200", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B"', "",
    "--B", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", HTML,
    "--B", 'Content-Type: application/pdf; name="list.pdf"', 'Content-Disposition: attachment; filename="list.pdf"',
    "Content-Transfer-Encoding: base64", "", PDF.toString("base64").replace(/.{76}/g, "$&\r\n"), "--B--", "",
  ].join("\r\n");
}

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => { /* already down */ }); });

async function world(server: { host: string; port: number; pass: string }) {
  const auth = { user: `t-${randomUUID()}@trafficflow.test`, pass: server.pass };
  // The mail server's side: the newsletter in INBOX, and the other session that marks it read.
  const other = new ImapFlow({ host: server.host, port: server.port, secure: false, auth, logger: false });
  await other.connect();
  open.push(() => other.logout());
  await other.append("INBOX", newsletter(`${randomUUID()}@example.test`));
  const lock = await other.getMailboxLock("INBOX");
  const uid = Math.max(...(await other.search({ all: true }, { uid: true }) as number[]));
  const epoch = String((other.mailbox as { uidValidity: bigint }).uidValidity);
  lock.release();
  const proxy = await startFaultProxy({ host: server.host, port: server.port });
  open.push(() => proxy.close());
  const sink = await startStrictSmtpSink();
  open.push(() => sink.close());

  // The account's side: the original as ingest stored it, and the forward as composed. The
  // database alone, not `makeDeps`: that one stubs `ImapAdapter.connect`, and both adapters here dial.
  const db = await makeTestDb();
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: auth.user, provider: "icloud" });
  const orig = await seedMessage(db, {
    accountId: s.accountId, mailboxId, subject: "Autumn newsletter", fromAddress: "news@sender.example",
    date: FIXED_NOW, nativeLocator: { folder: "INBOX", ref: `${epoch}:${uid}` },
  });
  await db.update(messages).set({ toAddresses: RECIPIENTS.map((address) => ({ name: null, address })) })
    .where(eq(messages.id, orig.id));
  await seedBody(db, { messageId: orig.id, text: "", html: HTML });
  await db.insert(attachments).values({
    accountId: s.accountId, messageId: orig.id, filename: "list.pdf", contentType: "application/pdf",
    sizeBytes: PDF.byteLength, partId: "2", inline: false, contentSha256: sha(PDF),
  });
  const draft = async (o: { to: string[]; body: string; html?: string; inReplyTo?: string }): Promise<string> => {
    const [d] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: o.inReplyTo ? "Re: Autumn newsletter" : "Fwd: Autumn newsletter",
      body: o.body, to: o.to.map((address) => ({ name: null, address })), cc: [], bcc: [],
      ...(o.html ? { html: o.html } : {}),
      ...(o.inReplyTo ? { inReplyToMessageId: o.inReplyTo } : {}),
      status: "draft", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).returning();
    return d!.id;
  };
  const ctx: ServiceContext = { db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "flag-race" };
  // Both adapters are the product's own, one fresh connection per open, as the hosts build them.
  const imap: ImapConfig = { host: server.host, port: server.port, secure: false, auth };
  const deps = {
    openFetchAdapter: async () => {
      const a = new ImapAdapter({ ...imap, host: "127.0.0.1", port: proxy.port });
      await a.connect();
      return a;
    },
    openSendAdapter: async () => {
      const a = new ImapAdapter({ ...imap, smtp: { host: "127.0.0.1", port: sink.port, secure: false }, sentDomain: "trafficflow.test" });
      await a.connect();
      return a;
    },
  };
  /** Park the forward's second chunk until the other session has marked the original read. */
  const markReadMidForward = (): void => {
    proxy.hold = {
      when: (command, args) => command === "UID FETCH" && /<[1-9]\d*\./.test(args),
      unsolicitedFirst: true,
      run: async () => {
        const l = await other.getMailboxLock("INBOX");
        try { await other.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }); } finally { l.release(); }
      },
    };
  };
  return { ctx, deps, sink, proxy, draft, originalId: orig.id, markReadMidForward };
}

/** The one message the sink accepted, parsed — and the lines a strict server would have refused. */
async function delivered(sink: { messages: Buffer[] }) {
  expect(sink.messages).toHaveLength(1);
  const raw = sink.messages[0]!;
  return { raw, parsed: await normalizeMime(raw), overlong: overlongLines(raw) };
}

const servers: Array<[string, () => { host: string; port: number; pass: string } | null]> = [
  ["GreenMail", () => { const g = greenmailConfig(); return { host: g.host, port: g.port, pass: (g.auth as { pass: string }).pass }; }],
  [DOVECOT.ok ? "Dovecot" : `Dovecot — SKIPPED: ${DOVECOT.ok ? "" : DOVECOT.why}`,
    () => (DOVECOT.ok ? { host: CONDSTORE_HOST, port: CONDSTORE_PORT, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" } : null)],
];

describe.each(servers)("the 2026-10-19 forward through the real send path (%s)", (_name, server) => {
  const run = server() ? it : it.skip;

  run("the race: the original marked read mid-forward — the first press sends, the PDF whole", async () => {
    const w = await world(server()!);
    const id = await w.draft({ to: ["friend@example.test"], body: "" });
    w.markReadMidForward();

    const res = await sendService.send(w.ctx, id, `race-${randomUUID()}`, w.deps, { forwardOf: w.originalId })
      .catch((e: unknown) => e);

    expect(w.proxy.reordered, "the rig: the flag update reached the forward first").toBeGreaterThanOrEqual(1);
    expect(res instanceof ServiceError ? `${res.code} ${res.httpStatus}` : (res as { status: string }).status).toBe("sent");
    const { parsed, overlong } = await delivered(w.sink);
    expect(w.sink.recipients).toEqual([1]);
    expect(parsed.attachments.map((a) => [a.filename, a.sizeBytes, a.contentSha256])).toEqual([["list.pdf", PDF.byteLength, sha(PDF)]]);
    expect(overlong).toEqual([]);
  });

  run("the control: the same forward with nothing racing sends — the 42-recipient original is no obstacle", async () => {
    const w = await world(server()!);
    const id = await w.draft({ to: ["friend@example.test"], body: "" });

    const res = await sendService.send(w.ctx, id, `calm-${randomUUID()}`, w.deps, { forwardOf: w.originalId });

    expect(res.status).toBe("sent");
    const { parsed, overlong } = await delivered(w.sink);
    expect(parsed.attachments[0]?.contentSha256).toBe(sha(PDF));
    // The quoted banner carries From, Date and Subject; the original's To line is not quoted at all.
    expect(parsed.textBody).toContain("---------- Forwarded message ----------");
    expect(parsed.textBody).not.toContain(RECIPIENTS[0]);
    expect(overlong).toEqual([]);
  });

  run("a rich forward carries the original's one-line html in a part no strict server refuses", async () => {
    const w = await world(server()!);
    const id = await w.draft({ to: ["friend@example.test"], body: "See below.", html: "<p>See below.</p>" });

    const res = await sendService.send(w.ctx, id, `rich-${randomUUID()}`, w.deps, { forwardOf: w.originalId });

    expect(res.status).toBe("sent");
    const { parsed, overlong } = await delivered(w.sink);
    // The quoted html is the original's single 1 033-character line, and it arrives whole.
    expect(parsed.htmlBody).toContain("The autumn list is open again");
    expect(parsed.attachments[0]?.contentSha256).toBe(sha(PDF));
    expect(overlong).toEqual([]);
  });

  run("a reply to all 42 goes out too: the To header is folded under the strict server's limit", async () => {
    const w = await world(server()!);
    const id = await w.draft({ to: RECIPIENTS, body: "Count me in.", inReplyTo: w.originalId });

    const res = await sendService.send(w.ctx, id, `reply-${randomUUID()}`, w.deps);

    expect(res.status).toBe("sent");
    const { raw, parsed, overlong } = await delivered(w.sink);
    expect(w.sink.recipients).toEqual([42]);
    expect(parsed.to.map((a) => a.address)).toEqual(RECIPIENTS);
    expect(overlong).toEqual([]);
    // The To header is longer than one line may be, so it can only have passed folded.
    const header = raw.subarray(0, raw.indexOf("\r\n\r\n")).toString("latin1");
    const toField = /^To: .*(?:\r\n[ \t].*)*/m.exec(header)![0];
    expect(toField.replace(/\r\n[ \t]/g, " ").length).toBeGreaterThan(SMTP_MAX_LINE_OCTETS);
  });
});

describe("the strict sink holds the rule it stands for (the rig's own control)", () => {
  it("an unfolded 1 033-octet line is refused after DATA, a 998-octet one accepted", async () => {
    const sink = await startStrictSmtpSink();
    open.push(() => sink.close());
    const talk = (body: string): Promise<string> => new Promise((resolve, reject) => {
      const c = net.connect(sink.port, "127.0.0.1");
      let said = "";
      const steps = ["EHLO t", "MAIL FROM:<a@example.test>", "RCPT TO:<b@example.test>", "DATA", `${body}\r\n.`, "QUIT"];
      c.on("data", (d) => {
        said += d.toString("latin1");
        const replies = said.split("\r\n").filter((l) => /^\d{3} /.test(l)).length;
        if (replies >= 1 && steps.length > 0 && replies === 7 - steps.length) c.write(`${steps.shift()}\r\n`);
      });
      c.on("close", () => resolve(said));
      c.on("error", reject);
    });
    const refused = await talk(`Subject: long\r\n\r\n${"a".repeat(1033)}`);
    const accepted = await talk(`Subject: edge\r\n\r\n${"a".repeat(998)}`);
    expect(refused).toMatch(/^500 5\.5\.2 Line too long \(1033 octets/m);
    expect(accepted).toMatch(/^250 2\.0\.0 queued/m);
    expect([sink.messages.length, sink.refusals]).toEqual([1, ["line of 1033 octets"]]);
  });
});
