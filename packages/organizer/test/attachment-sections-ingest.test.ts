import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { attachments, mailboxes, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger, UNMETERED_STORAGE_CAP, type MimeStructure } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * INGEST STORES THE SERVER'S SECTION, through the worker's own cycle: the create carries the
 * server's BODYSTRUCTURE, as the IMAP adapter's does, and each file's `part_id` becomes the
 * section whose decoded bytes are the file. The shape is the one mailparser 3.9.32 numbers wrong:
 * an inline 7bit message/rfc822 whose body is one png, which it stores as the rfc822's own `2`
 * where the server's section is `2.1`. Without a tree the file keeps that id and the cycle says so.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000a5ec7";
const PNG = Buffer.from("a png the sender attached to a forwarded message, padded to look like one".repeat(4));
const b64 = (b: Buffer): string => b.toString("base64").replace(/.{1,76}/g, (l) => `${l}\r\n`);
const head = (id: string): string => [
  "From: Alice <alice@example.com>", "To: Bob <bob@example.org>", `Subject: sections ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@sections.test>`, "MIME-Version: 1.0",
].join("\r\n");
const inlinePng = (id: string): Buffer => Buffer.from([
  head(id), 'Content-Type: multipart/mixed; boundary="S' + '1"', "", "--S" + "1", "Content-Type: text/plain; charset=utf-8", "",
  "see the picture", "--S1", "Content-Type: message/rfc822", "Content-Transfer-Encoding: 7bit", "Content-Disposition: inline", "",
  head(`${id}-inner`), 'Content-Type: image/png; name="pic.png"', "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="pic.png"', "", b64(PNG), "--S1--", "",
].join("\r\n"));
const node = (o: Partial<MimeStructure> & { type: string }): MimeStructure =>
  ({ encoding: null, params: {}, id: null, disposition: null, size: null, children: [], ...o });
/** What Dovecot 2.3.21 answers for that message (the section oracle's `hand-rfc822-inline-png` shape). */
const TREE: MimeStructure = node({ type: "multipart/mixed", params: { boundary: "S" + "1" }, children: [
  node({ type: "text/plain", encoding: "7bit", params: { charset: "utf-8" } }),
  node({ type: "message/rfc822", encoding: "7bit", disposition: { type: "inline", params: {} }, children: [
    node({ type: "image/png", encoding: "base64", params: { name: "pic.png" }, disposition: { type: "attachment", params: { filename: "pic.png" } } }),
  ] }),
] });

async function ingest(deliver: { raw: Buffer; structure?: MimeStructure }) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCOUNT, provider: "imap", address: `sections-${randomUUID().slice(0, 8)}@example.test`,
  }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mb!.id, { deliver: [{ from: "alice@example.com", subject: "s", messageId: `m-${randomUUID()}`, ...deliver }] });
  const raw: string[] = [];
  await runSyncCycle({
    writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT, mailboxId: mb!.id,
    storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    log: createLogger({ service: "worker", sink: (l) => { raw.push(l); } }),
  });
  const rows = await db.select({ partId: attachments.partId, filename: attachments.filename })
    .from(attachments).where(eq(attachments.accountId, ACCOUNT));
  const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "attachment_section_unmatched");
  return { rows, lines };
}

describe("ingest stores each file at the server's own section", () => {
  it("an inline rfc822's single-part body is stored as 2.1, the section the server serves it at", async () => {
    const { rows, lines } = await ingest({ raw: inlinePng("with-tree"), structure: TREE });
    expect(rows).toEqual([{ partId: "2.1", filename: "pic.png" }]);
    expect(lines).toEqual([]);
  });

  it("CONTROL: with no tree from the server the file keeps mailparser's 2, and the cycle says why", async () => {
    const { rows, lines } = await ingest({ raw: inlinePng("no-tree") });
    expect(rows).toEqual([{ partId: "2", filename: "pic.png" }]);
    expect(lines.map((l) => [l.reason, l.partId, typeof l.uid, l.droppedFields])).toEqual([["no_structure", "2", "number", undefined]]);
    expect(JSON.stringify(lines)).not.toContain("pic.png");
  });
});
