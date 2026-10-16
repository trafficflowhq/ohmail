import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { attachments as attachmentsTbl, drafts, outboundSends } from "@trafficflow/db";
import { createLogger, type Logger, type MimeStructure, type OutboundMessage, type SendAdapter } from "@trafficflow/core/mail";
import { MessageGoneError } from "@trafficflow/core/adapters/imap";
import {
  AttachmentsService, readerFor, repairedPart, type AttachmentAdapter, type OpenAdapter,
} from "../src/attachments-service.js";
import { sendService } from "../src/send-service.js";
import { ServiceError } from "../src/errors.js";
import { makeCtx, otherAccount, seedMessage } from "./helpers.js";
import { FIXED_NOW, makeDeps, seedMailbox, seedMessage as seedApiMessage, seedSession, seedBody } from "../../api/test/helpers.js";

/**
 * THE PART GATE: a stored `part_id` 3.9.18 numbered wrong fetches another part's bytes, and the row's
 * `content_sha256` is what tells them apart. Driven through the download, the zip and the forward
 * with a fake adapter that serves the bytes a wrong section would: a mismatch refuses by name before
 * any byte leaves, an equal sha serves, a null sha serves and says so.
 */

const svc = new AttachmentsService();
const RIGHT = new Uint8Array(Buffer.from("the pdf the row describes"));
const WRONG = new Uint8Array(Buffer.from("the zip in the next section"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A logger whose lines are read back as objects, through the real census. */
function capturingLog(): { log: Logger; lines: () => Array<Record<string, unknown>> } {
  const raw: string[] = [];
  const log = createLogger({ service: "attachments", sink: (line) => { raw.push(line); } });
  return { log, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function adapterServing(bodies: Record<string, Uint8Array>) {
  const state = { closed: 0, asked: [] as string[] };
  const openAdapter: OpenAdapter = async (): Promise<AttachmentAdapter> => ({
    fetchPart: async (_l, partId) => {
      state.asked.push(partId ?? "1");
      return { contentType: "application/pdf", filename: null, body: bodies[partId ?? "1"] ?? new Uint8Array() };
    },
    close: async () => { state.closed += 1; },
  });
  return { openAdapter, state };
}

async function seedRow(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string, messageId: string,
  partId: string, contentSha256: string | null, filename = "a.pdf",
): Promise<string> {
  const [row] = await db.insert(attachmentsTbl).values({
    accountId, messageId, filename, contentType: "application/pdf",
    sizeBytes: RIGHT.byteLength, inline: false, partId, contentSha256,
  }).returning();
  return row!.id;
}

describe("the download door serves the row's file or refuses", () => {
  it("refuses bytes of another sha with 409 attachment_part_mismatch, naming the row, never the file", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "2.2.1", sha(RIGHT));
    const { openAdapter, state } = adapterServing({ "2.2.1": WRONG });
    const cap = capturingLog();

    const err = await svc.fetchBytes(ctx, id, { openAdapter, log: cap.log }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    const se = err as ServiceError;
    expect([se.code, se.httpStatus, se.retryable]).toEqual(["attachment_part_mismatch", 409, false]);
    expect(se.details).toEqual({
      attachmentId: id, partId: "2.2.1", storedSha: sha(RIGHT).slice(0, 8), servedSha: sha(WRONG).slice(0, 8),
    });
    expect(se.message).not.toContain("a.pdf");
    expect(state.closed).toBe(1);
    // An adapter with no tree to read cannot repair: that is said once, then the gate refuses.
    const [unrepairable, line] = cap.lines();
    expect(unrepairable).toMatchObject({ event: "attachment_part_unrepairable", partRowId: id, reason: "no_structure", tried: 0 });
    expect(line).toMatchObject({
      event: "attachment_part_mismatch", partRowId: id, partId: "2.2.1",
      storedSha: sha(RIGHT).slice(0, 8), servedSha: sha(WRONG).slice(0, 8),
    });
    expect(line!.droppedFields).toBeUndefined();
    expect(JSON.stringify(cap.lines())).not.toContain("a.pdf");
  });

  it("serves bytes whose sha equals the row's", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "2.1", sha(RIGHT));
    const { openAdapter } = adapterServing({ "2.1": RIGHT });
    const cap = capturingLog();

    const got = await svc.fetchBytes(ctx, id, { openAdapter, log: cap.log });

    expect(Buffer.from(got.body).equals(Buffer.from(RIGHT))).toBe(true);
    expect(got.filename).toBe("a.pdf");
    expect(cap.lines()).toEqual([]);
  });

  it("serves a row with no sha and logs attachment_part_unverified with ids only", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "3", null);
    const { openAdapter } = adapterServing({ "3": WRONG });
    const cap = capturingLog();

    const got = await svc.fetchBytes(ctx, id, { openAdapter, log: cap.log });

    expect(got.body.byteLength).toBe(WRONG.byteLength);
    const [line] = cap.lines();
    expect(line).toMatchObject({ event: "attachment_part_unverified", partRowId: id, partId: "3" });
    expect(line!.droppedFields).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("a.pdf");
  });
});

