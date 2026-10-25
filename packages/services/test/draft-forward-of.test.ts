/**
 * A DRAFT KEEPS THE MESSAGE IT FORWARDS. The forward rode the send request alone, so a
 * forward kept as a draft and sent later left as a plain mail with "Fwd:" on it. The row names the
 * original now: the doors that write it, the schedule that refuses it, and the send that falls back
 * to it when the request names none — through the same no_forward gate and the same quote.
 */
import { describe, expect, it } from "vitest";
import { attachments, drafts, messages, outboundSends } from "@trafficflow/db";
import { eq, sql } from "drizzle-orm";
import { draftsService, scheduleService, sendService } from "@trafficflow/services/mail";
import type { ServiceContext, AttachmentAdapter, OpenAdapter } from "@trafficflow/services/mail";
import type { SendAdapter, OutboundMessage } from "@trafficflow/core/mail";
import { FIXED_NOW, makeDeps, seedMailbox, seedMessage, seedSession, seedBody } from "../../api/test/helpers.js";

function sendSpy() {
  const delivered: OutboundMessage[] = [];
  const openSendAdapter = async (): Promise<SendAdapter> => ({
    async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
    async messageInSent() { return false; },
    async close() { /* nothing */ },
  });
  return { delivered, openSendAdapter };
}

function fetchSpy(parts: Record<string, Uint8Array>): { openFetchAdapter: OpenAdapter; asked: string[] } {
  const asked: string[] = [];
  const openFetchAdapter: OpenAdapter = async (): Promise<AttachmentAdapter> => ({
    async fetchPart(_loc, partId) {
      const key = partId ?? "1";
      asked.push(key);
      return { contentType: "application/pdf", filename: `part-${key}.pdf`, body: parts[key] ?? new Uint8Array() };
    },
    async close() { /* nothing */ },
  });
  return { openFetchAdapter, asked };
}

async function world(opts: { noForward?: boolean } = {}) {
  const { db } = await makeDeps(FIXED_NOW);
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "me@atelier.example" });
  const orig = await seedMessage(db, {
    accountId: s.accountId, mailboxId, subject: "Q3 plan", fromAddress: "lena@atelier.example",
    date: FIXED_NOW, nativeLocator: { folder: "INBOX", ref: "42:7" },
  });
  await seedBody(db, { messageId: orig.id, text: "Here is the plan.", html: null });
  if (opts.noForward) await db.update(messages).set({ noForward: true }).where(eq(messages.id, orig.id));
  await db.insert(attachments).values({
    accountId: s.accountId, messageId: orig.id, filename: "plan.pdf",
    contentType: "application/pdf", sizeBytes: 4, partId: "2", inline: false,
  });
  const other = await seedMessage(db, { accountId: s.accountId, mailboxId, subject: "Another" });
  const ctx: ServiceContext = { db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "test-fwd-row" };
  return { db, ctx, mailboxId, originalId: orig.id, otherId: other.id, accountId: s.accountId };
}

const forwardDraft = async (w: Awaited<ReturnType<typeof world>>) =>
  (await draftsService.create(w.ctx, {
    mailboxId: w.mailboxId, forwardOfMessageId: w.originalId, subject: "Fwd: Q3 plan",
    body: "Passing this along.", to: [{ name: null, address: "sam@example.test" }],
  })).draft;

