import { describe, expect, it } from "vitest";
import {
  FOLDER_OF_VIEW, pileSubjectIds, ohboxRows, ownFaceOfRow, resurfacedFocus, rowOpenTarget, triageSubjectIds,
  type EngineMessage, type EntityReader, type MessageStateDTO, type OhboxRow,
} from "@ohmail/client-engine";

/**
 * AN ANSWERED CONVERSATION'S ROW STANDS FOR THE LETTER. All read, its newest
 * member our own reply: the row still shows the reply, but it opens at, and every triage verb
 * files, the newest letter somebody else wrote. Standing for the reply, Later filed the reply and
 * left the letter in the Ohbox. Our reply flagged unread (a row's Mark unread over every member
 * left it so) is no letter either: the row goes on standing for the letter.
 */

const SENT = "Sent" as EngineMessage["folder"];
const LENA = { name: "Lena", address: "lena@example.invalid" };
const KAI = { name: "Kai", address: "kai@example.invalid" };
const ME = { name: "Me", address: "me@example.invalid" };
const SET_AT = "2026-09-20T12:00:00.000Z";

function msg(p: Partial<EngineMessage> & { id: string; at: string }): EngineMessage {
  const { at, ...rest } = p;
  return {
    accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
    from: LENA, to: [ME], cc: [], date: at, arrivedAt: at, folder: FOLDER_OF_VIEW.ohbox, snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
    ...rest,
  } as EngineMessage;
}
const own = (id: string, at: string, over: Partial<EngineMessage> = {}): EngineMessage =>
  msg({ id, at, folder: SENT, from: ME, to: [LENA], subject: "Re: Q3 plan", ...over });
const pinned = (m: EngineMessage): EngineMessage =>
  ({ ...m, triage: { messageId: m.id, state: "resurfaced", bubbleUpAt: null, setAt: SET_AT, updatedAt: SET_AT } });

function readerOf(messages: EngineMessage[]): EntityReader {
  const states = messages.flatMap((m) => (m.triage ? [m.triage as MessageStateDTO] : []));
  const byType: Record<string, unknown[]> = { message: messages, message_state: states, thread: [] };
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) => (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({ id: (entity as { id: string }).id, entity: entity as T, seq: i })),
    version: () => 1,
  } as unknown as EntityReader;
}
const rowFor = (reader: EntityReader, key: string): OhboxRow => {
  const row = Object.values(ohboxRows(reader)).flat().find((r) => r.key === key);
  expect(row, `a row for ${key}`).toBeTruthy();
  return row!;
};

const letter = msg({ id: "a1", at: "2026-09-20T08:00:00.000Z" });
const reply = own("r2", "2026-09-20T09:00:00.000Z");

describe("an answered, all-read conversation's row", () => {
  it("shows our reply and stands for the letter", () => {
    const row = rowFor(readerOf([letter, reply]), "T");
    expect(row.section).toBe("earlier");
    expect(row.face.id, "the face is unchanged").toBe("r2");
    expect(row.openTarget.id).toBe("a1");
  });

  it("two senders, then our reply: the newer sender's letter", () => {
    const kai = msg({ id: "b2", at: "2026-09-20T08:30:00.000Z", from: KAI });
    const row = rowFor(readerOf([letter, kai, own("r3", "2026-09-20T09:00:00.000Z")]), "T");
    expect(row.face.id).toBe("r3");
    expect(row.openTarget.id).toBe("b2");
  });

  it("the target is the Resurfaced rule's own focus over the same members", () => {
    for (const ms of [[letter, reply], [letter, msg({ id: "b2", at: "2026-09-20T08:30:00.000Z", from: KAI }), own("r3", "2026-09-20T09:00:00.000Z")]]) {
      const row = rowFor(readerOf(ms), "T");
      expect(row.openTarget.id).toBe(resurfacedFocus(row.members).id);
    }
  });

  it("opened from the row, the conversation is acted on at the letter", () => {
    const reader = readerOf([letter, reply]);
    expect(rowOpenTarget(reader, rowFor(reader, "T").openTarget).id).toBe("a1");
  });
});