describe("the zip refuses whole when one part is not the row's file", () => {
  it("refuses the archive with 409, naming the mismatched row", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedRow(db, accountId, messageId, "2", sha(RIGHT), "ok.pdf");
    const bad = await seedRow(db, accountId, messageId, "2.2.1", sha(RIGHT), "a.pdf");
    const { openAdapter, state } = adapterServing({ "2": RIGHT, "2.2.1": WRONG });

    const err = await svc.downloadAll(ctx, { messageId }, { openAdapter, log: capturingLog().log })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("attachment_part_mismatch");
    expect((err as ServiceError).httpStatus).toBe(409);
    expect(((err as ServiceError).details as { attachmentId: string }).attachmentId).toBe(bad);
    expect(state.closed).toBe(1);
  });

  it("builds the archive when every part is the row's file", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedRow(db, accountId, messageId, "2", sha(RIGHT), "ok.pdf");
    const { openAdapter } = adapterServing({ "2": RIGHT });

    const res = await svc.downloadAll(ctx, { messageId }, { openAdapter, log: capturingLog().log });

    const zip = await JSZip.loadAsync(res.zip);
    expect(Object.keys(zip.files)).toEqual(["ok.pdf"]);
  });
});

describe("the forward refuses before any SMTP write", () => {
  async function forwardWorld(contentSha256: string | null) {
    const { db } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "me@atelier.example" });
    const orig = await seedApiMessage(db, {
      accountId: s.accountId, mailboxId, subject: "Q3 plan", fromAddress: "lena@atelier.example",
      date: FIXED_NOW, nativeLocator: { folder: "INBOX", ref: "42:7" },
    });
    await seedBody(db, { messageId: orig.id, text: "Here is the plan.", html: null });
    await db.insert(attachmentsTbl).values({
      accountId: s.accountId, messageId: orig.id, filename: "a.pdf", contentType: "application/pdf",
      sizeBytes: RIGHT.byteLength, partId: "2.2.1", inline: false, contentSha256,
    });
    const [draft] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "Fwd: Q3 plan", body: "Passing this along.",
      to: [{ name: null, address: "sam@example.test" }], cc: [], bcc: [], status: "draft",
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).returning();
    const ctx = { db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "part-gate" };
    const delivered: OutboundMessage[] = [];
    const openSendAdapter = async (): Promise<SendAdapter> => ({
      async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
      async messageInSent() { return false; },
      async close() { /* nothing */ },
    });
    return { db, ctx, draftId: draft!.id, originalId: orig.id, delivered, openSendAdapter };
  }

  it("refuses a forward whose streamed part is another part's bytes, and sends nothing", async () => {
    const w = await forwardWorld(sha(RIGHT));
    const { openAdapter } = adapterServing({ "2.2.1": WRONG });

    const err = await sendService.send(
      w.ctx, w.draftId, "gate-key-1", { openSendAdapter: w.openSendAdapter, openFetchAdapter: openAdapter, log: capturingLog().log },
      { forwardOf: w.originalId },
    ).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect([(err as ServiceError).code, (err as ServiceError).httpStatus]).toEqual(["attachment_part_mismatch", 409]);
    expect((err as ServiceError).message).toContain("Nothing was sent");
    expect(w.delivered).toEqual([]);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
  });

  it("repairs an older row before any SMTP write: the recipient gets the file, the row its section", async () => {
    const w = await forwardWorld(sha(RIGHT));
    const { openAdapter } = treeServing(SIBLINGS, { "2.2.1": WRONG, "2.1": RIGHT });

    const res = await sendService.send(
      w.ctx, w.draftId, "gate-key-3", { openSendAdapter: w.openSendAdapter, openFetchAdapter: openAdapter, log: capturingLog().log },
      { forwardOf: w.originalId },
    );

    expect(res.status).toBe("sent");
    expect(sha(w.delivered[0]!.attachments![0]!.content as Uint8Array)).toBe(sha(RIGHT));
    const [row] = await w.db.select({ p: attachmentsTbl.partId }).from(attachmentsTbl).where(eq(attachmentsTbl.messageId, w.originalId));
    expect(row!.p).toBe("2.1");
  });

  it("forwards the part when its sha equals the row's", async () => {
    const w = await forwardWorld(sha(RIGHT));
    const { openAdapter } = adapterServing({ "2.2.1": RIGHT });

    const res = await sendService.send(
      w.ctx, w.draftId, "gate-key-2", { openSendAdapter: w.openSendAdapter, openFetchAdapter: openAdapter, log: capturingLog().log },
      { forwardOf: w.originalId },
    );

    expect(res.status).toBe("sent");
    expect(w.delivered).toHaveLength(1);
    expect(Buffer.from(w.delivered[0]!.attachments![0]!.content as Uint8Array).equals(Buffer.from(RIGHT))).toBe(true);
  });
});

