import { describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/client-engine";
import { keepInPlace, streamHostOf } from "../app/shell/stream-in-place";

/**
 * WHICH LETTER A READING STREAM ANSWERS IN PLACE, AND HOW LONG IT STAYS THERE — the two rules
 * `stream-in-place.tsx` and the shell share (the shell asks the first before it raises a sheet).
 */
const msg = (id: string, over: Record<string, unknown> = {}): EngineMessage =>
  ({ id, folder: "INBOX", threadId: "t1", ...over }) as EngineMessage;

const letter = msg("news-1");
const mine = msg("sent-1", { folder: "Sent", local: true });
const older = msg("sent-0", { folder: "Sent" });
const other = msg("news-2");

describe("streamHostOf", () => {
  const pile = new Set(["news-1", "news-2", "news-3"]);
  const has = (id: string) => pile.has(id);
  const conv: Record<string, EngineMessage[]> = {
    "sent-1": [letter, mine],
    "sent-9": [msg("ohbox-1"), msg("sent-9", { folder: "Sent" })],
    "sent-2": [letter, other, msg("sent-2", { folder: "Sent" })],
  };
  const of = (id: string) => conv[id] ?? [];
  it.each([
    ["nothing open", null, undefined, null],
    ["the target is a pile letter", "news-3", undefined, "news-3"],
    ["a panel's Reply on the reader's own reply", "sent-1", undefined, "news-1"],
    ["a target whose conversation holds no pile letter", "sent-9", undefined, null],
    ["two pile letters in it: the first", "sent-2", undefined, "news-1"],
    ["two pile letters in it: the one already in place", "sent-2", (id: string) => id === "news-2", "news-2"],
  ] as const)("%s", (_, replyTo, prefer, host) => {
    expect(streamHostOf(replyTo, has, of, prefer)).toBe(host);
  });

  it("asks no conversation for a target the pile holds", () => {
    let asked = 0;
    expect(streamHostOf("news-1", has, (id) => { asked += 1; return of(id); })).toBe("news-1");
    expect(asked).toBe(0);
  });
});

describe("keepInPlace", () => {
  it.each([
    ["nothing sent, every lane idle", [letter], ["news-1"], ["idle", "idle"], false],
    ["the send failed", [letter], ["news-1"], ["failed", "idle"], false],
    ["handed off: still sending", [letter], ["news-1"], ["sending", "idle"], true],
    ["queued", [letter], ["news-1"], ["queued"], true],
    ["a forward's lane on its way", [letter], ["news-1"], ["idle", "sending"], true],
    ["the reply joined the conversation", [letter, mine], ["news-1"], ["idle"], true],
    ["an own reply that was already there", [older, letter], ["sent-0", "news-1"], ["idle"], false],
    ["somebody else's message joined", [letter, other], ["news-1"], ["idle"], false],
  ] as const)("%s", (_, conversation, members, phases, kept) => {
    expect(keepInPlace(conversation, members, phases)).toBe(kept);
  });
});
