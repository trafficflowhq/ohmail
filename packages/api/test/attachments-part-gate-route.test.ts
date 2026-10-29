import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import type { MimeStructure } from "@trafficflow/core/mail";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { attachments as attachmentsTbl, mailboxCredentials } from "@trafficflow/db";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * The part gate through the route a client calls: the real `makeOpenAdapter` over the real
 * `ImapAdapter`, its `fetchPart` answering with the bytes a wrongly numbered section returns. The
 * byte routes carry the refusal in the envelope with its code and `retryable: false`.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const RIGHT = Buffer.from("the pdf the row describes");
const WRONG = Buffer.from("the zip in the next section");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function world(served: Buffer) {
  const made = await makeDeps(FIXED_NOW);
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const { id: messageId, mailboxId } = await seedMessage(made.db, { accountId: s.accountId, folder: "INBOX" });
  const enc = await made.deps.keyProvider.encrypt("imap-pass");
  await made.db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "127.0.0.1", port: 1, secure: false, user: "u@gate.example" },
  });
  const [att] = await made.db.insert(attachmentsTbl).values({
    accountId: s.accountId, messageId, filename: "a.pdf", contentType: "application/pdf",
    sizeBytes: RIGHT.byteLength, inline: false, partId: "2.2.1", contentSha256: sha(RIGHT),
  }).returning();
  vi.spyOn(ImapAdapter.prototype, "fetchPart").mockResolvedValue({
    contentType: "application/pdf", filename: null, body: new Uint8Array(served),
  });
  // A server answering no tree: the door cannot repair, so these cases read the gate alone.
  vi.spyOn(ImapAdapter.prototype, "fetchStructure").mockResolvedValue(null);
  return { ...made, s, messageId, attId: att!.id };
}

async function envelope(res: Response) {
  const body = await res.json() as { error?: { code?: string; retryable?: boolean } };
  return { status: res.status, code: body.error?.code, retryable: body.error?.retryable };
}

describe("the attachment routes refuse a part that is not the row's file", () => {
  it("GET /attachments/:id answers 409 attachment_part_mismatch, retryable false", async () => {
    const w = await world(WRONG);
    const res = await H(req("GET", `/attachments/${w.attId}`, { bearer: w.s.token }), w.deps);
    expect(await envelope(res)).toEqual({ status: 409, code: "attachment_part_mismatch", retryable: false });
  });

  it("the message's download-all answers the same refusal", async () => {
    const w = await world(WRONG);
    const res = await H(req("POST", `/messages/${w.messageId}/attachments/download-all`, { bearer: w.s.token }), w.deps);
    expect(await envelope(res)).toEqual({ status: 409, code: "attachment_part_mismatch", retryable: false });
  });

  it("serves the bytes when their sha equals the row's", async () => {
    const w = await world(RIGHT);
    const res = await H(req("GET", `/attachments/${w.attId}`, { bearer: w.s.token }), w.deps);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(RIGHT)).toBe(true);
    // Kept privately for an hour, keyed on the session as /img is: the next account signed in on
    // the same browser never takes the first one's file from the cache.
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("vary")).toBe("Cookie");
  });
});

/* An older row (stored 2.2.1) of a message whose server tree holds its pdf at 2.1. */
const leafNode = (type: string, name: string): MimeStructure => ({
  type, encoding: "base64", params: { name }, id: null, disposition: { type: "attachment", params: { filename: name } }, size: null, children: [],
});
const textNode = (sub: string): MimeStructure => ({ type: `text/${sub}`, encoding: "7bit", params: {}, id: null, disposition: null, size: null, children: [] });
const multi = (sub: string, children: MimeStructure[]): MimeStructure =>
  ({ type: `multipart/${sub}`, encoding: null, params: { boundary: `b-${sub}` }, id: null, disposition: null, size: null, children });
const SIBLINGS = multi("mixed", [multi("alternative", [textNode("plain"), textNode("html")]),
  multi("mixed", [leafNode("application/pdf", "a.pdf"), leafNode("application/zip", "b.zip")]), leafNode("image/png", "c.png")]);
const JSZip = createRequire(new URL("../../services/package.json", import.meta.url))("jszip") as {
  loadAsync(b: Uint8Array): Promise<{ files: Record<string, unknown>; file(n: string): { async(t: "uint8array"): Promise<Uint8Array> } | null }>;
};

async function repairWorld() {
  const w = await world(WRONG);
  vi.spyOn(ImapAdapter.prototype, "fetchPart").mockImplementation(async (_l, partId) => ({
    contentType: "application/pdf", filename: null, body: new Uint8Array(partId === "2.1" ? RIGHT : WRONG),
  }));
  vi.spyOn(ImapAdapter.prototype, "fetchStructure").mockResolvedValue(SIBLINGS);
  const partId = async () => (await w.db.select({ p: attachmentsTbl.partId }).from(attachmentsTbl).where(eq(attachmentsTbl.id, w.attId)))[0]!.p;
  return { ...w, partId };
}

describe("the attachment routes repair an older row through the real door", () => {
  it("GET /attachments/:id serves the file and rewrites the row", async () => {
    const w = await repairWorld();
    const res = await H(req("GET", `/attachments/${w.attId}`, { bearer: w.s.token }), w.deps);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(RIGHT)).toBe(true);
    expect(await w.partId()).toBe("2.1");
  });

  it("the message's download-all repairs inside the archive: the zip opener forwards the tree read", async () => {
    const w = await repairWorld();
    const res = await H(req("POST", `/messages/${w.messageId}/attachments/download-all`, { bearer: w.s.token }), w.deps);
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(zip.files)).toEqual(["a.pdf"]);
    expect(Buffer.from(await zip.file("a.pdf")!.async("uint8array")).equals(RIGHT)).toBe(true);
    expect(await w.partId()).toBe("2.1");
  });
});