/* ── THE REPAIR: an older row whose section does not hold its file is corrected at first use ─── */

const leafNode = (type: string, name: string | null = null): MimeStructure => ({
  type, encoding: "base64", params: name ? { name } : {}, id: null,
  disposition: name ? { type: "attachment", params: { filename: name } } : null, size: null, children: [],
});
const text = (sub: string): MimeStructure => ({ ...leafNode(`text/${sub}`), encoding: "7bit" });
const multi = (sub: string, children: MimeStructure[]): MimeStructure =>
  ({ type: `multipart/${sub}`, encoding: null, params: { boundary: `b-${sub}` }, id: null, disposition: null, size: null, children });
/** 3.9.18 numbered the pdf after a sibling multipart one level too deep: stored 2.2.1, the server's 2.1. */
const SIBLINGS = multi("mixed", [multi("alternative", [text("plain"), text("html")]), multi("mixed", [leafNode("application/pdf", "a.pdf"), leafNode("application/zip", "b.zip")]), leafNode("image/png", "c.png")]);
/** 3.9.32 stored an inline rfc822's single-part body as the rfc822's own section: stored 2, the server's 2.1. */
const EMBEDDED = multi("mixed", [text("plain"), { type: "message/rfc822", encoding: "7bit", params: {}, id: null,
  disposition: { type: "inline", params: {} }, size: null, children: [leafNode("application/pdf", "a.pdf")] }]);

function treeServing(structure: MimeStructure | null | "no-method", bodies: Record<string, Uint8Array>, gone: string[] = []) {
  const state = { asked: [] as string[], structures: 0, closed: 0 };
  const openAdapter: OpenAdapter = async (): Promise<AttachmentAdapter> => ({
    fetchPart: async (locator, partId) => {
      const section = partId ?? "1";
      state.asked.push(section);
      if (gone.includes(section)) throw new MessageGoneError(locator);
      return { contentType: "application/pdf", filename: null, body: bodies[section] ?? new Uint8Array() };
    },
    ...(structure === "no-method" ? {} : { fetchStructure: async () => { state.structures += 1; return structure; } }),
    close: async () => { state.closed += 1; },
  });
  return { openAdapter, state };
}
const partIdOf = async (db: Awaited<ReturnType<typeof makeCtx>>["db"], id: string): Promise<string | null> =>
  (await db.select({ p: attachmentsTbl.partId }).from(attachmentsTbl).where(eq(attachmentsTbl.id, id)))[0]!.p;

