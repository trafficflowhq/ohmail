/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, goTo, installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";
import {
  click, key, mountThread, msg, patches, pinOf, readSlot, serverLacks, settle, theRow, toastText, undoPress,
} from "./fixtures/thread-read-shell.js";
import { letterShown, openLetter } from "./ohbox/_finders.js";

/**
 * THE READER'S MARK AS READ IS THE CONVERSATION'S, through the shipped shell and the real engine.
 * A thread a1 (older, unread) + x2 (newer, unread) with x2 chosen directly: the open lands on x2 and
 * the read rule reads it alone (a1's sender line is above the view; the reader is laid out by
 * `fixtures/thread-layout.ts`), the slot then says "Mark read", and the press writes exactly the rest of the conversation in
 * ONE deliberate mark_seen with one Undo; a read of the conversation the reader holds open is an
 * open read, so its PATCH carries `openRead`. Mutations watched red: the pane's face back to
 * `!message.unread` (the label), ⇧I back to `markRead(selected)` (the set), `conversationReadSet`
 * without its resurfaced exclusion (the pinned case), the sheet mounted without `readSet`, the
 * bulk press unchunked or its inverse unchunked (the 413s), the inverse read after the dispatch.
 */

/*
 * RE-POINTED (share reader-1, the switch's older tests): the shell these cases walk is the new one (the shared
 * fixtures mount the web's `MailShell`: the frame over the mail ground, the seated Ohbox and the reader). The read
 * slot is the open letter's action panel's, found by its name; a letter by `data-conv-id`, the opened one by
 * `aria-current`; the verb's answer and its Undo are the frame's report's. Expectations as they stood. The slot's
 * spelled-out name ("Mark 1 unread message as read") and its ⇧I cap are not drawn by the new panel: those lines of
 * the first case stand in a case of their own below it (GAP:switch-reader), so the press's own promise is held green.
 */
const glances = () => patches.filter((p) => p.via === "glance");
const deliberate = () => patches.filter((p) => p.via === undefined);
/** The slot's visible face: the verb it offers now. */
const label = (scope: ParentNode): string | null => readSlot(scope)?.textContent?.replace(/\s+/g, " ").trim().match(/Mark (un)?read/)?.[0] ?? null;
/** Its accessible name, and its title: on the conversation face they carry the count. */
const named = (scope: ParentNode): string | null => readSlot(scope)?.getAttribute("aria-label") ?? null;
/** The reading column: the slot's scope at a place of columns. */
const col = (): ParentNode => document;
const unseenPanel = (id: string): boolean => letterShown(document, id)?.hasAttribute("data-unseen") ?? false;
/** The letter of the open conversation the reader marks as the opened one. */
const current = (): string | undefined =>
  openLetter(document)?.querySelector<HTMLElement>('[data-conv-id][aria-current="true"]')?.dataset.convId;