describe("our own reply flagged unread (a row's Mark unread can leave one): the row stands for the letter", () => {
  const unread = (m: EngineMessage): EngineMessage => ({ ...m, unread: true });

  it("the letter and our reply both unread: the letter", () => {
    const row = rowFor(readerOf([unread(letter), unread(reply)]), "T");
    expect(row.section).toBe("new");
    expect(row.face.id, "the face is unchanged").toBe("r2");
    expect(row.openTarget.id).toBe("a1");
  });

  it("only our reply unread: the letter", () => {
    const row = rowFor(readerOf([letter, unread(reply)]), "T");
    expect(row.section).toBe("earlier");
    expect(row.openTarget.id).toBe("a1");
  });

  it("two senders read, our reply unread: the newer sender's letter", () => {
    const kai = msg({ id: "b2", at: "2026-09-20T08:30:00.000Z", from: KAI });
    const row = rowFor(readerOf([letter, kai, unread(own("r3", "2026-09-20T09:00:00.000Z"))]), "T");
    expect(row.openTarget.id).toBe("b2");
  });

  it("CONTROL: a calendar acknowledgement somebody else sent, unread, stays the target", () => {
    const ack = msg({
      id: "k3", at: "2026-09-20T10:00:00.000Z", from: KAI, subject: "Accepted: Q3 plan", itipReplyHeader: true, unread: true,
    });
    const row = rowFor(readerOf([letter, reply, ack]), "T");
    expect(row.openTarget.id).toBe("k3");
  });

  it("CONTROL: our own mail alone, one copy unread: that copy", () => {
    const row = rowFor(readerOf([unread(own("r1", "2026-09-20T07:00:00.000Z")), own("r2", "2026-09-20T09:00:00.000Z")]), "T");
    expect([row.face.id, row.openTarget.id]).toEqual(["r2", "r1"]);
  });
});

describe("CONTROLS: where the row already stood for the right message", () => {
  it("the letter unread beside a newer own reply: the unread letter", () => {
    const row = rowFor(readerOf([{ ...letter, unread: true }, reply]), "T");
    expect(row.section).toBe("new");
    expect(row.openTarget.id).toBe("a1");
  });

  it("a face somebody else wrote: the face", () => {
    const row = rowFor(readerOf([own("r1", "2026-09-20T07:00:00.000Z"), letter]), "T");
    expect([row.face.id, row.openTarget.id]).toEqual(["a1", "a1"]);
  });

  it("a conversation of our own mail alone: our newest", () => {
    const row = rowFor(readerOf([own("r1", "2026-09-20T07:00:00.000Z"), own("r2", "2026-09-20T09:00:00.000Z")]), "T");
    expect([row.face.id, row.openTarget.id]).toEqual(["r2", "r2"]);
  });

  it("a threadless message: itself", () => {
    const solo = msg({ id: "s1", at: "2026-09-20T08:00:00.000Z", threadId: null });
    const row = rowFor(readerOf([solo]), "msg:s1");
    expect(row.openTarget.id).toBe("s1");
  });

  it("a Resurfaced row ending in our reply: its focus, the letter", () => {
    const row = rowFor(readerOf([pinned(letter), reply]), "T");
    expect(row.section).toBe("resurfaced");
    expect([row.face.id, row.openTarget.id]).toEqual(["a1", "a1"]);
  });
});

describe("triageSubjectIds: what a press over a set files", () => {
  const note = own("n1", "2026-09-20T10:00:00.000Z", { threadId: "N", subject: "Note" });
  const reader = readerOf([letter, reply, note]);

  it("drops our reply when the set also carries its conversation's letter", () => {
    expect(triageSubjectIds(reader, ["r2", "a1"])).toEqual(["a1"]);
  });
  it("keeps our mail with no letter beside it, ids it does not know, and the order", () => {
    expect(triageSubjectIds(reader, ["r2"])).toEqual(["r2"]);
    expect(triageSubjectIds(reader, ["n1", "gone", "a1", "r2"])).toEqual(["n1", "gone", "a1"]);
  });
});

describe("ownFaceOfRow: our reply facing the row a message stands for", () => {
  it("the letter of an answered row: our reply", () => {
    expect(ownFaceOfRow(readerOf([letter, reply]), letter)?.id).toBe("r2");
  });
  it("our reply itself, an unanswered letter, a threadless message: null", () => {
    expect(ownFaceOfRow(readerOf([letter, reply]), reply)).toBeNull();
    expect(ownFaceOfRow(readerOf([letter]), letter)).toBeNull();
    const solo = msg({ id: "s1", at: "2026-09-20T08:00:00.000Z", threadId: null });
    expect(ownFaceOfRow(readerOf([solo]), solo)).toBeNull();
  });
  it("a letter still unread under our newer reply, or read at the open and held: null", () => {
    expect(ownFaceOfRow(readerOf([{ ...letter, unread: true }, reply]), { ...letter, unread: true })).toBeNull();
    expect(ownFaceOfRow(readerOf([letter, reply]), letter, "a1")).toBeNull();
  });
  it("our reply the only unread member: the letter's row is still faced by our reply", () => {
    expect(ownFaceOfRow(readerOf([letter, { ...reply, unread: true }]), letter)?.id).toBe("r2");
  });
});

