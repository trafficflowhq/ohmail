import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts, invitationFieldOf, invitationStanding, mailboxes, messageInvitations, messages, putInvitationCopy, writeInvitation,
} from "../src/index.js";
import { makeTestDb } from "../src/testing.js";

/**
 * AN INVITATION'S IDENTITY IS ITS LETTER'S CHILD (mail 0204), on whichever store the run is (the
 * sqlite project runs this file too): one row per letter, read back as it was written, and gone
 * with the letter without a statement of its own.
 */
async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "invitations" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `i-${accountId}@example.test` }).returning();
  const letter = async (): Promise<string> => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, dedupKey: `mid:<${randomUUID()}@example.test>`, bodyHash: "b",
    }).returning();
    return m!.id;
  };
  return { db, accountId, mailboxId: mb!.id, letter };
}

describe("the identity of an invitation a letter carried", () => {
  it("is stored once per letter and read back as written, the series by default", async () => {
    const w = await world();
    const messageId = await w.letter();
    const startsAt = new Date("2026-12-01T10:00:00.000Z");
    await w.db.insert(messageInvitations).values({
      accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: "040000008200E00074C5B7101A82E008@example.test",
      method: "REQUEST", startRaw: "TZID=Europe/Zurich:20261201T110000", startsAt,
      organizer: "organizer@example.test", invitedAddress: "me@example.test",
    });
    const [row] = await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId));
    expect(row).toMatchObject({
      accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: "040000008200E00074C5B7101A82E008@example.test",
      recurrenceId: "", sequence: 0, method: "REQUEST", startRaw: "TZID=Europe/Zurich:20261201T110000", startsAt,
      organizer: "organizer@example.test", invitedAddress: "me@example.test",
    });
    expect(row!.createdAt).toBeInstanceOf(Date);
    // One card per letter: a second row for the same letter is refused.
    await expect(w.db.insert(messageInvitations).values({
      accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: "another@example.test", method: "CANCEL",
    })).rejects.toThrow();
  });

  it("goes with its letter, and only with its own", async () => {
    const w = await world();
    const [gone, kept] = [await w.letter(), await w.letter()];
    for (const messageId of [gone, kept]) {
      await w.db.insert(messageInvitations).values({
        accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: `${messageId}@example.test`, method: "REQUEST",
      });
    }
    await w.db.delete(messages).where(eq(messages.id, gone));
    const left = await w.db.select({ messageId: messageInvitations.messageId }).from(messageInvitations)
      .where(eq(messageInvitations.accountId, w.accountId));
    expect(left).toEqual([{ messageId: kept }]);
  });

  it("is refused for a letter that is not there", async () => {
    const w = await world();
    await expect(w.db.insert(messageInvitations).values({
      accountId: w.accountId, messageId: randomUUID(), mailboxId: w.mailboxId, uid: "orphan@example.test", method: "REQUEST",
    })).rejects.toThrow();
  });
});

/**
 * ═══ THE DOOR: what an invitation a letter carries writes, and the answer it records ═══════════
 *
 * One door for every writer (ingest, the pass over stored mail, the desktop's copy). Every value is
 * held to its column before a statement, so a value past a bound costs the letter's transaction
 * nothing; the invitee is the mailbox's address with the ASCII letters folded and nothing else.
 */
const ME = "mila@lichtgrat.example";

async function doorWorld(address: string = ME) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "door" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address }).returning();
  const letter = async (opts: { accountId?: string; mailboxId?: string; date?: Date } = {}): Promise<string> => {
    const [m] = await db.insert(messages).values({
      accountId: opts.accountId ?? accountId, mailboxId: opts.mailboxId ?? mb!.id,
      dedupKey: `mid:<${randomUUID()}@example.test>`, bodyHash: "b", date: opts.date ?? new Date("2026-11-10T08:00:00Z"),
    }).returning();
    return m!.id;
  };
  return { db, accountId, mailboxId: mb!.id, letter };
}

