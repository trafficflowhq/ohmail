import { describe, expect, it } from "vitest";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange, commitChange, recordSentMessage, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import type { Change } from "@trafficflow/core";
import { outboundToMail } from "@trafficflow/core/adapters/imap";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { AttachmentsService } from "../src/attachments-service.js";
import { materializeMessage } from "../src/dto/materialize.js";
import type { ServiceContext } from "../src/index.js";
import { makeCtx, otherAccount } from "./helpers.js";

/**
 * FIX-025: a plain-text message with a file showed no file on the desktops. The
 * ingest half, measured: the three shapes the tester sent go through the real ingest into the
 * real schema, and `GET /messages/:id/attachments`'s own read lists every file with its name,
 * type and size. Green at the base too: the rows were never missing, the client never asked
 * for them (`apps/webapp/test/every-file-is-shown.test.tsx` is the red half).
 */

const B = "FIX025MIXED";
const R = "FIX025RELATED";
const A = "FIX025ALT";

function plainWithFile(id: string, contentType: string, filename: string, bytes: Buffer): Buffer {
  return Buffer.from([
    `Message-ID: <${id}@example.test>`, "From: B <b@example.test>", "To: C <c@example.test>",
    `Subject: ${id}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${B}"`, "",
    `--${B}`, "Content-Type: text/plain; charset=utf-8", "", "Here is the file you asked for.", "",
    `--${B}`, `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`, "Content-Transfer-Encoding: base64", "",
    bytes.toString("base64"), `--${B}--`, "",
  ].join("\r\n"));
}

/** The control: an html part painting an inline picture, and two files beside it. */
function htmlWithPictureAndFiles(id: string): Buffer {
  return Buffer.from([
    `Message-ID: <${id}@example.test>`, "From: B <b@example.test>", "To: C <c@example.test>",
    `Subject: ${id}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${B}"`, "",
    `--${B}`, `Content-Type: multipart/related; boundary="${R}"`, "",
    `--${R}`, `Content-Type: multipart/alternative; boundary="${A}"`, "",
    `--${A}`, "Content-Type: text/plain; charset=utf-8", "", "See attached.", "",
    `--${A}`, "Content-Type: text/html; charset=utf-8", "",
    '<html><body><p>See attached.</p><img src="cid:logo1@example.test"></body></html>', "",
    `--${A}--`, "",
    `--${R}`, 'Content-Type: image/png; name="logo.png"', "Content-ID: <logo1@example.test>",
    "Content-Disposition: inline; filename=\"logo.png\"", "Content-Transfer-Encoding: base64", "",
    Buffer.alloc(900, 7).toString("base64"), `--${R}--`, "",
    `--${B}`, 'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"', "Content-Transfer-Encoding: base64", "",
    Buffer.alloc(2000, 3).toString("base64"),
    `--${B}`, 'Content-Type: text/plain; name="terms.txt"',
    'Content-Disposition: attachment; filename="terms.txt"', "Content-Transfer-Encoding: base64", "",
    Buffer.alloc(300, 0x61).toString("base64"), `--${B}--`, "",
  ].join("\r\n"));
}

const SHAPES: Array<{ id: string; raw: Buffer; files: Array<Record<string, unknown>>; count: number }> = [
  {
    id: "w6-text-file", raw: plainWithFile("w6-text-file", "text/plain", "notes.txt", Buffer.alloc(39, 0x61)),
    files: [{ filename: "notes.txt", contentType: "text/plain", sizeBytes: 39, inline: false }], count: 1,
  },
  {
    id: "w7-png", raw: plainWithFile("w7-png", "image/png", "scan.png", Buffer.alloc(1485, 1)),
    files: [{ filename: "scan.png", contentType: "image/png", sizeBytes: 1485, inline: false }], count: 1,
  },
  {
    id: "html-control", raw: htmlWithPictureAndFiles("html-control"),
    files: [
      { filename: "logo.png", contentType: "image/png", sizeBytes: 900, inline: true, contentId: "logo1@example.test" },
      { filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 2000, inline: false },
      { filename: "terms.txt", contentType: "text/plain", sizeBytes: 300, inline: false },
    ],
    count: 2,
  },
];