describe("the streamed save holds only the section it serves", () => {
  /* `fetchToSink` streams each read into the sink; a repair reads a second section after the
     first. Without the reset between reads the file would hold both, with the right size and sha
     reported. Driven with and without a streaming adapter, through the same repair. */
  it.each([false, true])("streaming adapter: %s — the sink holds the repaired section alone", async (streams) => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "2.2.1", sha(RIGHT));
    const { openAdapter } = treeServing(SIBLINGS, { "2.2.1": WRONG, "2.1": RIGHT });
    const streaming: OpenAdapter = async (mailboxId) => {
      const a = await openAdapter(mailboxId);
      if (!streams) return a;
      return { ...a, fetchPartTo: async (l, partId, sink, o) => {
        const got = await a.fetchPart(l, partId, o);
        for (let at = 0; at < got.body.byteLength; at += 5) await sink(got.body.subarray(at, at + 5));
        return { contentType: got.contentType, filename: got.filename, bytes: got.body.byteLength, sha256: sha(got.body) };
      } };
    };
    let held: number[] = [];
    const sink = { write: async (c: Uint8Array) => { held.push(...c); }, reset: async () => { held = []; } };

    const saved = await svc.fetchToSink(ctx, id, { openAdapter: streaming, log: capturingLog().log }, sink);

    expect(Buffer.from(held).equals(Buffer.from(RIGHT))).toBe(true);
    expect([saved.bytes, saved.sha256]).toEqual([RIGHT.byteLength, sha(RIGHT)]);
  });
});

