import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { normalizeMime, countRealFiles, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import { attachments, drafts, messageBodies, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { eq } from "drizzle-orm";
import { SendService, type ServiceContext } from "@trafficflow/services";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { byMessageId, makeHarness, rawClient, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * A FORWARD ROUND TRIP: OUR SEND, THE WIRE, OUR OWN PARSER. Measured 2026-09-21: two forwards
 * arrived reading as the note alone. This file pins the send half — a forward of an HTML-only
 * original with an inline picture and two files (one UTF-8 name) leaves through `SendService`
 * against a live GreenMail, and the delivered copy, read over IMAP and parsed by `normalizeMime`
 * as a recipient's worker would, carries the original's words in BOTH parts and names every part.
 * Mutations watched red (kit/mutate/mutation-control.sh): `forwardedQuote`'s `plain` derivation
 * replaced with `originalText` (text-part assertion); `toAttachmentMeta`'s `inline` forced false
 * (the parser control — the inline-picture assertion).
 */
const sendSvc = new SendService();

const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const UTF8_NAME = "Übersicht ✓ Bericht.txt";
const ORIGINAL_HTML =
  "<div><p>Quarterly <b>numbers</b> attached, logo below.</p>"
  + '<img src="cid:logo@atelier" alt="logo"><p>Regards,<br>Lena</p></div>';

/**
 * An HTML-only original: an EMPTY text/plain alternative beside the html (stored text ""), the cid
 * picture and both files as TOP-LEVEL parts. GreenMail answers BODY[1.2.2.MIME] for a part two
 * levels deep with part 1's headers (measured 2026-09-21; its BODYSTRUCTURE is right), so every
 * fetched part sits at depth one; the nested shape is a gap row to measure against Dovecot.
 */
function originalEml(messageId: string, from: string): string {
  const mixed = "MIXED0022"; const alt = "ALT0022";
  const encodedName = encodeURIComponent(UTF8_NAME);
  return [
    `Message-ID: <${messageId}>`,
    `From: ${from}`,
    "To: me@trafficflow.test",
    "Subject: Q3 numbers",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "",
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    ORIGINAL_HTML,
    `--${alt}--`,
    `--${mixed}`,
    "Content-Type: image/png",
    "Content-ID: <logo@atelier>",
    "Content-Disposition: inline; filename=\"logo.png\"",
    "Content-Transfer-Encoding: base64",
    "",
    LOGO_PNG.toString("base64"),
    `--${mixed}`,
    "Content-Type: application/pdf; name=\"plan.pdf\"",
    "Content-Disposition: attachment; filename=\"plan.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 plan").toString("base64"),
    `--${mixed}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Disposition: attachment; filename*=UTF-8''${encodedName}`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Bericht: alles im grünen Bereich\n", "utf8").toString("base64"),
    `--${mixed}--`,
    "",
  ].join("\r\n");
}

async function deliveredSource(cfg: Parameters<typeof rawClient>[0], user: string, messageId: string): Promise<Buffer> {
  const inbox = await rawClient({ ...cfg, auth: { user, pass: "test" } });
  try {
    const lock = await inbox.getMailboxLock("INBOX");
    try {
      const found = await inbox.search({ header: { "message-id": messageId } }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      expect(uids, "exactly one delivered copy").toHaveLength(1);
      const one = await inbox.fetchOne(String(uids[0]), { source: true }, { uid: true });
      return (one as { source: Buffer }).source;
    } finally {
      lock.release();
    }
  } finally {
    await inbox.logout();
  }
}

describe("forward round trip (GreenMail SMTP+IMAP + Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("an HTML-only original with a cid picture and two files arrives whole and parses whole", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const ctx: ServiceContext = { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
      writeAuthority: FIXTURE_LEASE,
    };

    // 1. The original lands in the sender's mailbox and is ingested by our own pipeline.
    const origHeader = `orig-${randomUUID()}@atelier.example`;
    const c = await rawClient(h.cfg);
    await c.append("INBOX", originalEml(origHeader, "lena@atelier.example"));
    await c.logout();
    await runSyncCycle(deps);
    const [orig] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, origHeader));
    expect(orig, "the original was ingested").toBeDefined();
    const [origBody] = await h.db.select().from(messageBodies).where(eq(messageBodies.messageId, orig!.id));
    expect(origBody!.text.trim(), "the fixture IS html-only at rest").toBe("");
    expect(origBody!.html).toContain("Quarterly <b>numbers</b>");
    const origParts = await h.db.select().from(attachments).where(eq(attachments.messageId, orig!.id));
    expect(origParts).toHaveLength(3);

    // 2. The forward: a rich note above the original, addressed to a second GreenMail user.
    const recipient = `r-${randomUUID()}@trafficflow.test`;
    const [draft] = await h.db.insert(drafts).values({
      accountId: h.accountId, mailboxId: h.mailboxId, subject: "Fwd: Q3 numbers",
      body: "Passing this along.", html: "<p>Passing this along.</p>",
      to: [{ name: null, address: recipient }], cc: [], bcc: [],
      status: "draft", createdAt: new Date(), updatedAt: new Date(),
    }).returning();
    const factory: OpenSendAdapter = async () => ({
      send: (m: OutboundMessage) => h.adapter.send(m),
      messageInSent: (id: string) => h.adapter.messageInSent(id),
      async close() { /* the harness owns the connection */ },
    });
    const res = await sendSvc.send(
      ctx, draft!.id, `fwd-${randomUUID()}`,
      {
        openSendAdapter: factory,
        openFetchAdapter: async () => ({
          fetchPart: (l, p, o) => h.adapter.fetchPart(l, p, o),
          async close() { /* the harness owns the connection */ },
        }),
      },
      { forwardOf: orig!.id },
    );
    expect(res.status).toBe("sent");

    // 3. The recipient's copy, read off the wire and ingested through our own parser.
    const source = await deliveredSource(h.cfg, recipient, res.providerMessageId!);
    const parsed = await normalizeMime(source);
    // The plain alternative: the note, the banner, and the ORIGINAL'S WORDS — derived from its html.
    expect(parsed.textBody).toContain("Passing this along.");
    const afterBanner = parsed.textBody.split("---------- Forwarded message ----------")[1] ?? "";
    expect(afterBanner).toContain("From: lena@atelier.example");
    expect(afterBanner, "the text part carries the original, not headers over nothing").toContain("Quarterly numbers attached");
    expect(afterBanner).toContain("Lena");
    // The html alternative: the original's markup inside the blockquote.
    expect(parsed.htmlBody).toContain("<blockquote>");
    expect(parsed.htmlBody).toContain("Quarterly <b>numbers</b> attached");
    // Every part, by name: the inline picture keeps its cid and is marked inline, the two files
    // keep their names — the UTF-8 one byte for byte — and the real-file count is two.
    const byName = new Map(parsed.attachments.map((a) => [a.filename, a]));
    expect([...byName.keys()].sort()).toEqual(["logo.png", "plan.pdf", UTF8_NAME].sort());
    expect(byName.get("logo.png")).toMatchObject({ inline: true, contentId: "logo@atelier" });
    expect(byName.get("plan.pdf")).toMatchObject({ inline: false, contentType: "application/pdf" });
    expect(byName.get(UTF8_NAME)).toMatchObject({ inline: false });
    expect(byName.get("plan.pdf")!.sizeBytes).toBe(Buffer.byteLength("%PDF-1.4 plan"));
    expect(parsed.hasAttachments).toBe(true);
    expect(countRealFiles(parsed.attachments)).toBe(2);
    // The outbound sanitizer admits no <img> (its policy: no inline data: payloads), so the quoted
    // html carries no picture reference; the picture itself rides as the inline part above. Pinned
    // as observed — a gap row asks for the cid placement to survive a forward.
    expect(parsed.htmlBody).not.toContain("<img");
  }, 90000);

  /**
   * THE RESURFACED-ROW CONTROL: a conversation
   * whose newest member is the account's own auto-reply presents its newest INBOUND member, and a
   * forward from it carries THAT message. This pins the send half: handed the inbound member, the
   * wire quotes it alone.
   */
  it("a forward from a conversation carries the inbound member it was handed, never the own auto-reply", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const ctx: ServiceContext = { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };
    const seed = async (o: { from: string; text: string; date: Date; own?: boolean }) => {
      const [m] = await h.db.insert(messages).values({
        accountId: h.accountId, mailboxId: h.mailboxId, bodyHash: "h",
        dedupKey: `seed:${randomUUID()}`, subject: o.own ? "Re: Budget" : "Budget",
        fromAddress: o.from, snippet: o.text.slice(0, 200), date: o.date,
        nativeLocator: { folder: "INBOX", ref: "1:1" },
      }).returning();
      await h.db.insert(messageBodies).values({ messageId: m!.id, text: o.text, html: null });
      return m!.id;
    };
    const inboundId = await seed({ from: "colleague@partner.example", text: "Please review the budget numbers before Friday.", date: new Date(Date.now() - 60_000) });
    await seed({ from: h.cfg.auth.user, text: "I'm away this week and will answer on my return.", date: new Date(), own: true });

    const recipient = `r-${randomUUID()}@trafficflow.test`;
    const [draft] = await h.db.insert(drafts).values({
      accountId: h.accountId, mailboxId: h.mailboxId, subject: "Fwd: Budget",
      body: "See the report.", to: [{ name: null, address: recipient }], cc: [], bcc: [],
      status: "draft", createdAt: new Date(), updatedAt: new Date(),
    }).returning();
    const factory: OpenSendAdapter = async () => ({
      send: (m: OutboundMessage) => h.adapter.send(m),
      messageInSent: (id: string) => h.adapter.messageInSent(id),
      async close() { /* the harness owns the connection */ },
    });
    const res = await sendSvc.send(ctx, draft!.id, `fwd-${randomUUID()}`, { openSendAdapter: factory }, { forwardOf: inboundId });
    expect(res.status).toBe("sent");

    const parsed = await normalizeMime(await deliveredSource(h.cfg, recipient, res.providerMessageId!));
    expect(parsed.textBody).toContain("From: colleague@partner.example");
    expect(parsed.textBody).toContain("Please review the budget numbers before Friday.");
    expect(parsed.textBody, "the own auto-reply is not what a forward from this conversation carries").not.toContain("away this week");
  }, 60000);
});
