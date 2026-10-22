/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";
import {
  click, key, mountThread, msg, openTheRow, patches, pinOf, readSlot, serverLacks, settle, theRow, toastText,
} from "./fixtures/thread-read-shell.js";

/**
 * THE READER'S MARK AS READ IS THE CONVERSATION'S, through the shipped shell and the real engine.
 * A thread a1 (older, unread) + x2 (newer, unread) opened from its row: the open lands on x2 and
 * the read rule reads it alone (a1's sender line is above the view; the reader is laid out by
 * `fixtures/thread-layout.ts`), the slot then says "Mark read", and the press writes exactly the rest of the conversation in
 * ONE deliberate mark_seen with one Undo; a read of the conversation the reader holds open is an
 * open read, so its PATCH carries `openRead`. Mutations watched red: the pane's face back to
 * `!message.unread` (the label), ⇧I back to `markRead(selected)` (the set), `conversationReadSet`
 * without its resurfaced exclusion (the pinned case), the sheet mounted without `readSet`, the
 * bulk press unchunked or its inverse unchunked (the 413s), the inverse read after the dispatch.
 */

const glances = () => patches.filter((p) => p.via === "glance");
const deliberate = () => patches.filter((p) => p.via === undefined);
/** The slot's visible face; its accessible name carries the count on the conversation face. */
const label = (scope: ParentNode): string | null => readSlot(scope)?.querySelector(".abar-read-lab")?.textContent ?? null;
const named = (scope: ParentNode): string | null => readSlot(scope)?.getAttribute("aria-label") ?? null;
const col = (): HTMLElement => document.querySelector<HTMLElement>(".read-col")!;
const unseenPanel = (id: string): boolean =>
  document.querySelector(`.read-col article.pm[data-conv-id="${id}"]`)?.hasAttribute("data-unseen") ?? false;

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
let layout: ThreadLayout;
/** A press on the row opens the conversation; the opened message's top on screen for the dwell is read. */
const openAndRead = async (host: HTMLElement): Promise<void> => {
  await openTheRow(host);
  await layout.passDwell();
  await settle();
};
beforeEach(() => {
  installShellEnv();
  layout = stubThreadLayout({ columnHidden: () => window.matchMedia("(max-width: 699.98px)").matches });
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  layout.restore();
  await teardownShellEnv();
});