describe("the doors write the forward", () => {
  it("a create carries it, the DTO says it, and the row holds it", async () => {
    const w = await world();
    const d = await forwardDraft(w);
    expect(d.forwardOfMessageId).toBe(w.originalId);
    expect(d.inReplyToMessageId).toBeNull();
    const [row] = await w.db.select().from(drafts).where(eq(drafts.id, d.id));
    expect(row!.forwardOfMessageId).toBe(w.originalId);
  });

  it("answering and forwarding at once is refused by name, on create and on a patch over the other half", async () => {
    const w = await world();
    const both = await draftsService.create(w.ctx, {
      mailboxId: w.mailboxId, inReplyToMessageId: w.otherId, forwardOfMessageId: w.originalId,
      subject: "x", body: "y", to: [],
    }).catch((e: unknown) => e as { httpStatus?: number; message?: string });
    expect((both as { httpStatus?: number }).httpStatus).toBe(400);
    expect((both as { message?: string }).message).toMatch(/answers a message or forwards one/);

    const reply = (await draftsService.create(w.ctx, {
      mailboxId: w.mailboxId, inReplyToMessageId: w.otherId, subject: "Re: Another", body: "y", to: [],
    })).draft;
    const patched = await draftsService.update(w.ctx, reply.id, { forwardOfMessageId: w.originalId })
      .catch((e: unknown) => e as { httpStatus?: number });
    expect((patched as { httpStatus?: number }).httpStatus, "the pair reached the CHECK and answered its 500").toBe(400);
  });

  it("a patch of null clears it; another account's message is not a forward target", async () => {
    const w = await world();
    const d = await forwardDraft(w);
    const cleared = (await draftsService.update(w.ctx, d.id, { forwardOfMessageId: null })).draft;
    expect(cleared.forwardOfMessageId).toBeNull();
    const foreign = await draftsService.update(w.ctx, d.id, { forwardOfMessageId: "00000000-0000-4000-8000-00000000abcd" })
      .catch((e: unknown) => e as { httpStatus?: number; message?: string });
    expect((foreign as { httpStatus?: number }).httpStatus).toBe(404);
    expect((foreign as { message?: string }).message).toMatch(/forwarded message not found/);
  });

  it("a forward is not scheduled", async () => {
    const w = await world();
    const d = await forwardDraft(w);
    const at = new Date(FIXED_NOW.getTime() + 3_600_000).toISOString();
    const refused = await scheduleService.schedule(w.ctx, d.id, at)
      .catch((e: unknown) => e as { httpStatus?: number; code?: string });
    expect((refused as { httpStatus?: number }).httpStatus).toBe(409);
    expect((refused as { code?: string }).code).toBe("forward_not_schedulable");
  });

  it("the database refuses a row that both answers and forwards, whatever the writer", async () => {
    const w = await world();
    const err = await w.db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: w.otherId,
      forwardOfMessageId: w.originalId, subject: "x", body: "y", to: [], cc: [], bcc: [], status: "draft",
    }).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err, "a row answering and forwarding was stored").not.toBeNull();
    expect(String((err as { message?: string }).message ?? "") + String((err as { code?: string }).code ?? ""))
      .toMatch(/drafts_reply_xor_forward|23514/);
    void sql;
  });
});

describe("a draft that forwards is sent as a forward, whatever the request names", () => {
  it("a request naming no forward sends the row's: the original is quoted and its attachment rides", async () => {
    const w = await world();
    const d = await forwardDraft(w);
    const send = sendSpy();
    const fetch = fetchSpy({ "2": new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    const res = await sendService.send(w.ctx, d.id, "fwd-row-1",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter }, {});
    expect(res.status).toBe("sent");
    expect(send.delivered).toHaveLength(1);
    expect(send.delivered[0]!.text, "the kept forward left without its original").toContain("Here is the plan.");
    expect(fetch.asked, "the original's attachment did not ride the forward").toEqual(["2"]);
  });

  it("a request naming ANOTHER original than the row holds is refused by name, and nothing leaves", async () => {
    const w = await world();
    const d = await forwardDraft(w);
    const send = sendSpy();
    const fetch = fetchSpy({});
    const err = await sendService.send(w.ctx, d.id, "fwd-row-2",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter }, { forwardOf: w.otherId })
      .catch((e: unknown) => e as { httpStatus?: number; code?: string });
    expect((err as { httpStatus?: number }).httpStatus).toBe(409);
    expect((err as { code?: string }).code).toBe("forward_mismatch");
    expect(send.delivered).toHaveLength(0);
    expect(await w.db.select().from(outboundSends)).toHaveLength(0);
  });

  it("a row forwarding a no_forward original is refused without the confirmation, as a request's is", async () => {
    const w = await world({ noForward: true });
    const d = await forwardDraft(w);
    const send = sendSpy();
    const fetch = fetchSpy({});
    const err = await sendService.send(w.ctx, d.id, "fwd-row-3",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter }, {})
      .catch((e: unknown) => e as { httpStatus?: number });
    expect((err as { httpStatus?: number }).httpStatus, "a sensitive original left through a kept forward").toBe(403);
    expect(send.delivered).toHaveLength(0);
  });
});

