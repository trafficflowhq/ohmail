import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { changeLog, contacts, drafts, mailboxes, messageInvitations, messages, outboundSends } from "@trafficflow/db";
import { createLogger, invitationReplyText } from "@trafficflow/core";
import { outboundToMail } from "@trafficflow/core/adapters/imap";
import type { MessageDTO } from "@ohmail/wire";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { answerInvitation, type InvitationAnswerDeps } from "../src/invitation-answer-service.js";
import { sendService } from "../src/send-service.js";
import { syncService } from "../src/sync-service.js";
import { ServiceError } from "../src/errors.js";
import type { ServiceContext } from "../src/context.js";
import { makeCtx } from "./helpers.js";
import { conversation, invitationLetter, ME, ORGANIZER, outbox, stampOf, type Invitation } from "./_invitation-answer.js";

/**
 * YES, MAYBE, NO ON AN INVITATION, BY MAIL. A press sends one letter, from the address that was
 * invited, to the organizer alone, as a REPLY the organizer's calendar takes; it is in the
 * conversation and the send path's own Sent copy, and the answer is on the row once it left. A
 * forwarded invitation, a cancelled or replaced one, another account's letter and a press made on
 * an answer the card no longer shows are refused, and refused before any draft is made. The
 * `sqlite` project runs this file too: a standalone phone answers on that store.
 */

const NOW = new Date("2026-11-15T09:30:12.400Z");

async function world(over: Invitation = {}) {
  const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
  const threadId = await conversation(db, accountId);
  const messageId = await invitationLetter(db, accountId, mailboxId, { threadId, header: "kickoff-17@studio.example", ...over });
  const box = outbox();
  const deps: InvitationAnswerDeps = { send: { openSendAdapter: box.factory } };
  const press = (answer: string, basis: string | null, key: string, c: ServiceContext = ctx, d: InvitationAnswerDeps = deps) =>
    answerInvitation(c, { messageId, answer, basis, key }, d);
  const row = async () => (await db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId)))[0]!;
  return { db, ctx, accountId, mailboxId, threadId, messageId, box, deps, press, row };
}

