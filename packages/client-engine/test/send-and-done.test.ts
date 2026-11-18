import type { EngineMessage, EngineMutation, MessageStateDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  intentOf,
  sendAndDone,
  sendAndDonePlanFor,
  type EntityReader,
} from "@ohmail/client-engine";

/** The fixture's ids, built from their numbers. */
const tid = (n: number): string => `T${n}`;

/**
 * SEND + DONE — the rule and the order.
 *
 * Measured here: which sources offer the second action at all (a fresh compose, an Ohbox row, a
 * message that is already finished, a row in a bottom pile, a Resurfaced row), what the release
 * dispatches, and that a refused send dispatches NOTHING.
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

const stateOf = (messageId: string, state: string, setAt = "2026-09-02T08:00:00.000Z"): MessageStateDTO => ({
  messageId,
  state: state as MessageStateDTO["state"],
  bubbleUpAt: state === "bubbled_up" ? "2026-09-30T09:00:00.000Z" : null,
  setAt,
  updatedAt: setAt,
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

function worldOf(messages: EngineMessage[], claims: MessageStateDTO[] = []): EntityReader {
  const withTriage = messages.map((m) => {
    const c = claims.find((x) => x.messageId === m.id);
    return c ? { ...m, triage: c } : m;
  });
  return readerOf({ message: withTriage, message_state: claims, thread: [] });
}

describe("the second send action is offered where it would finish something", () => {
  /**
   * THE BOUNDARY, and NO mutation reddens it: with the `sourceId === null` guard removed the
   * scans below answer `null` anyway, because no message has a null id. Said rather than
   * claimed — the guard is a belt, and this arm is here so a widening of the offer to a
   * source-less compose reddens.
   */
  it("a fresh compose has no source and no plan", () => {
    const reader = worldOf([mkMsg({ id: "m1", unread: true })]);
    expect(sendAndDonePlanFor(reader, null)).toBeNull();
  });

  /**
   * CONTROL. MUTATION WATCHED: return `view.newForYou`'s whole array from `threadIn` instead of
   * the conversation's members and the plan releases every unread row in the section.
   */
  it("an unread Ohbox row plans its own conversation's release", () => {
    const reader = worldOf([
      mkMsg({ id: "a1", threadId: tid(1), unread: true }),
      mkMsg({ id: "a2", threadId: tid(1), unread: true }),
      mkMsg({ id: "b1", threadId: tid(2), unread: true }),
    ]);
    const plan = sendAndDonePlanFor(reader, "a1");
    expect(plan).not.toBeNull();
    expect(plan!.section).toBe("new");
    expect([...plan!.messageIds].sort()).toEqual(["a1", "a2"]);
    expect(plan!.mutations).toEqual([
      { kind: "mark_seen", messageIds: plan!.messageIds, unread: false },
    ]);
    expect(plan!.undo).toEqual([
      { kind: "mark_seen", messageIds: plan!.messageIds, unread: true },
    ]);
  });

  /**
   * THE CONVERSATION'S ONE SECTION (2026-09-28). A READ source in a conversation with
   * unread mail stands in New with it, so the press finishes that row; the account's own mail —
   * a Sent row and the confirm-time copy, whose id no server row answers to — is never in the
   * release. MUTATION WATCHED: drop `!isOwnSent(r)` in `threadIn` and both Sent ids join it.
   */
  it("a read source in a waiting conversation plans New, and never names own sent mail", () => {
    const reader = worldOf([
      mkMsg({ id: "c-new", threadId: tid(7), unread: true, date: "2026-08-03T09:00:00.000Z" }),
      mkMsg({ id: "c-copy", threadId: tid(7), folder: SENT, local: true, date: "2026-08-02T10:00:00.000Z" }),
      mkMsg({ id: "c-sent", threadId: tid(7), folder: SENT, date: "2026-08-01T10:00:00.000Z" }),
      mkMsg({ id: "c-read", threadId: tid(7), unread: false, date: "2026-08-01T09:00:00.000Z" }),
      mkMsg({ id: "other", threadId: tid(8), unread: true }),
    ]);
    const plan = sendAndDonePlanFor(reader, "c-read");
    expect(plan).not.toBeNull();
    expect(plan!.section).toBe("new");
    expect(plan!.messageIds).toContain("c-new");
    expect(plan!.messageIds).not.toContain("c-copy");
    expect(plan!.messageIds).not.toContain("c-sent");
    expect(plan!.messageIds).not.toContain("other");
    // What the press changes is the unread inbound member alone: Undo puts back exactly that.
    expect(plan!.undo).toEqual([{ kind: "mark_seen", messageIds: ["c-new"], unread: true }]);
  });

  /** CONTROL: answering the account's own reply in that conversation finishes the same row. */
  it("an own-sent source plans the same row, and still names none of the account's own mail", () => {
    const reader = worldOf([
      mkMsg({ id: "c-new", threadId: tid(7), unread: true, date: "2026-08-03T09:00:00.000Z" }),
      mkMsg({ id: "c-sent", threadId: tid(7), folder: SENT, date: "2026-08-01T10:00:00.000Z" }),
    ]);
    const plan = sendAndDonePlanFor(reader, "c-sent");
    expect(plan?.section).toBe("new");
    expect(plan?.messageIds).toEqual(["c-new"]);
  });

  /**
   * CONTROL. MUTATION WATCHED: delete the `if (undo.length === 0) return null` line in
   * `planOver` and a finished message offers a second button that changes nothing.
   */
  it("a message that is already done offers the plain Send", () => {
    const reader = worldOf([mkMsg({ id: "done1", unread: false })]);
    expect(sendAndDonePlanFor(reader, "done1")).toBeNull();
  });

  /**
   * A source the Ohbox does not hold at all. The hold-out is `ohboxView`'s own
   * (`parkedMessageIds`) and is not mutated here; this arm reddens if the offer is ever widened
   * to the raw mirror, which is the only way a parked row could reach it.
   */
  it("a parked message offers the plain Send", () => {
    const reader = worldOf(
      [mkMsg({ id: "p1", unread: true })],
      [stateOf("p1", "set_aside")],
    );
    expect(sendAndDonePlanFor(reader, "p1")).toBeNull();
  });

  /**
   * CONTROL. MUTATION WATCHED: scan `view.resurfaced` by id instead of the engine's row members
   * and a forward of the row's NEWEST member (which carries no pin of its own) reads as no plan.
   */
  it("a Resurfaced row plans the release its own Done verb performs", () => {
    const reader = worldOf(
      [
        mkMsg({ id: "r1", threadId: tid(9), unread: false }),
        mkMsg({ id: "r2", threadId: tid(9), unread: true, date: "2026-08-03T09:00:00.000Z" }),
      ],
      [stateOf("r1", "resurfaced")],
    );
    const plan = sendAndDonePlanFor(reader, "r2");
    expect(plan).not.toBeNull();
    expect(plan!.section).toBe("resurfaced");
    expect(plan!.messageIds).toEqual(["r1"]);
    /* The pin is spent by the deliberate read; Undo re-pins it, so the row goes back to
       Resurfaced rather than to Earlier. */
    expect(plan!.undo).toContainEqual({ kind: "triage_set", messageId: "r1", state: "resurfaced" });
  });

  /**
   * CONTROL. MUTATION WATCHED: put the `mark_seen` before the `triage_set` in `planOver` and the
   * row is read out of a pile it is still in.
   */
  it("a pulled-forward booking is cleared before the read", () => {
    /* A `bubbled_up` message sits in the Resurface PILE, not in the Ohbox — it stands here only
       once somebody has written into its conversation since the pin (the pull-forward row). */
    const reader = worldOf(
      [
        mkMsg({ id: "s1", threadId: tid(5), unread: true }),
        mkMsg({ id: "s2", threadId: tid(5), unread: true, date: "2026-09-03T09:00:00.000Z" }),
      ],
      [stateOf("s1", "bubbled_up")],
    );
    const plan = sendAndDonePlanFor(reader, "s1");
    expect(plan).not.toBeNull();
    expect(plan!.mutations.map((m) => m.kind)).toEqual(["triage_set", "mark_seen"]);
    expect(plan!.mutations[0]).toEqual({ kind: "triage_set", messageId: "s1", state: "none" });
  });
});

