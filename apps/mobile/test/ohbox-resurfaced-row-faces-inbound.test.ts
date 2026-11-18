import type { EngineMessage, MessageStateDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  type EntityReader,
  type SyncChange,
} from "@ohmail/client-engine";
import { liveOhbox, presentedOf, type WorldView } from "../src/state/live";

/**
 * THE PHONE'S RESURFACED ROW FACES THE MESSAGE THAT CAME IN.
 *
 * The phone draws one row per resurfaced conversation from the engine's own `resurfacedThreads`
 * and maps `openTarget` — so the web and desktop defect of 2026-09-21 (a row keyed on the away
 * responder's answer, which is the account's own outbound mail) was the phone's too, and the
 * engine's `resurfacedFocus` is the whole fix here. This is the surface arm: the row the phone
 * puts on screen is the inbound original, not the Sent copy.
 */

const SENT = "Sent" as EngineMessage["folder"];
const view: WorldView = { now: new Date("2026-09-21T09:30:00.000Z"), zone: "UTC" };

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null,
    subject: "Performance", from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-09-11T08:00:00.000Z", arrivedAt: "2026-09-11T08:00:00.000Z",
    folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-11T08:00:00.000Z",
    ...p,
  } as EngineMessage;
}

const claim = (messageId: string, setAt: string): MessageStateDTO => ({
  messageId, state: "resurfaced", bubbleUpAt: null, setAt, updatedAt: setAt,
});

/** A reported conversation: the parked inbound original, and the away responder's answer after it. */
async function ownerShape(): Promise<EntityReader> {
  const pinnedAt = "2026-09-21T07:00:00.000Z";
  const original = mkMsg({ id: "orig", triage: claim("orig", pinnedAt) });
  const answer = mkMsg({
    id: "own", folder: SENT, autoReplyByUs: true,
    from: { name: "Me", address: "me@example.invalid" },
    to: [{ name: "N", address: "n@example.invalid" }],
    date: "2026-09-11T08:05:00.000Z", arrivedAt: "2026-09-11T08:05:00.000Z",
  } as Partial<EngineMessage> & { id: string });
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...[original, answer].map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    {
      type: "message_state", op: "create", id: "orig", seq: ++seq, updatedAt: pinnedAt,
      entity: claim("orig", pinnedAt),
    },
    {
      type: "thread", op: "create", id: "T", seq: ++seq, updatedAt: answer.date,
      entity: { id: "T", messageIds: ["orig", "own"], lastMessageAt: answer.date },
    },
  ] as SyncChange[]);
  return store;
}

describe("the phone's Resurfaced list", () => {
  /**
   * MUTATION WATCHED: map `r.members[r.members.length - 1]` instead of `r.openTarget` in
   * `liveOhbox` and this reads "own" — the row a person tapped and could not open.
   */
  it("draws the row on the inbound original when the account's own answer is newer", async () => {
    const box = liveOhbox(presentedOf(await ownerShape(), view.now), view);
    expect(box.resurfaced.map((m) => m.id)).toEqual(["orig"]);
  });

  /**
   * The row still stands for the whole conversation: nothing is dropped by facing inbound. `total`
   * counts MESSAGES, the unit the meta line names and the web counts (2026-09-28).
   */
  it("one row stands for both members, and the count is two messages", async () => {
    const box = liveOhbox(presentedOf(await ownerShape(), view.now), view);
    expect(box.total).toBe(2);
    expect(box.resurfaced).toHaveLength(1);
    expect([...(box.resurfaced[0]!.memberIds ?? [])].sort()).toEqual(["orig", "own"]);
  });
});