beforeAll(async () => {
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);
let layout: ThreadLayout;
/** Choose one message and give its top time on screen to be read. */
const openAndRead = async (id: string): Promise<void> => {
  await goTo(`ohbox/m/${id}`);
  await settle();
  expect(current(), "the chosen message is open").toBe(id);
  await act(async () => {
    layout.scroller().dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  await settle();
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
    await openAndRead("x2");
    expect(glances().map((p) => p.ids), "the open glances the opened message only").toEqual([["x2"]]);
    expect(deliberate()).toEqual([]);
    // THE OWNER'S DEFECT, first: at the base this face said Mark unread over an unread sibling.
    expect(label(col()), "the slot's face").toBe("Mark read");
    // Its accessible name, its title and its ⇧I cap: the case below ("the slot names what it takes").
    expect(unseenPanel("a1"), "a1 is an unread panel").toBe(true);

    await click(readSlot(col()), "Mark read");
    expect(deliberate(), "ONE deliberate mark_seen over the rest of the conversation").toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
    expect(toastText()).toContain("1 · Read");
    expect(undoPress()?.textContent).toContain("Undo");
    expect(label(col())).toBe("Mark unread");
    expect(unseenPanel("a1"), "a1's panel is read").toBe(false);
    expect(theRow(host)?.hasAttribute("data-unseen"), "the row's dot is gone").toBe(false);
    expect(theRow(host), "the row keeps its place until it is left").toBeTruthy();
  }, 30_000);

  it("the slot names what it takes and shows its ⇧I cap", async () => {
    await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead("x2");
    expect(label(col()), "the slot's face").toBe("Mark read");
    expect(named(col()), "its accessible name says what it takes").toBe("Mark 1 unread message as read");
    expect(readSlot(col())?.getAttribute("title")).toBe("Mark 1 unread message as read · ⇧ i");
    expect(readSlot(col())?.querySelector("kbd"), "the slot shows its ⇧I cap").toBeTruthy();
  }, 30_000);

  it("by the key: ⇧I writes the same one set", async () => {
    await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead("x2");
    await key("I", { shiftKey: true });
    expect(deliberate()).toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
  }, 30_000);

  it("after the press, u marks x2 unread alone and the slot says Mark as read again", async () => {
    await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead("x2");
    await click(readSlot(col()), "Mark read");
    await key("u");
    expect(deliberate().slice(1), "u is the one message").toEqual([{ ids: ["x2"], unread: true }]);
    expect(unseenPanel("a1"), "a1 stays read").toBe(false);
    expect(label(col())).toBe("Mark read");
  }, 30_000);

  it("Undo puts back exactly a1, nothing for x2", async () => {
    const host = await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead("x2");
    await click(readSlot(col()), "Mark read");
    await click(undoPress(), "Undo");
    expect(deliberate().slice(1)).toEqual([{ ids: ["a1"], unread: true }]);
    expect(host.isConnected).toBe(true);
  }, 30_000);

  it("a five-unread thread opened at the newest is ONE request carrying the four siblings", async () => {
    await mountThread([msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30), msg("p5", 40)]);
    await openAndRead("p5");
    expect(glances().map((p) => p.ids)).toEqual([["p5"]]);
    await click(readSlot(col()), "Mark read");
    expect(deliberate()).toEqual([{ ids: ["p1", "p2", "p3", "p4"], unread: false, openRead: true }]);
  }, 30_000);

  it("a resurfaced sibling is outside the set: with only it left, the slot says Mark unread", async () => {
    const { pin, row } = pinOf("a1");
    await mountThread([msg("a1", 0, { triage: pin }), row, msg("x2", 60)]);
    await openAndRead("x2");
    expect(current()).toBe("x2");
    expect(label(col()), "the pin is the row's to release, not this press's").toBe("Mark unread");
  }, 30_000);

  it("⇧I on a resurfaced open message stays its own deliberate read, not the unread sibling's", async () => {
    const { pin, row } = pinOf("x2");
    await mountThread([msg("a1", 0), msg("x2", 60, { unread: false, triage: pin }), row]);
    await openAndRead("x2");
    expect(current(), "the pin's row opens at the pin").toBe("x2");
    await key("I", { shiftKey: true });
    expect(deliberate(), "the pin's way out, as before").toEqual([{ ids: ["x2"], unread: false }]);
  }, 30_000);

  it("one id the server does not hold refuses the press: rolled back, no success sentence", async () => {
    await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead("x2");
    serverLacks("a1");
    await click(readSlot(col()), "Mark read");
    await settle();
    expect(deliberate()).toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
    expect(toastText(), "no success sentence").not.toMatch(/\d+ · Read/);
    expect(toastText().trim().length, "a refusal sentence shows").toBeGreaterThan(0);
    expect(unseenPanel("a1"), "the overlay rolled back").toBe(true);
    expect(label(col())).toBe("Mark read");
  }, 30_000);

  it("partial: the second chunk refused — the sentence says how many, the Undo takes back exactly the first", async () => {
    const many = Array.from({ length: 201 }, (_, i) => msg(`s${String(i).padStart(3, "0")}`, i));
    await mountThread([...many, msg("x", 400)]);
    await openAndRead("x");
    serverLacks("s200");
    await click(readSlot(col()), "Mark read");
    await settle();
    expect(deliberate().map((p) => [p.ids.length, p.unread])).toEqual([[200, false], [1, false]]);
    expect(toastText()).toContain("Marked 200 of 201 as read");
    await click(undoPress(), "Undo");
    const undo = deliberate().slice(2);
    expect(undo.map((p) => [p.ids.length, p.unread]), "the landed chunk's ids back, nothing for the refused one").toEqual([[200, true]]);
    expect(undo[0]!.ids).not.toContain("s200");
  }, 60_000);

  it("a render whose mirror has not moved walks the mirror for the read set no more", async () => {
    const { readSetWalks } = await import("@ohmail/app-logic/reading/conversation-on-screen");
    await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead("x2");
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
    await mountThread([...many, msg("x", 400)]);
    await openAndRead("x");
    await click(readSlot(col()), "Mark read");
    expect(deliberate().map((p) => [p.ids.length, p.unread])).toEqual([[200, false], [1, false]]);
    expect(toastText()).toContain("201 · Read");
    expect(toastText().match(/201 · Read/g)?.length, "one sentence").toBe(1);
    await click(undoPress(), "Undo");
    expect(deliberate().slice(2).map((p) => [p.ids.length, p.unread])).toEqual([[200, true], [1, true]]);
    expect(patches.every((p) => p.ids.length <= 200), "nothing the route refuses").toBe(true);
  }, 60_000);
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
    await mountThread([msg("a1", 0), msg("x2", 60)]);
    await openAndRead("x2");
    const sheet = openLetter(document);
    expect(sheet?.querySelector("[data-conv-id]"), "the sheet shows the conversation").toBeTruthy();
    expect(label(sheet!)).toBe("Mark read");
    await click(readSlot(sheet!), "the sheet's Mark as read");
    expect(deliberate()).toEqual([{ ids: ["a1"], unread: false, openRead: true }]);
    expect(label(sheet!)).toBe("Mark unread");
  }, 30_000);
});