const REQUEST = {
  method: "REQUEST" as const, uid: "kickoff-17@studio.example", recurrenceId: "", sequence: 2,
  startRaw: "20261201T100000Z", startsAt: new Date("2026-12-01T10:00:00Z"), organizer: "tobias@studio.example",
  attendees: ["Mila@Lichtgrat.example", "tobias@studio.example"], stampedAt: null as Date | null, reply: null, own: false,
};
const replyOf = (answer: "accepted" | "declined" | "tentative", at: string, own = true) => ({
  ...REQUEST, method: "REPLY" as const, startRaw: null, startsAt: null, attendees: [ME], own,
  reply: { answer, at: new Date(at) },
});

async function rowsOf(db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string) {
  const rows = await db.select().from(messageInvitations).where(eq(messageInvitations.accountId, accountId));
  return rows.map((r) => ({ method: r.method, answer: r.answer, answeredAt: r.answeredAt?.toISOString() ?? null, invited: r.invitedAddress }))
    .sort((a, b) => `${a.method}${a.answeredAt}`.localeCompare(`${b.method}${b.answeredAt}`));
}

describe("the door: one invitation per letter", () => {
  it("writes the row as read, the invitee as the invitation spelled the mailbox's address", async () => {
    const w = await doorWorld();
    const messageId = await w.letter();
    expect(await writeInvitation(w.db, { accountId: w.accountId, messageId, ...REQUEST })).toEqual({ written: true, touched: [] });
    const [row] = await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId));
    expect(row).toMatchObject({
      mailboxId: w.mailboxId, uid: REQUEST.uid, recurrenceId: "", sequence: 2, method: "REQUEST", startRaw: "20261201T100000Z",
      startsAt: REQUEST.startsAt, organizer: "tobias@studio.example", invitedAddress: "Mila@Lichtgrat.example",
      answer: null, answeredAt: null,
    });
    // The same letter twice: the row stands, nothing is written again.
    expect(await writeInvitation(w.db, { accountId: w.accountId, messageId, ...REQUEST, sequence: 9 })).toEqual({ written: false, touched: [] });
    expect((await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId)))[0]!.sequence).toBe(2);
  });

  it("a REQUEST and the person's own replies, stored in every order, end in the same rows", async () => {
    const letters = [
      { key: "request", write: REQUEST },
      { key: "yes", write: replyOf("accepted", "2026-11-11T08:00:00Z") },
      { key: "no", write: replyOf("declined", "2026-11-12T08:00:00Z") },
    ];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const ends: unknown[] = [];
    for (const order of orders) {
      const w = await doorWorld();
      for (const i of order) await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...letters[i]!.write });
      ends.push(await rowsOf(w.db, w.accountId));
    }
    for (const end of ends) expect(end).toEqual(ends[0]);
    expect(ends[0]).toContainEqual({ method: "REQUEST", answer: "declined", answeredAt: "2026-11-12T08:00:00.000Z", invited: "Mila@Lichtgrat.example" });
  });

  it("the person's own reply names the REQUEST it changed; one not read from Sent records nothing", async () => {
    const w = await doorWorld();
    const request = await w.letter();
    await writeInvitation(w.db, { accountId: w.accountId, messageId: request, ...REQUEST });
    const foreign = await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...replyOf("accepted", "2026-11-11T08:00:00Z", false) });
    expect(foreign).toEqual({ written: true, touched: [] });
    expect((await rowsOf(w.db, w.accountId)).find((r) => r.method === "REQUEST")).toMatchObject({ answer: null });
    const own = await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...replyOf("tentative", "2026-11-11T09:00:00Z") });
    expect(own).toEqual({ written: true, touched: [request] });
  });

  it("an answer is recorded only on the invitation of the organizer it answers, whichever letter came first", async () => {
    // One event (one UID, one revision) asked for by two organizers; any invitee can write the second.
    const OTHER = "eve@forged.example";
    const answerOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, messageId: string) =>
      (await db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId)))[0]!.answer;
    // The person's reply to the other organizer, stored first: only that organizer's invitation takes it.
    const w = await doorWorld();
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...replyOf("accepted", "2026-11-11T08:00:00Z"), organizer: OTHER });
    const [ours, theirs] = [await w.letter(), await w.letter()];
    await writeInvitation(w.db, { accountId: w.accountId, messageId: ours, ...REQUEST });
    await writeInvitation(w.db, { accountId: w.accountId, messageId: theirs, ...REQUEST, organizer: OTHER });
    expect([await answerOf(w.db, ours), await answerOf(w.db, theirs)]).toEqual([null, "accepted"]);
    // Both invitations stored first: the reply names only the other organizer's.
    const v = await doorWorld();
    const [mine, forged] = [await v.letter(), await v.letter()];
    await writeInvitation(v.db, { accountId: v.accountId, messageId: mine, ...REQUEST });
    await writeInvitation(v.db, { accountId: v.accountId, messageId: forged, ...REQUEST, organizer: OTHER });
    const reply = await writeInvitation(v.db, { accountId: v.accountId, messageId: await v.letter(), ...replyOf("declined", "2026-11-11T08:00:00Z"), organizer: OTHER });
    expect(reply.touched).toEqual([forged]);
    expect([await answerOf(v.db, mine), await answerOf(v.db, forged)]).toEqual([null, "declined"]);
    // A reply that names no organizer answers nobody, before or after the invitation.
    const u = await doorWorld();
    const asked = await u.letter();
    await writeInvitation(u.db, { accountId: u.accountId, messageId: asked, ...REQUEST });
    expect((await writeInvitation(u.db, { accountId: u.accountId, messageId: await u.letter(), ...replyOf("accepted", "2026-11-11T08:00:00Z"), organizer: null })).touched).toEqual([]);
    const later = await u.letter();
    await writeInvitation(u.db, { accountId: u.accountId, messageId: later, ...REQUEST });
    expect([await answerOf(u.db, asked), await answerOf(u.db, later)]).toEqual([null, null]);
  });

  it("an answer at another revision or occurrence is no answer to this one", async () => {
    const w = await doorWorld();
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST });
    expect((await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...replyOf("accepted", "2026-11-11T08:00:00Z"), sequence: 1 })).touched).toEqual([]);
    expect((await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...replyOf("accepted", "2026-11-11T08:00:00Z"), recurrenceId: "1796119200000" })).touched).toEqual([]);
  });

  it("a value past a bound writes no row, throws nothing, and leaves the transaction usable", async () => {
    const w = await doorWorld();
    const at1024 = `${"u".repeat(1024 - "@x.example".length)}@x.example`;
    const cases = [
      { uid: `${at1024}x` }, { uid: `${"é".repeat(512)}x` }, { uid: "a\u0000b@x.example" }, { uid: "" },
      { recurrenceId: "z".repeat(321) }, { recurrenceId: "a b" }, { sequence: 2 ** 31 }, { sequence: -1 }, { sequence: 1.5 },
      { startRaw: "TZID=Europe/Zurich:20261201T110000" }, { organizer: `${"o".repeat(250)}@x.example` }, { organizer: "o\u0000@x.example" },
      { method: "PUBLISH" }, { startsAt: new Date(Number.NaN) }, { stampedAt: new Date(Number.NaN) },
    ];
    const letters: string[] = [];
    for (let i = 0; i <= cases.length; i++) letters.push(await w.letter());
    await w.db.transaction(async (tx) => {
      for (const [i, bad] of cases.entries()) {
        expect(await writeInvitation(tx as never, { accountId: w.accountId, messageId: letters[i]!, ...REQUEST, ...bad } as never), JSON.stringify(bad))
          .toEqual({ written: false, touched: [] });
      }
      expect((await writeInvitation(tx as never, { accountId: w.accountId, messageId: letters[cases.length]!, ...REQUEST, uid: at1024 })).written).toBe(true);
    });
    expect((await w.db.select().from(messageInvitations).where(eq(messageInvitations.accountId, w.accountId))).map((r) => r.uid)).toEqual([at1024]);
  });

  it("another account's letter gets no row", async () => {
    const w = await doorWorld();
    const other = await doorWorld();
    const theirs = await other.letter();
    // The same store for both worlds is not needed: an id this account does not own is simply absent.
    expect(await writeInvitation(w.db, { accountId: w.accountId, messageId: theirs, ...REQUEST })).toEqual({ written: false, touched: [] });
    expect(await writeInvitation(other.db, { accountId: w.accountId, messageId: theirs, ...REQUEST })).toEqual({ written: false, touched: [] });
  });
});