describe("the intent dispatches the release only after an accepted send", () => {
  const world = (): EntityReader => worldOf([mkMsg({ id: "m1", unread: true })]);
  const intent = () => intentOf(sendAndDonePlanFor(world(), "m1")!, "m1");

  /**
   * CONTROL. MUTATION WATCHED: drop the `if (!accepted) return …` line in `sendAndDone` and the
   * refused send files the source anyway.
   */
  it("a refused send dispatches nothing", async () => {
    const seen: EngineMutation[] = [];
    const out = await sendAndDone({
      intent: intent(), reader: world,
      send: () => Promise.resolve(false),
      dispatch: async (m) => { seen.push(m); return true; },
    });
    expect(out).toEqual({ kind: "send_refused" });
    expect(seen).toEqual([]);
  });

  /** The positive control: an accepted send DOES file it. */
  it("an accepted send files the source", async () => {
    const seen: EngineMutation[] = [];
    const out = await sendAndDone({
      intent: intent(), reader: world,
      send: () => Promise.resolve(true),
      dispatch: async (m) => { seen.push(m); return true; },
    });
    expect(out.kind).toBe("sent_and_done");
    expect(seen).toEqual([{ kind: "mark_seen", messageIds: ["m1"], unread: false }]);
  });

  /** No plan is an ordinary Send — and nothing is dispatched for it either. */
  it("an accepted send with no plan is an ordinary send", async () => {
    const seen: EngineMutation[] = [];
    const out = await sendAndDone({
      intent: null, reader: world,
      send: () => Promise.resolve(true),
      dispatch: async (m) => { seen.push(m); return true; },
    });
    expect(out).toEqual({ kind: "sent" });
    expect(seen).toEqual([]);
  });

  /**
   * CONTROL. MUTATION WATCHED: `continue` instead of `return false` in `applySendAndDone` and a
   * refused booking clear is followed by the read that files the row out of its own pile.
   */
  it("a refused booking clear stops the release", async () => {
    const reader = worldOf(
      [
        mkMsg({ id: "s1", threadId: tid(5), unread: true }),
        mkMsg({ id: "s2", threadId: tid(5), unread: true, date: "2026-09-03T09:00:00.000Z" }),
      ],
      [stateOf("s1", "bubbled_up")],
    );
    const seen: EngineMutation[] = [];
    const out = await sendAndDone({
      intent: intentOf(sendAndDonePlanFor(reader, "s1")!, "s1"), reader: () => reader,
      send: () => Promise.resolve(true),
      dispatch: async (m) => { seen.push(m); return false; },
    });
    expect(out).toEqual({ kind: "send_done_refused" });
    expect(seen.map((m) => m.kind)).toEqual(["triage_set"]);
  });
});