/** THE KEPT LIST (`forwardParts`) rides the forward's row: stored canonical, cleared with the forward. */
describe("a forward draft keeps the files the person kept", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const C = "cccccccc-0000-4000-8000-000000000003";
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { httpStatus?: number }) => e.httpStatus);
  const kept = async (w: Awaited<ReturnType<typeof world>>, forwardParts: string[]) =>
    (await draftsService.create(w.ctx, {
      mailboxId: w.mailboxId, forwardOfMessageId: w.originalId, forwardParts, subject: "Fwd: Q3 plan",
      body: "Passing this along.", to: [{ name: null, address: "sam@example.test" }],
    })).draft;
  const rowOf = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (await w.db.select().from(drafts).where(eq(drafts.id, id)))[0]!;

  it("is stored sorted and deduped, and the DTO echoes it", async () => {
    const w = await world();
    const d = await kept(w, [C, A, C]);
    expect(d.forwardParts).toEqual([A, C]);
    expect((await rowOf(w, d.id)).forwardParts).toEqual([A, C]);
    expect((await draftsService.get(w.ctx, d.id)).forwardParts).toEqual([A, C]);
    expect((await forwardDraft(w)).forwardParts).toBeNull();
  });

  it("is refused without a forward, past 100 entries, or with a non-id", async () => {
    const w = await world();
    const plain = { mailboxId: w.mailboxId, subject: "x", body: "y", to: [] };
    expect(await status(draftsService.create(w.ctx, { ...plain, forwardParts: [A] }))).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(await status(draftsService.create(w.ctx, { ...plain, forwardOfMessageId: w.originalId, forwardParts: many }))).toBe(400);
    expect(await status(draftsService.create(w.ctx, { ...plain, forwardOfMessageId: w.originalId, forwardParts: [A, "x"] }))).toBe(400);
    const d = await forwardDraft(w);
    await draftsService.update(w.ctx, d.id, { forwardOfMessageId: null });
    expect(await status(draftsService.update(w.ctx, d.id, { forwardParts: [A] })), "a list stored on a row that forwards nothing").toBe(400);
  });

  it("a patch leaves it when absent, sets it, and clears it with null", async () => {
    const w = await world();
    const d = await kept(w, [A, C]);
    expect((await draftsService.update(w.ctx, d.id, { body: "Edited." })).draft.forwardParts).toEqual([A, C]);
    expect((await draftsService.update(w.ctx, d.id, { forwardParts: [C] })).draft.forwardParts).toEqual([C]);
    expect((await draftsService.update(w.ctx, d.id, { forwardParts: null })).draft.forwardParts).toBeNull();
  });

  it("clearing or changing the forward clears it, unless the patch names a new list", async () => {
    const w = await world();
    const d = await kept(w, [A, C]);
    expect((await draftsService.update(w.ctx, d.id, { forwardOfMessageId: null })).draft.forwardParts).toBeNull();
    expect((await rowOf(w, d.id)).forwardParts).toBeNull();
    const d2 = await kept(w, [A, C]);
    expect((await draftsService.update(w.ctx, d2.id, { forwardOfMessageId: w.otherId })).draft.forwardParts).toBeNull();
    const d3 = await kept(w, [A, C]);
    expect((await draftsService.update(w.ctx, d3.id, { forwardOfMessageId: w.otherId, forwardParts: [C] })).draft.forwardParts).toEqual([C]);
  });

  it("the revision moves when the list changes, and not on a restatement", async () => {
    const w = await world();
    const d = await kept(w, [A, C]);
    const same = (await draftsService.update(w.ctx, d.id, { forwardParts: [C, A] })).draft;
    expect(same.contentRevision).toBe(d.contentRevision);
    const moved = (await draftsService.update(w.ctx, d.id, { forwardParts: [A] })).draft;
    expect(moved.contentRevision).not.toBe(d.contentRevision);
  });
});
