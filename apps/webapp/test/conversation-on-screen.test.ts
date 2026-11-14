import { describe, expect, it } from "vitest";
import type { EngineMessage, EntityReader } from "@ohmail/client-engine";
import { conversationOnScreen } from "@ohmail/app-logic/reading/conversation-on-screen";

/**
 * A message the presentation does not hold — a History row, one inside its undo window — reads its
 * conversation off the raw mirror, the phone's own fallback (`live.ts` `toMail`'s caller). Mutation:
 * always read `presented` and the History row opens with no conversation at all.
 */

const msg = (id: string, at: string, folder = "INBOX"): EngineMessage => ({
  id, accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "s",
  from: { name: null, address: `${id}@x.invalid` }, to: [], cc: [], date: at, folder: folder as EngineMessage["folder"],
  snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: at,
});

function readerOf(messages: EngineMessage[]): EntityReader {
  return {
    get: <T,>(type: string, id: string) => (type === "message" ? messages.find((m) => m.id === id) : undefined) as T | undefined,
    list: <T,>(type: string) => (type === "message" ? [...messages] : []) as T[],
    entries: <T,>(type: string) => (type === "message" ? messages.map((m) => ({ id: m.id, entity: m, seq: 0 })) : []) as Array<{ id: string; entity: T; seq: number }>,
    version: () => 1, stampOf: () => 1, stampExcept: () => 1,
  };
}

describe("the conversation a panel shows", () => {
  const a = msg("a", "2026-08-01T08:00:00.000Z");
  const b = msg("b", "2026-08-01T09:00:00.000Z");
  const held = msg("h", "2026-08-01T08:30:00.000Z");

  it("is the presented mirror's where it holds the message", () => {
    // Raw holds h in INBOX; the presentation has placed it at the gate.
    const raw = readerOf([a, held, b]);
    const presented = readerOf([a, { ...held, folder: "ohmail/Screener", physicalFolder: "INBOX" } as EngineMessage, b]);
    expect(conversationOnScreen(presented, raw, "b").map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("is the raw mirror's for a message the presentation does not hold", () => {
    const raw = readerOf([a, b]);
    const presented = readerOf([b]);
    expect(conversationOnScreen(presented, raw, "a").map((m) => m.id)).toEqual(["a", "b"]);
  });
});