describe("every file the server marks is listed by the route's own read, whatever the body", () => {
  for (const shape of SHAPES) {
    it(`${shape.id}: ingested and listed with name, type and size`, async () => {
      const { db, accountId, mailboxId, ctx } = await makeCtx();
      const repo = makeDrizzleRepo(db);
      const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:427" }, raw: shape.raw };
      const plan = await planChange(change, { repo, accountId, mailboxId, routing: repo, readerMode: false });
      const { messageId } = await repo.transaction((tx) =>
        commitChange(plan, { repo: tx, routing: tx, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP }));

      const dto = await materializeMessage(db, accountId, messageId);
      expect(dto!.hasAttachments, "the paperclip").toBe(true);
      expect(dto!.attachmentCount).toBe(shape.count);

      const items = await new AttachmentsService().listForMessage(ctx, messageId);
      const byName = [...items].sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
      const want = [...shape.files].sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
      expect(byName).toHaveLength(want.length);
      byName.forEach((item, i) => expect(item).toMatchObject(want[i]!));
    }, 30_000);
  }
});

/**
 * A report (2026-09-27): a user's own sent invoice, plain text and one PDF, opened from
 * Search with no file. The store half of that case, both ways a Sent copy reaches the store: the
 * Sent-folder ingest (sent from another client) and record-at-send over the bytes the send
 * appended. Both list the PDF as a file, so the defect was the client's ask.
 */
describe("the account's own sent invoice lists its PDF as a file", () => {
  const OWN = "walker@example.test";
  const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4_000, 0x20)]);

  async function account() {
    const { db } = await makeCtx();
    const { accountId, mailboxId } = await otherAccount(db, OWN);
    const ctx: ServiceContext = { db, accountId, userId: null, now: () => new Date("2026-09-27T12:00:00Z"), requestId: "r" };
    return { db, accountId, mailboxId, ctx, repo: makeDrizzleRepo(db) };
  }
  async function expectTheInvoice(a: Awaited<ReturnType<typeof account>>, messageId: string): Promise<void> {
    const dto = await materializeMessage(a.db, a.accountId, messageId);
    expect(dto!.folder).toBe("Sent");
    expect(dto!.hasAttachments, "the paperclip").toBe(true);
    expect(dto!.attachmentCount).toBe(1);
    const items = await new AttachmentsService().listForMessage(a.ctx, messageId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ filename: "Rechnung.pdf", contentType: "application/pdf", sizeBytes: PDF.length, inline: false });
  }

  it("sent from another mail client, read out of Sent by the ordinary ingest", async () => {
    const a = await account();
    const raw = Buffer.from([
      "Message-ID: <rechnung-0901@example.test>", `From: Walker <${OWN}>`, "To: Kunde <kunde@example.test>",
      "Subject: Rechnung September", "Date: Tue, 01 Sep 2026 08:00:00 +0200", "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${B}"`, "",
      `--${B}`, "Content-Type: text/plain; charset=utf-8", "", "Anbei die Rechnung.", "",
      `--${B}`, 'Content-Type: application/pdf; name="Rechnung.pdf"',
      'Content-Disposition: attachment; filename="Rechnung.pdf"', "Content-Transfer-Encoding: base64", "",
      PDF.toString("base64"), `--${B}--`, "",
    ].join("\r\n"));
    const change: Change = { type: "create", locator: { folder: "Sent", ref: "5:88" }, raw, seen: true, ownAuthored: true };
    const plan = await planChange(change, { repo: a.repo, accountId: a.accountId, mailboxId: a.mailboxId, readerMode: false });
    const { messageId } = await a.repo.transaction((tx) =>
      commitChange(plan, { repo: tx, routing: tx, accountId: a.accountId, mailboxId: a.mailboxId, storageCap: UNMETERED_STORAGE_CAP }));
    await expectTheInvoice(a, messageId);
  }, 30_000);

  it("sent from ohmail, projected from the bytes the send appended (record-at-send)", async () => {
    const a = await account();
    const mail = outboundToMail({
      from: OWN, to: ["kunde@example.test"], subject: "Rechnung September", text: "Anbei die Rechnung.",
      attachments: [{ filename: "Rechnung.pdf", contentType: "application/pdf", content: PDF }],
    } as unknown as Parameters<typeof outboundToMail>[0], "<rechnung-0901-sent@example.test>", new Date());
    const raw = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer(mail).compile().build((err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out)));
    });
    const result = await recordSentMessage({ locator: { folder: "Sent", ref: "5:89" }, raw }, {
      accountId: a.accountId, mailboxId: a.mailboxId, storageCap: UNMETERED_STORAGE_CAP, repo: a.repo,
      withTx: (run) => a.repo.transaction((tx) => run(tx)),
    });
    expect(result.outcome).toBe("new");
    await expectTheInvoice(a, result.messageId);
  }, 30_000);
});