async function refusal(work: Promise<unknown>): Promise<ServiceError> {
  const err = await work.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

/** The account's changes after `seq`, in order. */
async function changesAfter(w: Awaited<ReturnType<typeof world>>, seq: number) {
  return w.db.select().from(changeLog)
    .where(and(eq(changeLog.accountId, w.accountId), gt(changeLog.seq, BigInt(seq) as never)))
    .orderBy(asc(changeLog.seq));
}

/** The highest change of the account so far, 0 for none. */
async function lastSeq(w: Awaited<ReturnType<typeof world>>): Promise<number> {
  const all = await changesAfter(w, 0);
  return all.length === 0 ? 0 : Number(all[all.length - 1]!.seq);
}

/**
 * THE ANSWER REACHES OTHER DEVICES THROUGH ITS OWN CHANGE: the press's last change is the letter's
 * `message` update, after every change its draft made, and the feed read from past those draft
 * changes brings the letter again, carrying the answer.
 */
async function answerFed(w: Awaited<ReturnType<typeof world>>, from: number, answer: string, outSeq: number | null): Promise<void> {
  const changes = await changesAfter(w, from);
  const last = changes.at(-1);
  expect(last && [last.entityType, last.entityId, last.op]).toEqual(["message", w.messageId, "update"]);
  if (last === undefined) return;
  expect(outSeq).toBe(Number(last.seq));
  const draftSeqs = changes.filter((c) => c.entityType === "draft").map((c) => Number(c.seq));
  const pastDrafts = Math.max(from, ...draftSeqs);
  expect(Number(last.seq)).toBeGreaterThan(pastDrafts);
  const fed = await syncService.getChanges(w.ctx, { since: syncService.encodeCursor(BigInt(pastDrafts)) });
  const letters = fed.changes.updates.filter((c) => c.type === "message" && c.id === w.messageId);
  expect(letters.map((c) => (c.entity as MessageDTO).invitation?.answer)).toEqual([answer]);
}

describe("an answer goes once, from the address that was invited", () => {
  it("Yes: one letter to the organizer alone, from the invited mailbox, in the conversation, recorded with a change", async () => {
    const w = await world();
    const before = await lastSeq(w);
    const out = await w.press("accepted", null, "press-1");
    expect(out.result).toMatchObject({ status: "sent", answer: "accepted", answeredAt: "2026-11-15T09:30:12.000Z" });
    expect(w.box.sent).toHaveLength(1);
    const letter = w.box.sent[0]!;
    expect(letter.from).toBe(ME);
    expect(letter.to).toEqual([ORGANIZER]);
    expect([letter.cc, letter.bcc, letter.attachments, letter.html]).toEqual([undefined, undefined, undefined, undefined]);
    expect(letter.subject).toBe("Accepted");
    expect(letter.text).toBe(`${ME} has accepted this invitation.`);
    expect(letter.inReplyTo).toBe("kickoff-17@studio.example");
    expect(letter.calendar).toEqual({
      method: "REPLY",
      text: invitationReplyText({
        uid: "kickoff-17@studio.example", recurrenceId: "", sequence: 0, startRaw: "20261201T100000Z",
        startsAt: new Date("2026-12-01T10:00:00Z"), organizer: ORGANIZER, invitedAddress: ME, answer: "accepted",
        stamp: new Date("2026-11-15T09:30:12Z"),
      }),
    });
    const row = await w.row();
    expect([row.answer, row.answeredAt?.toISOString()]).toEqual(["accepted", "2026-11-15T09:30:12.000Z"]);
    const [draft] = await w.db.select().from(drafts).where(eq(drafts.accountId, w.accountId));
    expect([draft!.status, draft!.threadId, draft!.inReplyToMessageId]).toEqual(["sent", w.threadId, w.messageId]);
    await answerFed(w, before, "accepted", out.seq);
  });

  it("one key twice, and two presses at once, give one letter", async () => {
    const w = await world();
    const first = await w.press("tentative", null, "press-1");
    const again = await w.press("tentative", null, "press-1");
    expect([first.result.status, again.result.status]).toEqual(["sent", "already"]);
    expect(w.box.sent).toHaveLength(1);

    // At once where the store takes two writers (the device store has one: there the two queue).
    const v = await world();
    const presses = [() => v.press("declined", null, "phone-1"), () => v.press("declined", null, "desk-1")];
    const both = process.env.OHMAIL_TEST_DIALECT === "sqlite"
      ? [await presses[0]!(), await presses[1]!()]
      : await Promise.all(presses.map((p) => p()));
    expect(v.box.sent).toHaveLength(1);
    expect(both.map((o) => o.result.status).sort()).toEqual(expect.arrayContaining(["sent"]));
    expect(await v.db.select().from(drafts).where(eq(drafts.accountId, v.accountId))).toHaveLength(1);
  });

  it("Yes, No, Yes: three letters, each stamped after the last, and the row on the last", async () => {
    const w = await world();
    const outs = [
      await w.press("accepted", null, "press-1"),
      await w.press("declined", "accepted", "press-2"),
      await w.press("accepted", "declined", "press-3"),
    ];
    expect(outs.map((o) => o.result.status)).toEqual(["sent", "sent", "sent"]);
    expect(w.box.sent).toHaveLength(3);
    const stamps = w.box.sent.map((m) => stampOf(m.calendar!.text));
    expect(stamps[1]).toBeGreaterThan(stamps[0]!);
    expect(stamps[2]).toBeGreaterThan(stamps[1]!);
    expect(w.box.sent.map((m) => /PARTSTAT=(\w+)/.exec(m.calendar!.text)![1])).toEqual(["ACCEPTED", "DECLINED", "ACCEPTED"]);
    const row = await w.row();
    expect([row.answer, row.answeredAt?.getTime()]).toEqual(["accepted", stamps[2]]);
  });

  it("a send that failed leaves the row as it was, and the next press sends the same letter", async () => {
    const w = await world();
    const box = outbox({ fail: new Set([1]) });
    const deps = { send: { openSendAdapter: box.factory } };
    await refusal(w.press("accepted", null, "press-1", w.ctx, deps));
    expect(box.sent).toHaveLength(0);
    expect((await w.row()).answer).toBeNull();
    const later = { ...w.ctx, now: () => new Date("2026-11-15T09:40:00Z") };
    const out = await w.press("accepted", null, "press-2", later, deps);
    expect(out.result.status).toBe("sent");
    expect(box.sent).toHaveLength(1);
    // The same draft, so the same letter: its stamp is the first press's.
    expect(stampOf(box.sent[0]!.calendar!.text)).toBe(Date.parse("2026-11-15T09:30:12Z"));
    expect(await w.db.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toHaveLength(1);
  });

  it("an answer that left and was not recorded is recorded at the next press, and nothing leaves again", async () => {
    const w = await world();
    await w.press("accepted", null, "press-1");
    await w.db.update(messageInvitations).set({ answer: null, answeredAt: null }).where(eq(messageInvitations.messageId, w.messageId));
    const before = await lastSeq(w);
    const out = await w.press("accepted", null, "press-2");
    expect(out.result).toMatchObject({ status: "already", answer: "accepted", answeredAt: "2026-11-15T09:30:12.000Z" });
    expect(w.box.sent).toHaveLength(1);
    expect((await w.row()).answer).toBe("accepted");
    // Healed without a send, the answer still reaches other devices by its own change.
    await answerFed(w, before, "accepted", out.seq);
  });

  it("a key a Cancel tombstoned sends nothing and makes no draft", async () => {
    const w = await world();
    expect((await sendService.withdraw(w.ctx, "press-1", null, w.deps.send)).outcome).toBe("withdrawn");
    const err = await refusal(w.press("accepted", null, "press-1"));
    expect([err.code, err.httpStatus, err.retryable]).toEqual(["send_withdrawn", 409, false]);
    expect(w.box.sent).toHaveLength(0);
    expect(await w.db.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toEqual([]);
    expect((await w.row()).answer).toBeNull();
  });

  it("a key that named another letter's send records nothing and sends nothing more", async () => {
    const w = await world();
    const [plain] = await w.db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, subject: "Re: Kickoff", body: "Agenda attached.",
      to: [{ name: null, address: ORGANIZER }], status: "draft",
    }).returning();
    await sendService.send(w.ctx, plain!.id, "shared-key", w.deps.send);
    const err = await refusal(w.press("accepted", null, "shared-key"));
    expect([err.code, err.httpStatus]).toEqual(["conflict", 409]);
    expect(w.box.sent).toHaveLength(1);
    expect((await w.row()).answer).toBeNull();
  });

  it("one event asked for by two organizers: an answer to one is no answer to the other", async () => {
    const w = await world();
    const other = await invitationLetter(w.db, w.accountId, w.mailboxId, { organizer: "eve@forged.example", attendees: [ME] });
    const onOther = await answerInvitation(w.ctx, { messageId: other, answer: "declined", basis: null, key: "press-other" }, w.deps);
    expect(onOther.result.status).toBe("sent");
    expect((await w.row()).answer).toBeNull();
    // This letter's organizer has heard nothing yet: a press here sends this letter's own answer.
    expect((await w.press("declined", null, "press-this")).result.status).toBe("sent");
    expect(w.box.sent.map((m) => m.to)).toEqual([["eve@forged.example"], [ORGANIZER]]);
    expect((await w.row()).answer).toBe("declined");
  });

  it("an answer teaches nobody: the organizer does not become someone this account wrote to", async () => {
    const w = await world();
    await w.press("declined", null, "press-1");
    expect(w.box.sent).toHaveLength(1);
    expect(await w.db.select().from(contacts).where(eq(contacts.accountId, w.accountId))).toEqual([]);
    // A letter the person writes to the same organizer still teaches, as every send does.
    const [plain] = await w.db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, subject: "Re: Kickoff", body: "See you there.",
      to: [{ name: null, address: ORGANIZER }], status: "draft",
    }).returning();
    await sendService.send(w.ctx, plain!.id, "plain-1", w.deps.send);
    expect((await w.db.select({ address: contacts.address }).from(contacts).where(eq(contacts.accountId, w.accountId))).map((c) => c.address))
      .toEqual([ORGANIZER]);
  });

  it("an answer that left takes this letter's other answers still waiting as drafts with it", async () => {
    const w = await world();
    const box = outbox({ fail: new Set([1]) });
    const deps = { send: { openSendAdapter: box.factory } };
    await refusal(w.press("accepted", null, "press-1", w.ctx, deps));
    const [waiting] = await w.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.accountId, w.accountId));
    const seq = Number((await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq))).at(-1)!.seq);
    await w.press("declined", null, "press-2", w.ctx, deps);
    expect((await w.db.select({ id: drafts.id, status: drafts.status }).from(drafts).where(eq(drafts.accountId, w.accountId))).map((d) => d.status)).toEqual(["sent"]);
    const gone = await w.db.select().from(changeLog).where(and(eq(changeLog.accountId, w.accountId), gt(changeLog.seq, BigInt(seq) as never)));
    expect(gone.some((c) => c.entityType === "draft" && c.entityId === waiting!.id && c.op === "delete")).toBe(true);
  });
});

