/** @vitest-environment jsdom */
/**
 * THE ROW'S DESCRIPTION, BYTE FOR BYTE, ACROSS THE MOVE.
 *
 * The assembly left `MessageRow` for `row-spoken.ts` so the phone could read the same order. The
 * three strings below were RECORDED from the inline version at that change
 * by rendering this row — the web's own voice, not the new function's — and are what the row must
 * still say. `apps/mobile/test/mail-row-badges-spoken.test.ts` holds the phone against the same
 * order from the other side.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MessageRow, type MessageRowSpoken } from "@ohmail/ui";
import {
  ROW_SPOKEN_ORDER,
  messageRowDescription,
  messageRowFacts,
} from "../src/composites/row-spoken.js";

afterEach(cleanup);

const SPOKEN: MessageRowSpoken = { unread: "Unread", read: "Read", attachment: "Has an attachment" };

/** Every badge the row can wear at once — the facts, once, for the row and for the function. */
const ALL = {
  time: "09:12",
  timeSpoken: "Saturday 6 September 2026 at 09:12",
  unread: true,
  spoken: SPOKEN,
  hasAttachment: true,
  protectedLabel: "protected",
  heldCount: 3,
  heldLabel: "3 held",
  newSinceLabel: "2 new",
  newSinceTitle: "2 messages since this came back",
  stateNote: "Back Tue 09:00",
  aiReason: "the sending address does not match the brand",
  place: "Archive",
  mailbox: "work@example.test",
  mailboxTitle: "Delivered to Work",
  destination: "Reads",
  detection: "bulk sender",
  amount: "EUR 12.40",
  tags: [{ name: "Invoices" }, { name: "Tax" }],
};

const SAID_ALL =
  "Saturday 6 September 2026 at 09:12 · Unread · Has an attachment · protected · 3 held"
  + " · 2 messages since this came back · Back Tue 09:00"
  + " · the sending address does not match the brand · Archive · Delivered to Work · Reads"
  + " · bulk sender · EUR 12.40 · Invoices · Tax";
const SAID_NONE = "09:12 · Read";
const SAID_NEW_SINCE = "09:12 · Unread · 2 messages since this came back";

/** The host's sentence for the count — this package has no catalogue, so the row is handed one. */
const THREAD_SAID = "4 messages in this conversation";
const SAID_ALL_THREAD =
  "Saturday 6 September 2026 at 09:12 · Unread · 4 messages in this conversation"
  + " · Has an attachment · protected · 3 held"
  + " · 2 messages since this came back · Back Tue 09:00"
  + " · the sending address does not match the brand · Archive · Delivered to Work · Reads"
  + " · bulk sender · EUR 12.40 · Invoices · Tax";

const described = (node: HTMLElement | null): string | null =>
  node?.querySelector("button")?.getAttribute("aria-description") ?? null;

describe("the row says what it said before the assembly moved", () => {
  it("speaks every badge it wears, in the recorded order", () => {
    const { container } = render(
      <MessageRow
        id="m1"
        from="Ada Lovelace"
        subject="The engine"
        {...ALL}
        threadCount={4}
        aiSuggestion={{ destLabel: "Reads", confidence: 0.88, reason: ALL.aiReason }}
        tags={[{ name: "Invoices", hue: "ochre" }, { name: "Tax", hue: "denim" }]}
      />,
    );
    expect(described(container)).toBe(SAID_ALL);
  });

  /**
   * THE COUNT, NOW SAID. `⤷ 4` was drawn and silent — the gap row
   * WEB-ROW-THREAD-COUNT-IS-DRAWN-AND-NEVER-SPOKEN — and the fixture above still proves the
   * recorded voice, because it hands the row no word for it. Here the host hands one.
   */
  it("speaks the conversation's length where the host gave it words", () => {
    const { container } = render(
      <MessageRow
        id="m1t"
        from="Ada Lovelace"
        subject="The engine"
        {...ALL}
        threadCount={4}
        threadLabel={THREAD_SAID}
        aiSuggestion={{ destLabel: "Reads", confidence: 0.88, reason: ALL.aiReason }}
        tags={[{ name: "Invoices", hue: "ochre" }, { name: "Tax", hue: "denim" }]}
      />,
    );
    expect(described(container)).toBe(SAID_ALL_THREAD);
    /* The recorded voice, byte for byte, with only the new fact removed. */
    expect(described(container)?.replace(` · ${THREAD_SAID}`, "")).toBe(SAID_ALL);
  });

  it("speaks its stamp and its read state on a row wearing no badge at all", () => {
    const { container } = render(
      <MessageRow id="m2" from="Ada Lovelace" subject="The engine" time="09:12" spoken={SPOKEN} seen />,
    );
    expect(described(container)).toBe(SAID_NONE);
  });

  it("speaks the new-since SENTENCE, never the chip's two words", () => {
    const { container } = render(
      <MessageRow
        id="m3"
        from="Ada Lovelace"
        subject="The engine"
        time="09:12"
        unread
        spoken={SPOKEN}
        newSinceLabel="2 new"
        newSinceTitle="2 messages since this came back"
      />,
    );
    expect(described(container)).toBe(SAID_NEW_SINCE);
  });
});

