import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, messages, outboundSends } from "@trafficflow/db";
import { invitationReplyText, type OpenSendAdapter, type OutboundMessage } from "@trafficflow/core";
import { SendService, sendContentFingerprint } from "../src/index.js";
import { ServiceError } from "../src/errors.js";
import { invitationAnswerKey, type AnswerCalendar } from "../src/invitation-answer-draft.js";
import { makeCtx } from "./helpers.js";

/**
 * THE CALENDAR PART ON THE SEND PATH. An answer to an invitation leaves as a letter through
 * `SendService.send`, with a calendar part only its own draft may carry. These cases hold the
 * three rules `reserve` keeps for it, and the content claim's one new member: a marked draft never
 * leaves without its part, no other draft ever with one, and a marked draft only while its envelope
 * is still the invitation's.
 */

const svc = new SendService();
const ORGANIZER = "giulia@studio.example";
const ME = "mila@lichtgrat.example";

function spy() {
  const sent: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to close */ },
  });
  return { sent, factory };
}

async function world(messageIdHeader = "kickoff-17@studio.example") {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  const [letter] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    subject: "Kickoff", fromAddress: ORGANIZER, date: new Date("2026-07-28T09:00:00Z"),
    nativeLocator: { folder: "INBOX", ref: "1:7" }, snippet: "", unread: true,
  }).returning();
  const messageId = letter!.id;
  const text = (stamp: string, answer: "accepted" | "declined" = "accepted"): string => invitationReplyText({
    uid: "kickoff-17@studio.example", recurrenceId: "", sequence: 0, startRaw: "20261201T100000Z",
    startsAt: new Date("2026-12-01T10:00:00Z"), organizer: ORGANIZER, invitedAddress: ME, answer, stamp: new Date(stamp),
  })!;
  const calendar = (t: string): AnswerCalendar => ({ method: "REPLY", text: t, messageId, mailboxId, to: ORGANIZER, from: ME });
  /** An answer's draft as the answer's service makes it, then changed by `over`. */
  async function answerDraft(answer: "accepted" | "declined", over: Record<string, unknown> = {}): Promise<string> {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId, inReplyToMessageId: messageId, subject: answer === "accepted" ? "Accepted" : "Declined",
      body: `${ME} has ${answer} this invitation.`, to: [{ name: null, address: ORGANIZER }], status: "draft",
      workflowDedupKey: invitationAnswerKey(accountId, messageId, answer, null), ...over,
    } as never).returning();
    return d!.id;
  }
  return { db, ctx, accountId, mailboxId, messageId, text, calendar, answerDraft };
}