describe("pileSubjectIds: what a pile press on a row's message files", () => {
  const kai = msg({ id: "b2", at: "2026-09-20T08:30:00.000Z", from: KAI });
  const parked = msg({
    id: "c0", at: "2026-09-20T07:00:00.000Z",
    triage: { messageId: "c0", state: "set_aside", bubbleUpAt: null, setAt: SET_AT, updatedAt: SET_AT },
  });

  it("a conversation with two members in the Ohbox and one parked: both Ohbox members, from either", () => {
    const reader = readerOf([parked, letter, kai]);
    expect(pileSubjectIds(reader, "b2").sort()).toEqual(["a1", "b2"]);
    expect(pileSubjectIds(reader, "a1").sort()).toEqual(["a1", "b2"]);
  });
  it("an answered row: every member, our reply too, so the row leaves", () => {
    expect(pileSubjectIds(readerOf([letter, reply]), "a1").sort()).toEqual(["a1", "r2"]);
    const kai3 = msg({ id: "b3", at: "2026-09-20T10:00:00.000Z", from: KAI });
    expect(pileSubjectIds(readerOf([letter, reply, kai3]), "b3").sort()).toEqual(["a1", "b3", "r2"]);
  });
  it("a Resurfaced row: never a member filed in a pile or another folder", () => {
    const archived = msg({ id: "o1", at: "2026-09-20T06:00:00.000Z", folder: "Archive" as EngineMessage["folder"] });
    const later = msg({
      id: "l2", at: "2026-09-20T07:30:00.000Z",
      triage: { messageId: "l2", state: "reply_later", bubbleUpAt: null, setAt: SET_AT, updatedAt: SET_AT },
    });
    const p3 = pinned(msg({ id: "p3", at: "2026-09-20T09:30:00.000Z", from: KAI }));
    const reader = readerOf([archived, later, p3]);
    expect(rowFor(reader, "T").members.map((m) => m.id).sort(), "the premise").toEqual(["l2", "o1", "p3"]);
    expect(pileSubjectIds(reader, "p3")).toEqual(["p3"]);
    expect(pileSubjectIds(reader, "o1"), "pressed on the archived member: itself").toEqual(["o1"]);
  });
  it("a parked message: every parked member of its conversation, nothing standing beside it", () => {
    const p3 = pinned(msg({ id: "p3", at: "2026-09-20T09:30:00.000Z", from: KAI }));
    expect(pileSubjectIds(readerOf([parked, p3]), "c0")).toEqual(["c0"]);
    const parked2 = { ...kai, triage: { messageId: "b2", state: "set_aside" as const, bubbleUpAt: null, setAt: SET_AT, updatedAt: SET_AT } };
    expect(pileSubjectIds(readerOf([parked, letter, parked2]), "b2").sort()).toEqual(["b2", "c0"]);
  });
  it("a message no Ohbox row holds, a lone message, an unknown id: itself", () => {
    expect(pileSubjectIds(readerOf([parked, letter, kai]), "c0")).toEqual(["c0"]);
    expect(pileSubjectIds(readerOf([msg({ id: "s1", at: SET_AT, threadId: null })]), "s1")).toEqual(["s1"]);
    expect(pileSubjectIds(readerOf([letter]), "gone")).toEqual(["gone"]);
  });
  const filed = (m: EngineMessage, state: MessageStateDTO["state"]): EngineMessage =>
    ({ ...m, triage: { messageId: m.id, state, bubbleUpAt: null, setAt: SET_AT, updatedAt: SET_AT } });
  it("in Answer later or Parked: the pile's row from any member, the pressed id first, our reply included", () => {
    for (const state of ["reply_later", "set_aside"] as const) {
      const reader = readerOf([filed(letter, state), filed(reply, state), filed(kai, state)]);
      for (const id of ["a1", "b2", "r2"]) {
        const set = pileSubjectIds(reader, id, null, false);
        expect(set[0]).toBe(id);
        expect([...set].sort()).toEqual(["a1", "b2", "r2"]);
      }
    }
  });
  it("a member in the other pile, or booked in Resurface, is not on the row", () => {
    const reader = readerOf([filed(letter, "set_aside"), filed(reply, "reply_later"), filed(kai, "bubbled_up")]);
    expect(pileSubjectIds(reader, "a1")).toEqual(["a1"]);
    expect(pileSubjectIds(reader, "r2")).toEqual(["r2"]);
    expect(pileSubjectIds(reader, "b2"), "Resurface stays per message").toEqual(["b2"]);
  });
  it("off the Ohbox, a message standing in an Ohbox row is itself", () => {
    const reader = readerOf([letter, reply]);
    expect(pileSubjectIds(reader, "a1", null, false)).toEqual(["a1"]);
    expect(pileSubjectIds(reader, "a1").sort()).toEqual(["a1", "r2"]);
  });
  it("a held member stays a row of its own", () => {
    const held = filed(msg({ id: "h3", at: "2026-09-20T10:00:00.000Z", folder: "ohmail/Screener" as EngineMessage["folder"] }), "set_aside");
    const reader = readerOf([filed(letter, "set_aside"), held]);
    expect(pileSubjectIds(reader, "h3")).toEqual(["h3"]);
    expect(pileSubjectIds(reader, "a1")).toEqual(["a1"]);
  });
  it("our reply still on its way (a local copy) is left out of the Ohbox row's set", () => {
    const local = own("l3", "2026-09-20T10:00:00.000Z", { local: true });
    expect(pileSubjectIds(readerOf([letter, reply, local]), "a1").sort()).toEqual(["a1", "r2"]);
  });
});