describe("the door: who was invited", () => {
  const invited = async (address: string, attendees: readonly string[], organizer = "tobias@studio.example") => {
    const w = await doorWorld(address);
    const messageId = await w.letter();
    await writeInvitation(w.db, { accountId: w.accountId, messageId, ...REQUEST, organizer, attendees });
    return (await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId)))[0]?.invitedAddress ?? null;
  };

  it("the mailbox's address in any ASCII case, as the invitation spelled it", async () => {
    expect(await invited(ME, ["MILA@LICHTGRAT.EXAMPLE"])).toBe("MILA@LICHTGRAT.EXAMPLE");
    expect(await invited("Mila@Lichtgrat.Example", [ME])).toBe(ME);
  });

  it("never a lookalike: another letter case, another form, another address", async () => {
    expect(await invited("kelvin@lichtgrat.example", ["Kelvin@lichtgrat.example"])).toBeNull();
    expect(await invited(ME, ["ｍila@lichtgrat.example"])).toBeNull();
    expect(await invited("ivo@lichtgrat.example", ["ıvo@lichtgrat.example"])).toBeNull();
    expect(await invited(ME, [`${ME}.`])).toBeNull();
    expect(await invited(ME, ["mila+cal@lichtgrat.example"])).toBeNull();
    expect(await invited(ME, ["m.ila@lichtgrat.example"])).toBeNull();
    expect(await invited(ME, ["someone@lichtgrat.example"])).toBeNull();
  });

  it("a forwarded invitation, the person's own event and a mailbox without an address name nobody", async () => {
    expect(await invited(ME, ["someone-else@studio.example"])).toBeNull();
    expect(await invited(ME, [ME, "tobias@studio.example"], ME)).toBeNull();
    expect(await invited("", [ME, ""])).toBeNull();
  });

  it("a reply names the replier only on the person's own reply, and only as its first attendee", async () => {
    const w = await doorWorld();
    const own = await w.letter();
    await writeInvitation(w.db, { accountId: w.accountId, messageId: own, ...replyOf("accepted", "2026-11-11T08:00:00Z") });
    const second = await w.letter();
    await writeInvitation(w.db, { accountId: w.accountId, messageId: second, ...replyOf("accepted", "2026-11-11T08:00:00Z"), attendees: ["x@y.example", ME] });
    const rows = await w.db.select().from(messageInvitations).where(eq(messageInvitations.accountId, w.accountId));
    expect(rows.find((r) => r.messageId === own)?.invitedAddress).toBe(ME);
    expect(rows.find((r) => r.messageId === second)?.invitedAddress).toBeNull();
  });
});