describe("refused with a word, sending nothing and making no draft", () => {
  async function nothingMade(w: Awaited<ReturnType<typeof world>>): Promise<void> {
    expect(w.box.sent).toHaveLength(0);
    expect(await w.db.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toEqual([]);
    expect(await w.db.select().from(outboundSends).where(eq(outboundSends.accountId, w.accountId))).toEqual([]);
  }

  it("another account's letter, a deleted one and one without an invitation answer as a missing letter", async () => {
    const w = await world();
    const missing = await refusal(w.press("accepted", null, "k", { ...w.ctx, accountId: randomUUID() }));
    const random = await refusal(answerInvitation(w.ctx, { messageId: randomUUID(), answer: "accepted", basis: null, key: "k" }, w.deps));
    expect([missing.code, missing.httpStatus, missing.message, missing.details]).toEqual([random.code, random.httpStatus, random.message, random.details]);
    expect([random.code, random.httpStatus]).toEqual(["not_found", 404]);
    await w.db.update(messages).set({ deletedAt: NOW }).where(eq(messages.id, w.messageId));
    expect((await refusal(w.press("accepted", null, "k"))).code).toBe("not_found");
    const [plain] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: "plain@studio.example", bodyHash: randomUUID(),
      dedupKey: `mid:${randomUUID()}`, subject: "hello", fromAddress: ORGANIZER, nativeLocator: { folder: "INBOX", ref: "1:1" }, snippet: "",
    }).returning();
    expect((await refusal(answerInvitation(w.ctx, { messageId: plain!.id, answer: "accepted", basis: null, key: "k" }, w.deps))).code).toBe("not_found");
    await nothingMade(w);
  });

  const words: Array<[string, Invitation, string, number]> = [
    ["a cancellation", { method: "CANCEL" }, "invitation_cancelled", 409],
    ["a reply", { method: "REPLY", attendees: [ME] }, "invitation_not_answerable", 422],
    ["a counter-proposal", { method: "COUNTER" }, "invitation_not_answerable", 422],
    ["a forwarded invitation", { attendees: ["someone@elsewhere.example", ORGANIZER] }, "invitation_not_invited", 422],
    ["the person's own event", { organizer: ME, attendees: [ME, "guest@studio.example"] }, "invitation_not_answerable", 422],
    ["an occurrence on an unknown zone's clock", { recurrenceId: "Mars/Olympus|20261208T1100|false" }, "invitation_not_answerable", 422],
  ];
  for (const [what, over, code, status] of words) {
    it(`${what}: ${code}`, async () => {
      const w = await world(over);
      const err = await refusal(w.press("accepted", null, "k"));
      expect([err.code, err.httpStatus]).toEqual([code, status]);
      await nothingMade(w);
    });
  }

  it("a later cancellation from the same organizer, of the event or this occurrence", async () => {
    for (const later of [{ method: "CANCEL" as const, sequence: 0 }, { method: "CANCEL" as const, sequence: 4, recurrenceId: "" }]) {
      const w = await world({ sequence: 0 });
      await invitationLetter(w.db, w.accountId, w.mailboxId, later);
      const err = await refusal(w.press("accepted", null, "k"));
      expect(err.code).toBe("invitation_cancelled");
      await nothingMade(w);
    }
    // Another organizer's cancellation of the same UID cancels nothing.
    const v = await world();
    await invitationLetter(v.db, v.accountId, v.mailboxId, { method: "CANCEL", organizer: "eve@forged.example", sequence: 9 });
    expect((await v.press("accepted", null, "k")).result.status).toBe("sent");
  });

  it("removed from the event, then invited again at the same revision: the new invitation answers, the old stays cancelled", async () => {
    const w = await world({ sequence: 0, stampedAt: new Date("2026-11-10T08:00:00Z") });
    await invitationLetter(w.db, w.accountId, w.mailboxId, { method: "CANCEL", sequence: 0, stampedAt: new Date("2026-11-11T08:00:00Z") });
    const again = await invitationLetter(w.db, w.accountId, w.mailboxId, { sequence: 0, stampedAt: new Date("2026-11-13T08:00:00Z") });
    expect((await refusal(w.press("accepted", null, "press-old"))).code).toBe("invitation_cancelled");
    expect(w.box.sent).toHaveLength(0);
    const out = await answerInvitation(w.ctx, { messageId: again, answer: "accepted", basis: null, key: "press-again" }, w.deps);
    expect(out.result.status).toBe("sent");
    expect(w.box.sent.map((m) => m.to)).toEqual([[ORGANIZER]]);
  });

  it("a newer revision: invitation_replaced, naming it; the same revision again replaces nothing", async () => {
    const w = await world({ sequence: 1 });
    const newer = await invitationLetter(w.db, w.accountId, w.mailboxId, { sequence: 2 });
    const err = await refusal(w.press("accepted", null, "k"));
    expect([err.code, err.httpStatus, err.details]).toEqual(["invitation_replaced", 409, { messageId: newer }]);
    await nothingMade(w);
    const v = await world({ sequence: 1 });
    await invitationLetter(v.db, v.accountId, v.mailboxId, { sequence: 1 });
    expect((await v.press("accepted", null, "k")).result.status).toBe("sent");
  });

  it("answered elsewhere meanwhile: the answer on record travels with the refusal, and nothing leaves", async () => {
    const w = await world();
    await w.press("accepted", null, "press-1");
    const err = await refusal(w.press("declined", null, "press-2"));
    expect([err.code, err.httpStatus, err.details]).toEqual(["invitation_answered_elsewhere", 409, { answer: "accepted" }]);
    expect(w.box.sent).toHaveLength(1);
  });

  it("the invited address is the mailbox's own, the ASCII letters folded and nothing else", async () => {
    const fold = await world({ attendees: ["MILA@LichtGrat.example"] });
    expect((await fold.press("accepted", null, "k")).result.status).toBe("sent");
    expect(fold.box.sent[0]!.calendar!.text).toContain("ATTENDEE;PARTSTAT=ACCEPTED:mailto:MILA@LichtGrat.example");
    for (const lookalike of ["Kai@lichtgrat.example", "ｍila@lichtgrat.example", "mıla@lichtgrat.example", "mila@lichtgrat.example.", "mila+x@lichtgrat.example"]) {
      const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
      // The Kelvin sign folds to `k` in Unicode's lower case, never in ASCII's.
      if (lookalike.startsWith("K")) await db.update(mailboxes).set({ address: "kai@lichtgrat.example" }).where(eq(mailboxes.id, mailboxId));
      const [letter] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: `${randomUUID()}@studio.example`, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
        subject: "x", fromAddress: ORGANIZER, nativeLocator: { folder: "INBOX", ref: "1:2" }, snippet: "",
      }).returning();
      // The row as a store could hold it, past the door: the press holds the address again itself.
      await db.insert(messageInvitations).values({
        accountId, messageId: letter!.id, mailboxId, uid: "u@studio.example", method: "REQUEST", organizer: ORGANIZER, invitedAddress: lookalike,
      });
      const box = outbox();
      const err = await refusal(answerInvitation(ctx, { messageId: letter!.id, answer: "accepted", basis: null, key: "k" }, { send: { openSendAdapter: box.factory } }));
      expect(err.code, lookalike).toBe("invitation_not_invited");
      expect(box.sent).toHaveLength(0);
    }
  });

  it("a mailbox whose address moved, or that was disconnected", async () => {
    const w = await world();
    await w.db.update(mailboxes).set({ address: "mila.brunner@lichtgrat.example" }).where(eq(mailboxes.id, w.mailboxId));
    expect((await refusal(w.press("accepted", null, "k"))).code).toBe("invitation_not_invited");
    await nothingMade(w);
    const v = await world();
    await v.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, v.mailboxId));
    expect((await refusal(v.press("accepted", null, "k"))).code).toBe("mailbox_disabled");
    await nothingMade(v);
  });

  it("an answer or a basis that is not one of the three words", async () => {
    const w = await world();
    for (const [answer, basis] of [["maybe", null], [undefined, null], ["accepted", "yes"], ["accepted", undefined]] as const) {
      const err = await refusal(answerInvitation(w.ctx, { messageId: w.messageId, answer, basis, key: "k" }, w.deps));
      expect([err.code, err.httpStatus]).toEqual(["validation_failed", 400]);
    }
    await nothingMade(w);
  });
});

