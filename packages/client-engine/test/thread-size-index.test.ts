import type { EngineMessage, MessageStateDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  FOLDER_OF_VIEW,
  conversationSize,
  ohboxRows,
  resurfacedThreads,
  rowOpenTarget,
  threadOf,
  threadSizeIndex,
  type EntityReader,
} from "@ohmail/client-engine";

/** The fixture's ids, built from their numbers. */
const tid = (n: number): string => `T${n}`;

/**
 * HOW LONG A CONVERSATION IS — one derivation, for the badge every surface draws and the sentence
 * every surface reads out. The phone's list rows had no count at all (their projection carries it
 * now) and the web's Resurfaced row already had one; two derivations of one number drift, so
 * `resurfacedThreads` reads this index rather than counting again, and the last case here holds
 * the two together.
 */

const OHBOX = "INBOX";
const SENT = "Sent" as EngineMessage["folder"];

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", arrivedAt: "2026-08-01T09:00:00.000Z",
    folder: OHBOX, snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    ...p,
  } as EngineMessage;
}

/** A hand-built reader over a flat entity list, with a movable version. */
function readerOf(byType: Record<string, unknown[]>, version = 1): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) =>
      (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => version,
  } as unknown as EntityReader;
}

describe("the conversation's length, once", () => {
  /**
   * CONTROL. MUTATION WATCHED: answer `n` instead of `n > 1 ? n : 0` in `conversationSize` and the
   * lone message reports 1, which every surface draws as a "conversation" of one.
   */
  it("says nothing about a row standing for one message", () => {
    const alone = mkMsg({ id: "a1" });
    const solo = mkMsg({ id: "a2", threadId: "T-solo" });
    const reader = readerOf({ message: [alone, solo] });
    expect(conversationSize(reader, alone)).toBe(0);
    expect(conversationSize(reader, solo)).toBe(0);
    expect(threadSizeIndex(reader).get("T-solo")).toEqual({ count: 1, whole: 1, fromThread: false });
  });

  it("counts the members the mirror holds where there is no thread row", () => {
    const msgs = [
      mkMsg({ id: "m1", threadId: tid(1) }),
      mkMsg({ id: "m2", threadId: tid(1) }),
      mkMsg({ id: "m3", threadId: tid(1) }),
    ];
    const reader = readerOf({ message: msgs });
    expect(conversationSize(reader, msgs[0]!)).toBe(3);
    expect(threadSizeIndex(reader).get(tid(1))).toEqual({ count: 3, whole: 3, fromThread: false });
  });

  /**
   * MUTATION WATCHED: drop the `thread` lookup and the windowed mirror answers 3 for a
   * conversation of nine — the number a person reads off the row.
   */
  it("takes the SERVER's length where the mirror holds the thread row", () => {
    const msgs = [mkMsg({ id: "m1", threadId: tid(1) }), mkMsg({ id: "m2", threadId: tid(1) })];
    const reader = readerOf({
      message: msgs,
      thread: [{ id: tid(1), messageIds: ["x1", "x2", "m1", "m2", "x3", "x4", "x5", "x6", "x7"] }],
    });
    expect(conversationSize(reader, msgs[0]!)).toBe(9);
    expect(threadSizeIndex(reader).get(tid(1))).toEqual({ count: 9, whole: 9, fromThread: true });
  });

  /** The account's own reply is a message in the conversation — the web counted it, and so does this. */
  it("counts the account's own replies, exactly as the server counts them", () => {
    const msgs = [
      mkMsg({ id: "m1", threadId: tid(1) }),
      mkMsg({ id: "m2", threadId: tid(1), folder: SENT, from: { name: "Me", address: "me@example.invalid" } }),
    ];
    expect(conversationSize(readerOf({ message: msgs }), msgs[0]!)).toBe(2);
  });

  it("builds the index once per version", () => {
    const reader = readerOf({ message: [mkMsg({ id: "m1", threadId: tid(1) })] });
    expect(threadSizeIndex(reader)).toBe(threadSizeIndex(reader));
  });

  /**
   * THE TWO SURFACES' ONE NUMBER, asked of a reader whose thread row disagrees with the mirror.
   * MUTATION WATCHED: drop the thread lookup in `threadSizeIndex` and both readings fall to 2 —
   * the Resurfaced row's count reddens here and in `resurfaced-threads.test.ts`, which is the
   * proof that the row reads this index rather than counting a second time.
   */
  it("gives the Resurfaced row the same count a list row gets", () => {
    const msgs = [
      mkMsg({ id: "m1", threadId: tid(1), date: "2026-08-01T09:00:00.000Z" }),
      mkMsg({ id: "m2", threadId: tid(1), date: "2026-08-02T09:00:00.000Z" }),
    ];
    const claim: MessageStateDTO = {
      messageId: "m1", state: "resurfaced" as MessageStateDTO["state"],
      bubbleUpAt: null, setAt: "2026-09-02T08:00:00.000Z", updatedAt: "2026-09-02T08:00:00.000Z",
    };
    const reader = readerOf({
      message: msgs.map((m) => (m.id === "m1" ? { ...m, triage: claim } : m)),
      message_state: [claim],
      thread: [{ id: tid(1), messageIds: ["m0", "m1", "m2"] }],
    });
    const row = resurfacedThreads(reader)[0]!;
    expect(row.count).toBe(3);
    expect(row.countFromThread).toBe(true);
    expect(row.count).toBe(conversationSize(reader, msgs[0]!));
  });
});

