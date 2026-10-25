import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { createLogger } from "@trafficflow/core";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, messageBodies, attachments } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { AttachmentsService, type OpenAdapter, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle } from "../src/sync.js";
import { byMessageId, makeHarness, rawClient, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

// End-to-end (GreenMail IMAP + Postgres): attachment METADATA is captured atomically
// at ingest; the BLOB bytes are fetched ON-DEMAND from IMAP and NEVER stored.

interface Part { filename: string; contentType: string; content: string }

/** Build a multipart/mixed RFC822 with a text body + base64 attachment parts. */
function emlWith(o: { from: string; subject: string; messageId: string; parts: Part[] }): string {
  const boundary = "TFBOUNDARY0011";
  const lines: string[] = [
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    "To: mila@lichtgrat.example",
    `Subject: ${o.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See the attached files.",
  ];
  for (const p of o.parts) {
    const b64 = Buffer.from(p.content, "utf8").toString("base64");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${p.contentType}; name="${p.filename}"`,
      `Content-Disposition: attachment; filename="${p.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64,
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

function ctxFor(h: Awaited<ReturnType<typeof makeHarness>>): ServiceContext {
  return { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };
}

describe("attachments e2e (GreenMail + Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  const svc = new AttachmentsService();

  it("captures attachment metadata atomically at ingest (and none for a plain message)", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    // The production logger over a sink at debug: each ingested message's parse time arrives through it.
    const lines: string[] = [];
    const log = createLogger({ service: "worker", level: "debug", sink: (l) => lines.push(l) });
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE, log };

    const c = await rawClient(h.cfg);
    // The appended sender is a seeded known sender → stays in INBOX (no move to reason about).
    await c.append("INBOX", emlWith({
      from: "anna@x.example", subject: "with files", messageId: "att1@x",
      parts: [
        { filename: "hello.txt", contentType: "text/plain", content: "HELLO-ATTACHMENT-CONTENT" },
        { filename: "data.csv", contentType: "text/csv", content: "a,b,c\n1,2,3" },
      ],
    }));
    await c.append("INBOX",
      ["Message-ID: <plain1@x>", "From: anna@x.example", "To: mila@lichtgrat.example", "Subject: plain",
       "Content-Type: text/plain", "", "no files here"].join("\r\n"));

    await runSyncCycle(deps);

    const parses = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === "mime_parse_ms");
    expect(parses).toHaveLength(2);
    expect(parses.every((e) => typeof e.ms === "number" && typeof e.bytes === "number" && (e.bytes as number) > 0)).toBe(true);

    const [withFiles] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "att1@x"));
    expect(withFiles!.hasAttachments).toBe(true);
    expect(withFiles!.attachmentCount).toBe(2);

    const rows = await h.db.select().from(attachments)
      .where(eq(attachments.messageId, withFiles!.id));
    expect(rows).toHaveLength(2);
    const byName = new Map(rows.map((r) => [r.filename, r]));
    expect(byName.get("hello.txt")).toMatchObject({ contentType: expect.stringContaining("text/plain"), inline: false });
    expect(byName.get("hello.txt")!.sizeBytes).toBe(Buffer.byteLength("HELLO-ATTACHMENT-CONTENT", "utf8"));
    expect(byName.get("data.csv")!.partId).toBeTruthy();  // an IMAP body-part number for on-demand fetch

    // A message with NO attachment → no rows, hasAttachments false.
    const [plain] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "plain1@x"));
    expect(plain!.hasAttachments).toBe(false);
    const plainRows = await h.db.select().from(attachments).where(eq(attachments.messageId, plain!.id));
    expect(plainRows).toHaveLength(0);

    await c.logout();
  }, 30000);

  /**
   * ── GAP END TO END: THE STORED PAIR COUNTS DOWNLOADABLE PARTS ONLY ───────────────────
   *
   * The one place `messages.attachment_count` is written is `pipeline.ts`, and the one place its
   * value is decided is `mime.ts#countRealFiles`. Everything between them — mailparser's
   * `related` flag, the `attachments` rows, the insert — is exercised here and nowhere else, so
   * this is where a regression in the pair is visible against a real IMAP server and a real
   * database rather than against a hand-built fixture.
   *
   * Two mutations this is the only guard for:
   *   · `attachmentCount: p.normalized.attachments.length` in `pipeline.ts`
   *     → `expected 3 to be 1` on the mixed message.
   *   · `hasAttachments: attachments.length > 0` in `mime.ts`
   *     → `expected true to be false` on the newsletter.
   *
   * Measured on the hosted service 2026-08-04: a large share of the flagged messages were the newsletter
   * case — a paperclip over nothing anyone could download.
   */
  it("counts only DOWNLOADABLE parts into has_attachments/attachment_count", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")
      .toString("base64");

    /** `multipart/related`: an html body that references cid: images, plus optional real files. */
    const related = (o: { messageId: string; cids: string[]; files: Array<[string, string]> }) => [
      `Message-ID: <${o.messageId}>`,
      "From: Corp <news@x.example>",
      "To: mila@lichtgrat.example",
      `Subject: ${o.messageId}`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="ATONE"',
      "",
      "--ATONE",
      "Content-Type: text/html; charset=utf-8",
      "",
      `<p>hi</p>${o.cids.map((c) => `<img src="cid:${c}">`).join("")}`,
      "",
      ...o.cids.flatMap((c) => [
        "--ATONE",
        "Content-Type: image/gif",
        `Content-ID: <${c}>`,
        "Content-Disposition: inline; filename=logo.gif",
        "Content-Transfer-Encoding: base64",
        "",
        gif,
        "",
      ]),
      ...o.files.flatMap(([name, body]) => [
        "--ATONE",
        `Content-Type: application/pdf; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(body, "utf8").toString("base64"),
        "",
      ]),
      "--ATONE--",
      "",
    ].join("\r\n");

    const c = await rawClient(h.cfg);
    // The newsletter: two embedded logos, nothing to download.
    await c.append("INBOX", related({ messageId: "at1none@x", cids: ["l1@c", "l2@c"], files: [] }));
    // The invoice: three embedded logos AND one real file.
    await c.append("INBOX", related({
      messageId: "at1mixed@x", cids: ["m1@c", "m2@c", "m3@c"],
      files: [["invoice.pdf", "%PDF-1.4"]],
    }));
    await runSyncCycle(deps);
    await c.logout();

    const [none] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "at1none@x"));
    const [mixed] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "at1mixed@x"));

    // The parts are all still CATALOGUED — the flag is a claim about downloadability, not about
    // whether the message contains images. A client still resolves `cid:` through these rows.
    const noneRows = await h.db.select().from(attachments)
      .where(eq(attachments.messageId, none!.id));
    expect(noneRows).toHaveLength(2);
    expect(noneRows.every((r) => r.inline)).toBe(true);

    // No paperclip, and no count.
    expect(none!.hasAttachments).toBe(false);
    expect(none!.attachmentCount).toBe(0);

    const mixedRows = await h.db.select().from(attachments)
      .where(eq(attachments.messageId, mixed!.id));
    expect(mixedRows).toHaveLength(4);
    expect(mixedRows.filter((r) => !r.inline)).toHaveLength(1);

    // Paperclip STAYS, and the count is the file — not the file plus three logos.
    expect(mixed!.hasAttachments).toBe(true);
    expect(mixed!.attachmentCount).toBe(1);
  }, 30000);

  it("fetches the BLOB on-demand from IMAP and never persists the bytes", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    const marker = "SECRET-BYTES-9f3c-DO-NOT-STORE";
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlWith({
      from: "anna@x.example", subject: "one file", messageId: "att2@x",
      parts: [{ filename: "note.txt", contentType: "text/plain", content: marker }],
    }));
    await runSyncCycle(deps);
    await c.logout();

    const [msg] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "att2@x"));
    const [att] = await h.db.select().from(attachments).where(eq(attachments.messageId, msg!.id));

    // GreenMail-backed openAdapter reusing the harness connection (no-op close).
    const openAdapter: OpenAdapter = async () => ({
      fetchPart: (loc, pid) => h.adapter.fetchPart(loc, pid),
      close: async () => {},
    });

    const fetched = await svc.fetchBytes(ctxFor(h), att!.id, { openAdapter });
    expect(Buffer.from(fetched.body).toString("utf8")).toBe(marker);
    expect(fetched.filename).toBe("note.txt");

    // The bytes appear in NO stored table — not the attachment row, not the body.
    expect(JSON.stringify(att)).not.toContain(marker);
    const bodies = await h.db.select().from(messageBodies).where(eq(messageBodies.messageId, msg!.id));
    for (const b of bodies) {
      expect(b.text).not.toContain(marker);
      expect(b.html ?? "").not.toContain(marker);
    }
  }, 30000);

  it("download-all zips every attachment of a message (fetched on-demand)", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlWith({
      from: "anna@x.example", subject: "two files", messageId: "att3@x",
      parts: [
        { filename: "first.txt", contentType: "text/plain", content: "FIRST-CONTENT" },
        { filename: "second.txt", contentType: "text/plain", content: "SECOND-CONTENT" },
      ],
    }));
    await runSyncCycle(deps);
    await c.logout();

    const [msg] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "att3@x"));

    const openAdapter: OpenAdapter = async () => ({
      fetchPart: (loc, pid) => h.adapter.fetchPart(loc, pid),
      close: async () => {},
    });

    const { zip, filename } = await svc.downloadAll(ctxFor(h), { messageId: msg!.id }, { openAdapter });
    expect(filename).toContain(".zip");

    // Valid zip (PK local-file-header magic) assembled from the on-demand IMAP fetch.
    // JSZip defaults to STORE (no compression), so each entry's name + content bytes
    // appear verbatim — a jszip-free e2e assertion (the jszip round-trip unzip is
    // covered by the services-level download-all test).
    expect(zip[0]).toBe(0x50); expect(zip[1]).toBe(0x4b);   // "PK"
    const raw = Buffer.from(zip).toString("latin1");
    expect(raw).toContain("first.txt");
    expect(raw).toContain("second.txt");
    expect(raw).toContain("FIRST-CONTENT");
    expect(raw).toContain("SECOND-CONTENT");
  }, 30000);
});
