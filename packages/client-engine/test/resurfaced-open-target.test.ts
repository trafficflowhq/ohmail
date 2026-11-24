import type { EngineMessage, MessageStateDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  ohboxView,
  resurfacedFocus,
  resurfacedThreads,
  type EntityReader,
} from "@ohmail/client-engine";

/**
 * A RESURFACED ROW OPENS ON THE NEWEST MEMBER SOMEBODY ELSE WROTE.
 *
 * The reported shape (desktop and web, 2026-09-21): a parked message came back, the away
 * responder had answered it, and the conversation's newest member by arrival was that answer —
 * the account's own outbound mail, in Sent. The row was keyed on it: its face read
 * "Me → …: I'm out of the office", and a click handed the Sent copy's id to a reader that
 * resolves the Ohbox column from the three groups, none of which lists a resurfaced
 * conversation's unpinned members. "Nothing open."
 */

const OHBOX = "INBOX";
const SENT = "Sent" as EngineMessage["folder"];

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-09-11T08:00:00.000Z", arrivedAt: "2026-09-11T08:00:00.000Z",
    folder: OHBOX, snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-11T08:00:00.000Z",
    ...p,
  } as EngineMessage;
}

const claim = (messageId: string, setAt: string): MessageStateDTO => ({
  messageId, state: "resurfaced", bubbleUpAt: null, setAt, updatedAt: setAt,
});

function readerOf(byType: Record<string, unknown[]>): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) =>
      (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => 1,
  } as unknown as EntityReader;
}

/** The reported conversation: the inbound original, pinned; the account's own answer, newer. */
function ownerShape(ownAnswer: Partial<EngineMessage>): {
  reader: EntityReader; original: EngineMessage; answer: EngineMessage;
} {
  const pinnedAt = "2026-09-21T07:00:00.000Z";
  const original = mkMsg({
    id: "orig", threadId: "T", date: "2026-09-11T08:00:00.000Z", arrivedAt: "2026-09-11T08:00:00.000Z",
    triage: claim("orig", pinnedAt),
  });
  const answer = mkMsg({
    id: "own", threadId: "T", folder: SENT,
    from: { name: "Me", address: "me@example.invalid" },
    to: [{ name: "N", address: "n@example.invalid" }],
    date: "2026-09-11T08:05:00.000Z", arrivedAt: "2026-09-11T08:05:00.000Z",
    ...ownAnswer,
  });
  const reader = readerOf({
    message: [original, answer],
    message_state: [claim("orig", pinnedAt)],
    thread: [{ id: "T", messageIds: ["orig", "own"], lastMessageAt: answer.date }],
  });
  return { reader, original, answer };
}

describe("a resurfaced conversation whose newest member is the account's own", () => {
  /**
   * MUTATION WATCHED: make `resurfacedThreads` take the newest member by arrival again (drop
   * the `isFromSomeone` preference in `resurfacedFocus`) and the target is `own` — the Sent
   * copy the user's click handed to a reader that could not show it.
   */
  it("opens on the inbound original when the newest member is the away responder's answer", () => {
    const { reader } = ownerShape({ autoReplyByUs: true });
    const rows = resurfacedThreads(reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.members.map((m) => m.id).sort()).toEqual(["orig", "own"]);
    expect(rows[0]!.openTarget.id).toBe("orig");
    // The row still stands for the whole conversation: both members, the server's count.
    expect(rows[0]!.count).toBe(2);
  });

  it("opens on the inbound original when the newest member is the account holder's own deliberate reply", () => {
    const { reader } = ownerShape({});
    expect(resurfacedThreads(reader)[0]!.openTarget.id).toBe("orig");
  });

  /**
   * THE REASON THE SHELL CANNOT RESOLVE THE COLUMN FROM THE THREE GROUPS ALONE: the Sent member
   * is in none of them. It is held out of "Earlier" because its conversation stands in a
   * resurfaced row, and the pin group lists pinned messages, not members. `ohbox-surface.ts`
   * unions the rows' members in for exactly this case; this pins the fact it answers.
   */
  it("the own-sent member is in none of the three groups — the row is its only home", () => {
    const { reader } = ownerShape({ autoReplyByUs: true });
    const view = ohboxView(reader);
    const groups = [...view.resurfaced, ...view.newForYou, ...view.previouslySeen].map((m) => m.id);
    expect(groups).toContain("orig");
    expect(groups).not.toContain("own");
  });
});

describe("resurfacedFocus — the one rule for a row's face and open target", () => {
  const at = (id: string, date: string, over: Partial<EngineMessage> = {}) =>
    mkMsg({ id, threadId: "T", date, arrivedAt: date, ...over });

  it("prefers the newest member somebody else wrote over a newer own reply", () => {
    const a = at("a", "2026-09-01T09:00:00.000Z");
    const b = at("b", "2026-09-02T09:00:00.000Z");
    const own = at("own", "2026-09-03T09:00:00.000Z", { folder: SENT });
    expect(resurfacedFocus([a, b, own], [a]).id).toBe("b");
  });

  it("a calendar client's acknowledgement is not a face either", () => {
    const a = at("a", "2026-09-01T09:00:00.000Z");
    const ack = at("ack", "2026-09-02T09:00:00.000Z", { itipReplyHeader: true } as Partial<EngineMessage>);
    expect(resurfacedFocus([a, ack], [a]).id).toBe("a");
  });

  /** POSITIVE CONTROL: with nobody else in it, the parked message itself is the focus. */
  it("a conversation of the account's own mail alone opens on what was parked", () => {
    const older = at("older", "2026-09-01T09:00:00.000Z", { folder: SENT });
    const parked = at("parked", "2026-09-02T09:00:00.000Z", { folder: SENT });
    const newer = at("newer", "2026-09-03T09:00:00.000Z", { folder: SENT });
    expect(resurfacedFocus([older, parked, newer], [parked]).id).toBe("parked");
    // And with no pin named, the newest of all — a row with no focus is not a row.
    expect(resurfacedFocus([older, parked, newer]).id).toBe("newer");
  });

  it("ties by arrival break on the larger id, as the engine's scan always has", () => {
    const x = at("x", "2026-09-01T09:00:00.000Z");
    const y = at("y", "2026-09-01T09:00:00.000Z");
    expect(resurfacedFocus([x, y]).id).toBe("y");
  });
});
