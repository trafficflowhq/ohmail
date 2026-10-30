import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { mailboxes, messageBodies, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger, STORED_HTML_CAP_BYTES, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { messageIdFromRaw } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ONE MESSAGE OVER THE HTML CAP, INGESTED WITH THE PHONE'S BUFFER — the hotfix's boundary.
 *
 * The phone runs the worker's cycle with `apps/mobile`'s Buffer shim as the global, on a runtime
 * without TypedArray species. There a body cut past a size threshold was written as decimal bytes and
 * the CHECK refused it, so the folder stayed held and the mailbox never started. This drives that
 * global, species pointed at Uint8Array as the device read it, through the real cycle.
 * @reads: apps/mobile/src/engine/shims/buffer.js
 */
const NodeBuffer = globalThis.Buffer;
const PhoneBuffer = (createRequire(import.meta.url)("../../mobile/src/engine/shims/buffer.js") as { Buffer: BufferConstructor }).Buffer;
function phoneRuntime(): void {
  Object.defineProperty(PhoneBuffer, Symbol.species, { get: () => Uint8Array, configurable: true });
  (globalThis as { Buffer: unknown }).Buffer = PhoneBuffer;
}
afterEach(() => {
  (globalThis as { Buffer: unknown }).Buffer = NodeBuffer;
  delete (PhoneBuffer as unknown as Record<symbol, unknown>)[Symbol.species];
});

const ACCOUNT = "00000000-0000-4000-8000-0000000f0262";
const b64 = (s: string) => NodeBuffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
/** Built with the phone's class, as the phone's IMAP reader hands the cycle its bytes. */
const rawOf = (name: string, html: string): Buffer => PhoneBuffer.from([
  `From: Shape <s-${name}@sender.invalid>`, "To: me@example.test", `Subject: ${name}`, "Date: Wed, 30 Sep 2026 12:00:00 +0000",
  `Message-ID: <${name}@lane.invalid>`, "MIME-Version: 1.0", 'Content-Type: multipart/alternative; boundary="B"', "",
  "--B", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(`Text part of ${name}.\r\n`),
  "--B", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html), "--B--", "",
].join("\r\n"));
/** An ordinary long newsletter: a builder's table rows with inline styles, about 540 bytes a row. */
const newsletter = (rows: number): string => `<table width="600">${Array.from({ length: rows }, (_, n) =>
  `<tr><td valign="top" style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:150%;color:#333333;padding:12px 24px;border-bottom:1px solid #eeeeee"><a href="https://example.com/item/${n}" style="color:#0a66c2">Item ${n}</a><br>${"words of the row ".repeat(14)}</td><td width="120" style="padding:12px;color:#999999">Oct ${1 + (n % 28)}</td></tr>`).join("")}</table>`;

async function ingest(shapes: Array<{ name: string; html: string; raw?: Buffer }>) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: `p-${randomUUID().slice(0, 8)}@example.test` }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } });
  fleet.behave(mb!.id, { deliver: shapes.map((s) => ({ from: "x", subject: s.name, messageId: s.name, raw: s.raw ?? rawOf(s.name, s.html) })) });
  const lines: string[] = [];
  phoneRuntime();
  let thrown: unknown = null;
  try {
    await runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT, mailboxId: mb!.id,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
      log: createLogger({ service: "worker", sink: (l) => { lines.push(l); } }) });
  } catch (err) { thrown = err; } finally { (globalThis as { Buffer: unknown }).Buffer = NodeBuffer; }
  const stored = await db.select({ subject: messages.subject, html: messageBodies.html, text: messageBodies.text,
    snippet: messages.snippet, dedupKey: messages.dedupKey })
    .from(messages).innerJoin(messageBodies, eq(messageBodies.messageId, messages.id));
  const htmlBytes = Object.fromEntries(stored.map((r) => [r.subject, r.html === null ? null : NodeBuffer.byteLength(r.html, "utf8")]));
  const deferred = lines.map((l) => JSON.parse(l) as { event: string }).filter((l) => l.event === "sync_message_deferred").length;
  return { thrown, htmlBytes, deferred, stored };
}