describe("the letter carries nothing its sender wrote but the two tokens it must", () => {
  it("the header block holds only the expected names, one To, and none of a stranger's text", async () => {
    const w = await world({ subject: "Weekly\r\nBcc: planted@evil.example", uid: "uid-mark;a,b\\c@studio.example" });
    await w.press("accepted", null, "press-1");
    const raw = await new MailComposer(outboundToMail(w.box.sent[0]!, w.box.sent[0]!.messageId!, NOW)).compile().build();
    const head = raw.toString("utf8").split("\r\n\r\n")[0]!;
    const names = head.split("\r\n").filter((l) => !/^\s/.test(l)).map((l) => l.slice(0, l.indexOf(":")).toLowerCase());
    // The letter is two alternatives (`outboundToMail`): each part names its own encoding, the head none.
    expect(names.sort()).toEqual(["content-type", "date", "from", "in-reply-to", "message-id", "mime-version", "references", "subject", "to"]);
    expect(head).toMatch(/^To: giulia@studio\.example$/m);
    for (const planted of ["planted", "evil", "Weekly", "uid-mark"]) expect(head, planted).not.toContain(planted);
    // The calendar part does carry the UID, escaped as text: the one value of it a reply must repeat.
    expect(w.box.sent[0]!.calendar!.text).toContain("UID:uid-mark\\;a\\,b\\\\c@studio.example");
  });
});