describe("the reader's read slot covers the conversation on screen", () => {
  it("the open glances x2, the slot says Mark as read, the press writes a1 alone with one Undo", async () => {
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead(host);
    expect(glances().map((p) => p.ids), "the open glances the opened message only").toEqual([["x2"]]);
    expect(deliberate()).toEqual([]);
    // THE OWNER'S DEFECT, first: at the base this face said Mark unread over an unread sibling.
    expect(label(col()), "the slot's face").toBe("Mark read");
    expect(named(col()), "its accessible name says what it takes").toBe("Mark 1 unread message as read");
    expect(readSlot(col())?.getAttribute("title")).toBe("Mark 1 unread message as read");
    expect(unseenPanel("a1"), "a1 is an unread panel").toBe(true);
    expect(readSlot(col())?.querySelector("kbd"), "the slot shows its ⇧I cap").toBeTruthy();

    await click(readSlot(col()), "Mark read");
    expect(deliberate(), "ONE deliberate mark_seen over the rest of the conversation").toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
    expect(toastText()).toContain("1 message marked read.");
    expect(document.querySelector(".toast .toast-act")?.textContent).toContain("Undo");
    expect(label(col())).toBe("Mark unread");
    expect(unseenPanel("a1"), "a1's panel is read").toBe(false);
    expect(theRow(host)?.querySelector(".dot-unread"), "the row's dot is gone").toBeNull();
    expect(theRow(host), "the row keeps its place until it is left").toBeTruthy();
  }, 30_000);

  it("by the key: ⇧I writes the same one set", async () => {
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead(host);
    await key("I", { shiftKey: true });
    expect(deliberate()).toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
  }, 30_000);

  it("after the press, u marks x2 unread alone and the slot says Mark as read again", async () => {
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead(host);
    await click(readSlot(col()), "Mark read");
    await key("u");
    expect(deliberate().slice(1), "u is the one message").toEqual([{ ids: ["x2"], unread: true }]);
    expect(unseenPanel("a1"), "a1 stays read").toBe(false);
    expect(label(col())).toBe("Mark read");
  }, 30_000);

  it("Undo puts back exactly a1, nothing for x2", async () => {
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead(host);
    await click(readSlot(col()), "Mark read");
    await click(document.querySelector(".toast .toast-act"), "Undo");
    expect(deliberate().slice(1)).toEqual([{ ids: ["a1"], unread: true }]);
    expect(host.isConnected).toBe(true);
  }, 30_000);

  it("a five-unread thread opened at the newest is ONE request carrying the four siblings", async () => {
    const host = await mountThread([msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30), msg("p5", 40)]);
    await openAndRead(host);
    expect(glances().map((p) => p.ids)).toEqual([["p5"]]);
    await click(readSlot(col()), "Mark read");
    expect(deliberate()).toEqual([{ ids: ["p1", "p2", "p3", "p4"], unread: false, openRead: true }]);
  }, 30_000);

  it("a resurfaced sibling is outside the set: with only it left, the slot says Mark unread", async () => {
    const { pin, row } = pinOf("a1");
    const host = await mountThread([msg("a1", 0, { triage: pin }), row, msg("x2", 60)]);
    await openAndRead(host);
    expect(document.querySelector('.read-col [aria-current="true"]')?.getAttribute("data-conv-id")).toBe("x2");
    expect(label(col()), "the pin is the row's to release, not this press's").toBe("Mark unread");
  }, 30_000);

  it("⇧I on a resurfaced open message stays its own deliberate read, not the unread sibling's", async () => {
    const { pin, row } = pinOf("x2");
    const host = await mountThread([msg("a1", 0), msg("x2", 60, { unread: false, triage: pin }), row]);
    await openAndRead(host);
    expect(document.querySelector('.read-col [aria-current="true"]')?.getAttribute("data-conv-id"), "the pin's row opens at the pin").toBe("x2");
    await key("I", { shiftKey: true });
    expect(deliberate(), "the pin's way out, as before").toEqual([{ ids: ["x2"], unread: false }]);
  }, 30_000);

  it("one id the server does not hold refuses the press: rolled back, no success sentence", async () => {
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead(host);
    serverLacks("a1");
    await click(readSlot(col()), "Mark read");
    await settle();
    expect(deliberate()).toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
    expect(toastText(), "no success sentence").not.toContain("marked read");
    expect(toastText().trim().length, "a refusal sentence shows").toBeGreaterThan(0);
    expect(unseenPanel("a1"), "the overlay rolled back").toBe(true);
    expect(label(col())).toBe("Mark read");
  }, 30_000);

  it("partial: the second chunk refused — the sentence says how many, the Undo takes back exactly the first", async () => {
    const many = Array.from({ length: 201 }, (_, i) => msg(`s${String(i).padStart(3, "0")}`, i));
    const host = await mountThread([...many, msg("x", 400)]);
    await openAndRead(host);
    serverLacks("s200");
    await click(readSlot(col()), "Mark read");
    await settle();
    expect(deliberate().map((p) => [p.ids.length, p.unread])).toEqual([[200, false], [1, false]]);
    expect(toastText()).toContain("Marked 200 of 201 as read.");
    await click(document.querySelector(".toast .toast-act"), "Undo");
    const undo = deliberate().slice(2);
    expect(undo.map((p) => [p.ids.length, p.unread]), "the landed chunk's ids back, nothing for the refused one").toEqual([[200, true]]);
    expect(undo[0]!.ids).not.toContain("s200");
  }, 120_000);

  it("a render whose mirror has not moved walks the mirror for the read set no more", async () => {
    const { readSetWalks } = await import("../app/shell/conversation-on-screen.js");
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead(host);
    const before = readSetWalks();
    // `m` raises the bar's Move panel and Escape drops it: shell state, so the shell and the Ohbox
    // render again, over a mirror that has not moved.
    for (let i = 0; i < 3; i++) {
      await key("m");
      await key("Escape");
    }
    expect(readSetWalks() - before, "renders with an unmoved mirror reuse the set").toBe(0);
  }, 30_000);

  it("201 to read go out as 200 + 1 with one sentence, and the Undo splits the same way", async () => {
    const many = Array.from({ length: 201 }, (_, i) => msg(`s${String(i).padStart(3, "0")}`, i));
    const host = await mountThread([...many, msg("x", 400)]);
    await openAndRead(host);
    await click(readSlot(col()), "Mark read");
    expect(deliberate().map((p) => [p.ids.length, p.unread])).toEqual([[200, false], [1, false]]);
    expect(toastText()).toContain("201" + " messages marked read.");
    expect(toastText().match(/marked read/g)?.length, "one sentence").toBe(1);
    await click(document.querySelector(".toast .toast-act"), "Undo");
    expect(deliberate().slice(2).map((p) => [p.ids.length, p.unread])).toEqual([[200, true], [1, true]]);
    expect(patches.every((p) => p.ids.length <= 200), "nothing the route refuses").toBe(true);
  }, 120_000);
});

describe("the reader sheet over the Ohbox", () => {
  const narrow = (): void => {
    const q = new Set(["(max-width: 699.98px)", "(max-width: 721px)", "(max-width: 1023.98px)"]);
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({
        matches: q.has(query), media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  };

  it("the sheet's slot says Mark as read and writes the same single set", async () => {
    narrow();
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead(host);
    const sheet = document.querySelector<HTMLElement>(".reader");
    expect(sheet?.querySelector(".conv"), "the sheet shows the conversation").toBeTruthy();
    expect(label(sheet!)).toBe("Mark read");
    await click(readSlot(sheet!), "the sheet's Mark as read");
    expect(deliberate()).toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
    expect(label(sheet!)).toBe("Mark unread");
  }, 30_000);
});
