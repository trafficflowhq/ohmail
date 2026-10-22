import { describe, expect, it } from "vitest";
import {
  FOLDER_OF_VIEW,
  isOwnOutbound,
  threadMarksIndex,
  threadOf,
  type EngineMessage,
  type EntityReader,
} from "@ohmail/client-engine";

/**
 * THE SQUARES A CONVERSATION'S ROW AND COLUMN DRAW — one mark per message, oldest first: unread,
 * read, or the account's own. Membership is the conversation a placed message opens (`threadOf`):
 * held strangers out, our own twin copies collapsed. A conversation of one has no marks.
 */

const SENT = "Sent" as EngineMessage["folder"];
const HELD = FOLDER_OF_VIEW.screener;

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", arrivedAt: "2026-08-01T09:00:00.000Z",
    folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    ...p,
  } as EngineMessage;
}
const at = (n: number): string => new Date(Date.UTC(2026, 7, 1, 9, n)).toISOString();

function readerOf(messages: EngineMessage[], version = { v: 1 }): EntityReader {
  return {
    list: <T,>(type: string) => (type === "message" ? messages : []) as T[],
    get: <T,>(type: string, id: string) => (type === "message" ? messages.find((m) => m.id === id) : undefined) as T | undefined,
    entries: <T,>(type: string) => (type === "message" ? messages : []).map((entity, i) => ({ id: entity.id, entity: entity as T, seq: i })),
    version: () => version.v,
  } as unknown as EntityReader;
}

describe("isOwnOutbound", () => {
  it("is the engine's own send record or the Sent folder", () => {
    expect(isOwnOutbound(mkMsg({ id: "a" }))).toBe(false);
    expect(isOwnOutbound(mkMsg({ id: "b", folder: SENT }))).toBe(true);
    expect(isOwnOutbound(mkMsg({ id: "c", local: true } as Partial<EngineMessage> & { id: string }))).toBe(true);
  });
});

describe("threadMarksIndex", () => {
  it("one mark per member, oldest first: unread, read, mine", () => {
    const msgs = [
      mkMsg({ id: "m3", date: at(3), unread: true }),
      mkMsg({ id: "m1", date: at(1) }),
      mkMsg({ id: "m2", date: at(2), folder: SENT }),
      mkMsg({ id: "m4", date: at(4), unread: true }),
    ];
    expect(threadMarksIndex(readerOf(msgs)).get("T")).toEqual(["read", "mine", "unread", "unread"]);
  });

  it("unread wins over mine", () => {
    const msgs = [mkMsg({ id: "m1", date: at(1), folder: SENT, unread: true }), mkMsg({ id: "m2", date: at(2) })];
    expect(threadMarksIndex(readerOf(msgs)).get("T")).toEqual(["unread", "read"]);
  });

  it("a conversation of one has no entry, and neither has a message with no thread", () => {
    const msgs = [mkMsg({ id: "s1", threadId: "S" }), mkMsg({ id: "n1", threadId: null })];
    const index = threadMarksIndex(readerOf(msgs));
    expect(index.has("S")).toBe(false);
    expect(index.size).toBe(0);
  });

  it("the members are threadOf's for a placed message: a held stranger out, our twin copies collapsed", () => {
    const stranger = { name: "S", address: "s@elsewhere.invalid" };
    const msgs = [
      mkMsg({ id: "p1", date: at(1), unread: true }),
      mkMsg({ id: "h1", date: at(2), folder: HELD, from: stranger, unread: true }),
      mkMsg({ id: "o1", date: at(3), folder: SENT, messageIdHeader: "<twin@example.invalid>" }),
      mkMsg({ id: "o2", date: at(3), folder: SENT, messageIdHeader: "<twin@example.invalid>" }),
      mkMsg({ id: "p2", date: at(4) }),
    ];
    const reader = readerOf(msgs);
    const opened = threadOf(reader, "p1");
    expect(opened.map((m) => m.id), "the control: what the open shows").toEqual(["p1", "o1", "p2"]);
    expect(threadMarksIndex(reader).get("T")).toEqual(["unread", "mine", "read"]);
  });

  it("is one pass per version: the same map until the mirror moves", () => {
    const version = { v: 1 };
    const msgs = [mkMsg({ id: "m1", date: at(1) }), mkMsg({ id: "m2", date: at(2), unread: true })];
    const reader = readerOf(msgs, version);
    const first = threadMarksIndex(reader);
    expect(threadMarksIndex(reader)).toBe(first);
    msgs[1] = { ...msgs[1]!, unread: false };
    version.v = 2;
    const next = threadMarksIndex(reader);
    expect(next).not.toBe(first);
    expect(next.get("T")).toEqual(["read", "read"]);
  });
});