/**
 * THE COUNT IS THE CONVERSATION THE ROW OPENS (THREAD-SIZE-COUNTS-A-HELD-MEMBER). A held member
 * stands in no Ohbox row and in no conversation one opens, so it is not counted, with or without
 * the server's thread row. MUTATION WATCHED: count every member again and the first case reads 2.
 */
describe("a held member is not counted", () => {
  const HELD = FOLDER_OF_VIEW.screener;
  const stranger = { name: "S", address: "s@elsewhere.invalid" };
  const p1 = mkMsg({ id: "p1", threadId: "T", unread: true, date: "2026-09-20T08:00:00.000Z" });
  const p2 = mkMsg({ id: "p2", threadId: "T", folder: SENT, date: "2026-09-20T08:30:00.000Z" });
  const h1 = mkMsg({ id: "h1", threadId: "T", folder: HELD, from: stranger, unread: true, date: "2026-09-20T09:00:00.000Z" });
  const withRow = (ids: string[]) => ({ thread: [{ id: "T", messageIds: ids }] });

  it("a placed message and a held one read as one, as the opened conversation shows", () => {
    for (const extra of [{}, withRow(["p1", "h1"])]) {
      const reader = readerOf({ message: [p1, h1], ...extra });
      const rows = ohboxRows(reader);
      const row = [...rows.resurfaced, ...rows.new, ...rows.earlier].find((r) => r.key === "T")!;
      const opened = rowOpenTarget(reader, row.openTarget);
      const shown = new Set([opened.id, ...threadOf(reader, opened.id).map((m) => m.id)]);
      expect(shown, "the control: the conversation opened shows the held member").toEqual(new Set(["p1"]));
      expect(threadSizeIndex(reader).get("T")?.count).toBe(shown.size);
      expect(conversationSize(reader, p1), "a row of one wears a count").toBe(0);
    }
  });

  it("two placed members and a held one read as two", () => {
    expect(threadSizeIndex(readerOf({ message: [p1, p2, h1] })).get("T")?.count).toBe(2);
    const fromThread = threadSizeIndex(readerOf({ message: [p1, p2, h1], ...withRow(["p1", "p2", "h1"]) }));
    expect(fromThread.get("T")).toEqual({ count: 2, whole: 3, fromThread: true });
  });

  it("the server's ids outside the window still count, less the held ones in hand", () => {
    const reader = readerOf({ message: [p1, h1], ...withRow(["x1", "x2", "p1", "h1"]) });
    expect(threadSizeIndex(reader).get("T")).toEqual({ count: 3, whole: 4, fromThread: true });
  });

  /** A pin brings the held member into the conversation, so it is counted. */
  it("a pinned held member still counts", () => {
    const claim: MessageStateDTO = {
      messageId: "h1", state: "resurfaced" as MessageStateDTO["state"],
      bubbleUpAt: null, setAt: "2026-09-21T08:00:00.000Z", updatedAt: "2026-09-21T08:00:00.000Z",
    };
    const reader = readerOf({ message: [p1, { ...h1, triage: claim }], message_state: [claim], ...withRow(["p1", "h1"]) });
    expect(threadSizeIndex(reader).get("T")?.count).toBe(2);
  });

  /** The gate's row opens the whole thread (`threadOf` from a held message), so it says the whole length. */
  it("a held member's own row says the whole conversation", () => {
    const reader = readerOf({ message: [p1, h1], ...withRow(["p1", "h1"]) });
    expect(conversationSize(reader, h1)).toBe(threadOf(reader, "h1").length);
    expect(conversationSize(reader, h1)).toBe(2);
    expect(conversationSize(reader, p1)).toBe(0);
  });

  /** MUTATION WATCHED: the `version()` guard dropped in `winningStates` and this throws TypeError. */
  it("answers a reader with no version(), uncached", () => {
    const bare = readerOf({ message: [p1, h1], ...withRow(["p1", "h1"]) }) as { version?: unknown };
    delete bare.version;
    const reader = bare as unknown as EntityReader;
    expect(threadSizeIndex(reader).get("T")?.count).toBe(1);
    expect(conversationSize(reader, h1)).toBe(2);
    expect(threadSizeIndex(reader), "a reader with no version is never cached").not.toBe(threadSizeIndex(reader));
  });

  /** MUTATION WATCHED: filter the thread row's ids again and the common path allocates per thread. */
  it("walks no thread row's ids when nothing is held", () => {
    const ids = Object.assign(["p1", "p2", "x1"], {
      filter: () => { throw new Error("the ids were filtered"); },
      [Symbol.iterator]: () => { throw new Error("the ids were walked"); },
    });
    const reader = readerOf({ message: [p1, p2], thread: [{ id: "T", messageIds: ids }] });
    expect(threadSizeIndex(reader).get("T")).toEqual({ count: 3, whole: 3, fromThread: true });
  });

  /** The gate's own row opens the whole held conversation (`threadOf`), so it is counted whole. */
  it("a conversation that is all held is counted whole", () => {
    const h2 = mkMsg({ id: "h2", threadId: "T", folder: HELD, from: stranger, date: "2026-09-20T10:00:00.000Z" });
    expect(threadSizeIndex(readerOf({ message: [h1, h2] })).get("T")?.count).toBe(2);
    expect(threadSizeIndex(readerOf({ message: [h1, h2], ...withRow(["h1", "h2"]) })).get("T")?.count).toBe(2);
  });
});