describe("the door repairs an older row's section at first use", () => {
  it.each([
    ["3.9.18", SIBLINGS, "2.2.1", "2.1"],
    ["3.9.32", EMBEDDED, "2", "2.1"],
  ] as const)("a %s-stored id: the file is served, the row rewritten, and the second press direct", async (_v, tree, stored, section) => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, stored, sha(RIGHT));
    const { openAdapter, state } = treeServing(tree, { [stored]: WRONG, [section]: RIGHT });
    const cap = capturingLog();

    const got = await svc.fetchBytes(ctx, id, { openAdapter, log: cap.log });

    expect(sha(got.body)).toBe(sha(RIGHT));
    expect(await partIdOf(db, id)).toBe(section);
    expect(cap.lines().map((l) => [l.event, l.section, l.tried, l.healed])).toEqual([["attachment_part_repaired", section, 1, true]]);
    expect(cap.lines()[0]).toMatchObject({ partRowId: id, partId: stored });
    expect(JSON.stringify(cap.lines())).not.toContain("a.pdf");
    expect([state.asked, state.structures]).toEqual([[stored, section], 1]);

    const again = treeServing(tree, { [section]: RIGHT });
    const second = capturingLog();
    expect(sha((await svc.fetchBytes(ctx, id, { openAdapter: again.openAdapter, log: second.log })).body)).toBe(sha(RIGHT));
    expect([again.state.asked, again.state.structures, second.lines()]).toEqual([[section], 0, []]);
  });

  it("the zip repairs the row inside the archive and holds the file", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "2.2.1", sha(RIGHT), "a.pdf");
    const { openAdapter } = treeServing(SIBLINGS, { "2.2.1": WRONG, "2.1": RIGHT });

    const res = await svc.downloadAll(ctx, { messageId }, { openAdapter, log: capturingLog().log });

    const zip = await JSZip.loadAsync(res.zip);
    expect(Object.keys(zip.files)).toEqual(["a.pdf"]);
    expect(sha(await zip.file("a.pdf")!.async("uint8array"))).toBe(sha(RIGHT));
    expect(await partIdOf(db, id)).toBe("2.1");
  });

  it("a server that answers no tree cannot repair: 409, said as no_structure, the row untouched", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "2.2.1", sha(RIGHT));
    const { openAdapter } = treeServing(null, { "2.2.1": WRONG, "2.1": RIGHT });
    const cap = capturingLog();

    const err = await svc.fetchBytes(ctx, id, { openAdapter, log: cap.log }).catch((e: unknown) => e);

    expect((err as ServiceError).code).toBe("attachment_part_mismatch");
    expect(cap.lines().map((l) => [l.event, l.reason])).toEqual([["attachment_part_unrepairable", "no_structure"], ["attachment_part_mismatch", undefined]]);
    expect(await partIdOf(db, id)).toBe("2.2.1");
  });

  it("THE CAP: three candidate downloads per row, and a fourth is never asked", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "9", sha(RIGHT), "a.pdf");
    const tree = multi("mixed", [1, 2, 3, 4].map(() => leafNode("application/pdf", "a.pdf")));
    const { openAdapter, state } = treeServing(tree, { "1": WRONG, "2": WRONG, "3": WRONG, "4": RIGHT });
    const cap = capturingLog();

    const err = await svc.fetchBytes(ctx, id, { openAdapter, log: cap.log }).catch((e: unknown) => e);

    expect((err as ServiceError).code).toBe("attachment_part_mismatch");
    expect(state.asked).toEqual(["9", "1", "2", "3"]);
    expect(cap.lines()[0]).toMatchObject({ event: "attachment_part_unrepairable", reason: "capped", tried: 3 });
  });

  it("THE REQUEST CAP: an archive repairs ten rows, and the eleventh mismatch refuses it whole, named", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const names = Array.from({ length: 11 }, (_, i) => `f${i + 1}.pdf`);
    const files = names.map((n) => new Uint8Array(Buffer.from(`file ${n}`)));
    const ids: string[] = [];
    for (const [i, n] of names.entries()) ids.push(await seedRow(db, accountId, messageId, "99", sha(files[i]!), n));
    const tree = multi("mixed", names.map((n) => leafNode("application/pdf", n)));
    const { openAdapter } = treeServing(tree, Object.fromEntries(files.map((f, i) => [String(i + 1), f])));
    const cap = capturingLog();

    const err = await svc.downloadAll(ctx, { messageId }, { openAdapter, log: cap.log }).catch((e: unknown) => e);

    const last = [...ids].sort().at(-1)!;
    expect((err as ServiceError).code).toBe("attachment_part_mismatch");
    expect(((err as ServiceError).details as { attachmentId: string }).attachmentId).toBe(last);
    expect(cap.lines().filter((l) => l.event === "attachment_part_repaired")).toHaveLength(10);
    expect(cap.lines().find((l) => l.event === "attachment_part_unrepairable")).toMatchObject({ partRowId: last, reason: "request_cap" });
    expect(await partIdOf(db, last)).toBe("99");
  });

  it("a section the server answers as gone, on a message it still has, is the same repair", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedRow(db, accountId, messageId, "2.2.1", sha(RIGHT));
    const { openAdapter, state } = treeServing(SIBLINGS, { "2.1": RIGHT }, ["2.2.1"]);

    expect(sha((await svc.fetchBytes(ctx, id, { openAdapter, log: capturingLog().log })).body)).toBe(sha(RIGHT));
    expect([state.asked, state.structures, await partIdOf(db, id)]).toEqual([["2.2.1", "2.1"], 1, "2.1"]);
  });

  it("a message the server no longer has stays a 404 the next sync heals, and a row with no sha never asks the tree", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const withSha = await seedRow(db, accountId, messageId, "2", sha(RIGHT));
    const noSha = await seedRow(db, accountId, messageId, "3", null);
    const gone = treeServing(null, {}, ["2", "3"]);

    const e1 = await svc.fetchBytes(ctx, withSha, { openAdapter: gone.openAdapter, log: capturingLog().log }).catch((e: unknown) => e);
    const e2 = await svc.fetchBytes(ctx, noSha, { openAdapter: gone.openAdapter, log: capturingLog().log }).catch((e: unknown) => e);

    expect([(e1 as ServiceError).code, (e1 as ServiceError).retryable, (e2 as ServiceError).code]).toEqual(["not_found", true, "not_found"]);
    expect(gone.state.structures).toBe(1);
  });

  it("the write is this account's: another account's row keeps its section, and the write says it did not land", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const theirs = await otherAccount(db);
    const theirMessage = await seedMessage(db, theirs.accountId, theirs.mailboxId);
    const theirRow = await seedRow(db, theirs.accountId, theirMessage, "2.2.1", sha(RIGHT));
    void accountId; void mailboxId;
    const { openAdapter } = treeServing(SIBLINGS, { "2.2.1": WRONG, "2.1": RIGHT });
    const adapter = await openAdapter("ignored");
    const cap = capturingLog();

    const row = { id: theirRow, partId: "2.2.1", contentSha256: sha(RIGHT), contentType: "application/pdf", filename: "a.pdf" };
    await repairedPart(row, readerFor(adapter, { folder: "INBOX", ref: "1:1" }), ctx, { log: cap.log });

    expect(cap.lines()[0]).toMatchObject({ event: "attachment_part_repaired", healed: false });
    expect(await partIdOf(db, theirRow)).toBe("2.2.1");
  });
});