describe("one message over the html cap, on the phone's Buffer", () => {
  it("one byte over the cap stores cut under it, and the message after it lands in the same cycle", async () => {
    const r = await ingest([
      { name: "plain-262145", html: "<p>" + "a".repeat(STORED_HTML_CAP_BYTES - 2) },
      { name: "plain-262144", html: "<p>" + "a".repeat(STORED_HTML_CAP_BYTES - 3) },
      { name: "ordinary", html: "<p>Short and plain.</p>" },
    ]);
    expect([r.thrown, r.deferred]).toEqual([null, 0]);
    expect(r.htmlBytes["plain-262145"]).toBeLessThanOrEqual(STORED_HTML_CAP_BYTES);
    expect(r.htmlBytes["plain-262145"]).toBeGreaterThan(STORED_HTML_CAP_BYTES - 200);
    expect(r.htmlBytes["plain-262144"]).toBe(STORED_HTML_CAP_BYTES);
    expect(r.htmlBytes.ordinary).toBe(23);
  }, 120_000);

  it("a 300 KB newsletter and the 450 KB message that held the device's folder both store", async () => {
    const page = newsletter(560);
    expect(NodeBuffer.byteLength(page)).toBeGreaterThan(290_000);
    const attrs = ["alt", "title", "width", "height", "align", "valign", "border", "cellpadding", "cellspacing", "bgcolor", "id", "colspan", "rowspan", "dir", "lang", "type", "start", "value", "size", "color", "face", "abbr", "headers", "scope", "span", "role", "aria-label", "aria-hidden", "datetime"];
    const noah = `<p>${Array.from({ length: 1000 }, (_, i) => `<b${attrs.map((a) => ` ${a}="v"`).join("")} class="c${i}">`).join("")}${"<p>t</p>".repeat(10)}`;
    const r = await ingest([{ name: "newsletter-300k", html: page }, { name: "noah-1000b-29attrs", html: noah }]);
    expect([r.thrown, r.deferred]).toEqual([null, 0]);
    for (const name of ["newsletter-300k", "noah-1000b-29attrs"]) {
      expect(r.htmlBytes[name], name).toBeLessThanOrEqual(STORED_HTML_CAP_BYTES);
      expect(r.htmlBytes[name], name).toBeGreaterThan(STORED_HTML_CAP_BYTES - 200);
    }
  }, 120_000);

  it("a letter of pictures with no text part stores its words, under the key it always had, once", async () => {
    const raw = PhoneBuffer.from([
      "From: Shop <news@sender.invalid>", "To: me@example.test", "Subject: pictures", "Date: Wed, 30 Sep 2026 12:00:00 +0000",
      "Message-ID: <pictures@lane.invalid>", "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="R"', "",
      "--R", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "",
      b64('<style>.a{color:red}</style><table><tr><td>Autumn</td><td>sale</td></tr></table><div>All week</div><img src="cid:p@x">'),
      "--R", "Content-Type: image/png", "Content-ID: <p@x>", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--R--", "",
    ].join("\r\n"));
    const r = await ingest([{ name: "pictures", html: "", raw }, { name: "pictures-again", html: "", raw }]);
    expect([r.thrown, r.deferred]).toEqual([null, 0]);
    // The key the code before the words computed for this letter.
    expect(r.stored.map((s) => [s.text, s.snippet, s.dedupKey])).toEqual([[
      "Autumn sale\n\nAll week", "Autumn sale All week", "fp1:201171d785a5084e7d5260c5d5a0e5aaf91aa5e38cb6357e55dbbd96f0aab2a7",
    ]]);
  }, 120_000);

  it("the Message-ID read off a raw head is Node's answer on the phone's Buffer too", () => {
    const head = "From: a@b.test\r\nMessage-ID: <sib-1@lane.invalid>\r\nSubject: s\r\n\r\nbody\r\n";
    const node = messageIdFromRaw(NodeBuffer.from(head, "latin1"));
    phoneRuntime();
    const phone = messageIdFromRaw(PhoneBuffer.from(head, "latin1") as unknown as Buffer);
    expect([node, phone]).toEqual(["sib-1@lane.invalid", "sib-1@lane.invalid"]);
  });
});