describe("what stands of an invitation, and the desktop's copy", () => {
  it("a cancel from the same organizer at this revision or later cancels; a forged one does not", async () => {
    const w = await doorWorld();
    const ask = { accountId: w.accountId, mailboxId: w.mailboxId, uid: REQUEST.uid, recurrenceId: "", sequence: 2, organizer: "tobias@studio.example", stampedAt: null };
    expect(await invitationStanding(w.db, ask)).toEqual({ cancelled: false, replacedBy: null });
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST, method: "CANCEL", organizer: "mallory@evil.example" });
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST, method: "CANCEL", sequence: 1 });
    expect((await invitationStanding(w.db, ask)).cancelled).toBe(false);
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST, method: "CANCEL", organizer: "Tobias@Studio.example" });
    expect((await invitationStanding(w.db, ask)).cancelled).toBe(true);
  });

  it("a cancel cancels only what was written before it: removed from the event, then invited again", async () => {
    // The calendar standard orders an event's letters by SEQUENCE, and one SEQUENCE by DTSTAMP.
    const w = await doorWorld();
    const at = (iso: string): Date => new Date(iso);
    const ask = (sequence: number, stampedAt: Date | null) => ({
      accountId: w.accountId, mailboxId: w.mailboxId, uid: REQUEST.uid, recurrenceId: "", sequence, organizer: "tobias@studio.example", stampedAt,
    });
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST, sequence: 0, stampedAt: at("2026-11-10T08:00:00Z") });
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST, method: "CANCEL", sequence: 0, stampedAt: at("2026-11-11T08:00:00Z") });
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST, sequence: 0, stampedAt: at("2026-11-13T08:00:00Z") });
    expect((await invitationStanding(w.db, ask(0, at("2026-11-10T08:00:00Z")))).cancelled).toBe(true);
    expect(await invitationStanding(w.db, ask(0, at("2026-11-13T08:00:00Z")))).toEqual({ cancelled: false, replacedBy: null });
    // One revision that cannot be ordered (a stamp missing, or the same stamp): the cancel stands.
    expect((await invitationStanding(w.db, ask(0, null))).cancelled).toBe(true);
    expect((await invitationStanding(w.db, ask(0, at("2026-11-11T08:00:00Z")))).cancelled).toBe(true);
    // A cancel at a higher revision is the later letter, whenever it was stamped.
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST, method: "CANCEL", sequence: 1, stampedAt: at("2026-11-12T08:00:00Z") });
    expect((await invitationStanding(w.db, ask(0, at("2026-11-13T08:00:00Z")))).cancelled).toBe(true);
  });

  it("a later revision replaces, named; the same revision again does not", async () => {
    const w = await doorWorld();
    const ask = { accountId: w.accountId, mailboxId: w.mailboxId, uid: REQUEST.uid, recurrenceId: "", sequence: 2, organizer: "tobias@studio.example", stampedAt: null };
    await writeInvitation(w.db, { accountId: w.accountId, messageId: await w.letter(), ...REQUEST });
    expect((await invitationStanding(w.db, ask)).replacedBy).toBeNull();
    const three = await w.letter();
    await writeInvitation(w.db, { accountId: w.accountId, messageId: three, ...REQUEST, sequence: 3 });
    const occurrence = await w.letter();
    await writeInvitation(w.db, { accountId: w.accountId, messageId: occurrence, ...REQUEST, sequence: 7, recurrenceId: "1796119200000" });
    expect(await invitationStanding(w.db, ask)).toEqual({ cancelled: false, replacedBy: three });
  });

  it("the copy writes the field's row, replaces it, and deletes it when the field is gone", async () => {
    const w = await doorWorld();
    const messageId = await w.letter();
    const of = { accountId: w.accountId, messageId, mailboxId: w.mailboxId };
    const field = {
      method: "REQUEST" as const, uid: REQUEST.uid, recurrenceId: "", sequence: 2, start: "20261201T100000Z",
      startsAt: "2026-12-01T10:00:00.000Z", organizer: "tobias@studio.example", invitedAddress: ME,
      answer: "accepted" as const, answeredAt: "2026-11-11T08:00:00.000Z",
    };
    await putInvitationCopy(w.db, of, field);
    const [row] = await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId));
    expect(invitationFieldOf(row!)).toEqual(field);
    await putInvitationCopy(w.db, of, { ...field, answer: "declined" });
    expect((await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId)))[0]!.answer).toBe("declined");
    await putInvitationCopy(w.db, of, undefined);
    expect(await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId))).toEqual([]);
  });
});