describe("the function the row now calls", () => {
  it("answers exactly what the row renders, for the same three fixtures", () => {
    expect(messageRowDescription(ALL)).toBe(SAID_ALL);
    expect(messageRowDescription({ time: "09:12", spoken: SPOKEN })).toBe(SAID_NONE);
    expect(messageRowDescription({
      time: "09:12", unread: true, spoken: SPOKEN,
      newSinceLabel: "2 new", newSinceTitle: "2 messages since this came back",
    })).toBe(SAID_NEW_SINCE);
  });

  it("says nothing at all about a row that has no fact beyond its name", () => {
    expect(messageRowDescription({})).toBeUndefined();
  });

  it("emits its facts in the shared order, whatever order they were pushed in", () => {
    const kinds = messageRowFacts(ALL).map((f) => f.kind);
    const rank = (k: string) => ROW_SPOKEN_ORDER.indexOf(k as never);
    /* The census that matters is not that they are sorted — `messageRowFacts` pushes them in
       order — but that every kind it emits HAS a place in the shared list, which is what the
       phone's twin is held against. */
    expect(kinds.filter((k) => rank(k) < 0)).toEqual([]);
    expect([...kinds].sort((a, b) => rank(a) - rank(b))).toEqual(kinds);
  });

  /**
   * THE ORDER ITSELF, PINNED. A kind added or moved here is a change to what BOTH surfaces say,
   * and only this package's tests are selected when this file moves — the phone's twin
   * (`apps/mobile/src/ui/row-spoken.ts`, held against this list by
   * `apps/mobile/test/mail-row-badges-spoken.test.ts`) has to move with it or be declared
   * web-only there.
   */
  it("keeps the shared order exactly as both surfaces read it", () => {
    expect([...ROW_SPOKEN_ORDER]).toEqual([
      "arrived", "readState", "senderCheck", "thread", "marks", "attachment", "protected", "held", "newSince",
      "stateNote", "aiReason", "tracker", "place", "mailbox", "destination", "detection",
      "amount", "tag",
    ]);
  });

  /**
   * THE PIN THAT HELD THE SILENCE, RE-DERIVED. It used to read "still does not speak the thread
   * count"; the count is spoken now, and what is pinned in its place is the condition — the host's
   * sentence, a conversation of more than one, and no English invented in a package that holds no
   * catalogue.
   */
  it("speaks the thread count on the host's word, and never invents one", () => {
    const kinds = (p: Parameters<typeof messageRowFacts>[0]) => messageRowFacts(p).map((f) => f.kind);
    expect(kinds({ ...ALL, threadCount: 4, threadLabel: THREAD_SAID })).toContain("thread");
    expect(kinds({ ...ALL, threadCount: 4 })).not.toContain("thread");
    /* A conversation of one is not a conversation — the row draws no badge for it either. */
    expect(kinds({ ...ALL, threadCount: 1, threadLabel: "1 message in this conversation" }))
      .not.toContain("thread");
    expect(ROW_SPOKEN_ORDER).toContain("thread");
  });
});