describe("the log", () => {
  it("one line per press: the account, the letter and the outcome's word; no address, UID or subject anywhere", async () => {
    const lines: string[] = [];
    const log = createLogger({ service: "send", level: "debug", sink: (l) => { lines.push(String(l)); } });
    const marked = { uid: "secret-uid-17@studio.example", subject: "Secret subject" };
    const w = await world(marked);
    const deps = { send: { ...w.deps.send, log }, log };
    await w.press("accepted", null, "press-1", w.ctx, deps);
    await refusal(w.press("declined", null, "press-2", w.ctx, deps));
    await refusal(w.press("accepted", null, "press-3", { ...w.ctx, accountId: randomUUID() }, deps));
    const forwarded = await world({ ...marked, attendees: ["someone@elsewhere.example"] });
    await refusal(forwarded.press("accepted", null, "press-4", forwarded.ctx, deps));
    const failing = await world(marked);
    const box = outbox({ fail: new Set([1]) });
    await refusal(failing.press("tentative", null, "press-5", failing.ctx, { send: { openSendAdapter: box.factory, log }, log }));
    for (const l of lines) {
      expect(l).not.toMatch(/lichtgrat|studio\.example|elsewhere\.example|secret-uid|Secret subject/);
    }
    const ours = lines.filter((l) => l.includes("invitation_answer"));
    for (const l of ours) {
      expect(Object.keys(JSON.parse(l)).sort()).toEqual(["accountId", "event", "level", "messageId", "outcome", "service", "ts"]);
    }
    expect(ours.map((l) => JSON.parse(l).outcome)).toEqual([
      "sent", "invitation_answered_elsewhere", "not_found", "invitation_not_invited", expect.any(String),
    ]);
  });
});

describe("the draft an answer makes", () => {
  it("is made once per letter, answer and the answer before it, and the plain send refuses it", async () => {
    const w = await world();
    const box = outbox({ fail: new Set([1, 2]) });
    const deps = { send: { openSendAdapter: box.factory } };
    await refusal(w.press("accepted", null, "press-1", w.ctx, deps));
    await refusal(w.press("accepted", null, "press-2", w.ctx, deps));
    const made = await w.db.select().from(drafts).where(eq(drafts.accountId, w.accountId));
    expect(made).toHaveLength(1);
    expect(made[0]!.workflowDedupKey).toMatch(/^invitation-answer:[0-9a-f]{64}$/);
    expect(made[0]!.to).toEqual([{ name: null, address: ORGANIZER }]);
    const err = await refusal(sendService.send(w.ctx, made[0]!.id, "plain", { openSendAdapter: box.factory }));
    expect(err.code).toBe("invitation_not_answerable");
    expect(box.sent).toHaveLength(0);
  });
});