async function refusal(work: Promise<unknown>): Promise<ServiceError> {
  const err = await work.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

describe("the content claim reads the calendar part", () => {
  const BASE = {
    to: [{ name: null, address: ORGANIZER }], cc: [], bcc: [], subject: "Accepted", html: null, body: "yes",
    inReplyToMessageId: null, forwardOf: null, sendAt: null, attachments: [],
  } as const;
  const fp = (calendar?: string | null): string => sendContentFingerprint({ ...BASE, ...(calendar === undefined ? {} : { calendar }) });

  it("absent, it keeps every digest stored before it", () => {
    const fwd = { ...BASE, to: [{ name: null, address: "you@example.com" }], subject: "Re: hi", body: "Thanks!", forwardOf: "22222222-2222-4222-8222-222222222222" };
    expect(sendContentFingerprint(fwd)).toBe("c1911edfe050cde54ea4cf43b969c88ca66b2af7b1f3d4a65154cfabb843da2b");
    expect(sendContentFingerprint({ ...fwd, calendar: null })).toBe(sendContentFingerprint(fwd));
    expect(fp(null)).toBe(fp());
  });

  it("present, two calendar parts are two messages, and one is one", () => {
    expect(fp("a".repeat(64))).not.toBe(fp());
    expect(fp("a".repeat(64))).not.toBe(fp("b".repeat(64)));
    expect(fp("a".repeat(64))).toBe(fp("a".repeat(64)));
  });
});

describe("an answer's draft leaves with its calendar part, as it was made", () => {
  it("one submission, the part as written, the organizer alone, threaded on the letter", async () => {
    const w = await world();
    const draftId = await w.answerDraft("accepted");
    const { sent, factory } = spy();
    const text = w.text("2026-11-15T09:30:00Z");
    const res = await svc.send(w.ctx, draftId, "press-1", { openSendAdapter: factory }, { calendar: w.calendar(text) });
    expect(res.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.calendar).toEqual({ method: "REPLY", text });
    expect(sent[0]!.to).toEqual([ORGANIZER]);
    expect(sent[0]!.cc).toBeUndefined();
    expect(sent[0]!.bcc).toBeUndefined();
    expect(sent[0]!.inReplyTo).toBe("kickoff-17@studio.example");
    expect(sent[0]!.attachments).toBeUndefined();
  });

  it("one key twice is one submission", async () => {
    const w = await world();
    const draftId = await w.answerDraft("accepted");
    const { sent, factory } = spy();
    const calendar = w.calendar(w.text("2026-11-15T09:30:00Z"));
    await svc.send(w.ctx, draftId, "press-1", { openSendAdapter: factory }, { calendar });
    const again = await svc.send(w.ctx, draftId, "press-1", { openSendAdapter: factory }, { calendar });
    expect(again.status).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("the same words with another stamp are another letter; the same part twice is the same letter", async () => {
    const w = await world();
    const { sent, factory } = spy();
    const first = await w.answerDraft("accepted");
    await svc.send(w.ctx, first, "press-1", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:30:00Z")) });
    const later = await w.answerDraft("accepted", { workflowDedupKey: invitationAnswerKey(w.accountId, w.messageId, "accepted", new Date("2026-11-15T09:31:00Z")) });
    const res = await svc.send(w.ctx, later, "press-3", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:32:00Z")) });
    expect(res.status).toBe("sent");
    expect(sent).toHaveLength(2);
    const twin = await w.answerDraft("accepted", { workflowDedupKey: invitationAnswerKey(w.accountId, w.messageId, "accepted", new Date("2026-11-15T09:33:00Z")) });
    const err = await refusal(svc.send(w.ctx, twin, "press-4", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:32:00Z")) }));
    expect(err.code).toBe("duplicate_send");
    expect(sent).toHaveLength(2);
  });

  it("thread headers name the letter only when its Message-ID is a plain token", async () => {
    for (const hostile of ["two words@studio.example", "a@b@studio.example", "x@studio.example>\r\nBcc: eve@studio.example", "nobody"]) {
      const w = await world(hostile);
      const { sent, factory } = spy();
      const res = await svc.send(w.ctx, await w.answerDraft("accepted"), "press-1", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:30:00Z")) });
      expect(res.status, hostile).toBe("sent");
      expect(sent[0]!.inReplyTo, hostile).toBeUndefined();
      expect(sent[0]!.references, hostile).toBeUndefined();
      // Every other reply to the same letter is threaded as it always was.
      const [plain] = await w.db.insert(drafts).values({
        accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: w.messageId, subject: "Re: Kickoff", body: "ok",
        to: [{ name: null, address: ORGANIZER }], status: "draft",
      }).returning();
      await svc.send(w.ctx, plain!.id, "plain-1", { openSendAdapter: factory });
      expect(sent[1]!.inReplyTo, hostile).toBe(hostile);
    }
  });
});

describe("refused where every envelope is built", () => {
  async function nothingLeft(w: Awaited<ReturnType<typeof world>>, draftId: string, sent: OutboundMessage[]): Promise<void> {
    expect(sent).toHaveLength(0);
    expect(await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId))).toEqual([]);
    const [d] = await w.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("draft");
  }

  it("an answer's draft sent without its calendar part: the plain send route", async () => {
    const w = await world();
    const draftId = await w.answerDraft("accepted");
    const { sent, factory } = spy();
    const err = await refusal(svc.send(w.ctx, draftId, "plain", { openSendAdapter: factory }));
    expect([err.code, err.httpStatus]).toEqual(["invitation_not_answerable", 422]);
    await nothingLeft(w, draftId, sent);
  });

  it("a calendar part on any other draft", async () => {
    const w = await world();
    const [d] = await w.db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: w.messageId, subject: "Accepted", body: "yes",
      to: [{ name: null, address: ORGANIZER }], status: "draft",
    }).returning();
    const { sent, factory } = spy();
    const err = await refusal(svc.send(w.ctx, d!.id, "smuggled", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:30:00Z")) }));
    expect([err.code, err.httpStatus]).toEqual(["validation_failed", 400]);
    await nothingLeft(w, d!.id, sent);
  });

  it("an answer whose draft no longer names the organizer alone, now, from the invited mailbox", async () => {
    const changes: Array<[string, Record<string, unknown>]> = [
      ["another recipient", { to: [{ name: null, address: "eve@studio.example" }] }],
      ["a second recipient", { to: [{ name: null, address: ORGANIZER }, { name: null, address: "eve@studio.example" }] }],
      ["a name beside the address", { to: [{ name: "Giulia", address: ORGANIZER }] }],
      ["the address in another case", { to: [{ name: null, address: "Giulia@studio.example" }] }],
      ["a copy", { cc: [{ name: null, address: "eve@studio.example" }] }],
      ["a blind copy", { bcc: [{ name: null, address: "eve@studio.example" }] }],
      ["a time to send later", { sendAt: new Date("2026-12-01T08:00:00Z") }],
      ["another letter answered", { inReplyToMessageId: null }],
    ];
    for (const [what, over] of changes) {
      const w = await world();
      const draftId = await w.answerDraft("accepted", over);
      const { sent, factory } = spy();
      const err = await refusal(svc.send(w.ctx, draftId, "press", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:30:00Z")) }));
      expect(err.code, what).toBe("invitation_not_answerable");
      await nothingLeft(w, draftId, sent);
    }
  });

  it("an answer from another mailbox, or a mailbox whose address moved", async () => {
    const w = await world();
    const [other] = await w.db.insert(mailboxes).values({ accountId: w.accountId, provider: "imap", address: "mila@elsewhere.example" }).returning();
    const moved = await w.answerDraft("accepted", { mailboxId: other!.id });
    const { sent, factory } = spy();
    const err = await refusal(svc.send(w.ctx, moved, "press", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:30:00Z")) }));
    expect(err.code).toBe("invitation_not_answerable");
    await nothingLeft(w, moved, sent);

    const draftId = await w.answerDraft("declined");
    await w.db.update(mailboxes).set({ address: "mila.b@lichtgrat.example" }).where(eq(mailboxes.id, w.mailboxId));
    const gone = await refusal(svc.send(w.ctx, draftId, "press-2", { openSendAdapter: factory }, { calendar: w.calendar(w.text("2026-11-15T09:30:00Z", "declined")) }));
    expect([gone.code, gone.httpStatus]).toEqual(["invitation_not_invited", 422]);
    await nothingLeft(w, draftId, sent);
  });

  it("Send again on a held answer", async () => {
    const w = await world();
    const draftId = await w.answerDraft("accepted", { status: "unverified" });
    await w.db.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "held", draftId, mintedMessageId: "<held@lichtgrat.example>", status: "unverified",
      createdAt: new Date("2026-07-28T11:00:00Z"),
    });
    const { sent, factory } = spy();
    const err = await refusal(svc.send(w.ctx, draftId, "again", { openSendAdapter: factory }, { again: true }));
    expect(err.code).toBe("invitation_not_answerable");
    expect(sent).toHaveLength(0);
  });
});
