/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, answerStoreWith, goTo, installShellEnv, liveAccountResponse, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { ME, arriveLater, click, key, mountThread, msg, patches, readSlot, settle, theRow } from "./fixtures/thread-read-shell.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";
import { barVerb, letterShown, lettersShown, menuItem, menuItems, openLetter, readingColumn, readingScroller } from "./ohbox/_finders.js";

/**
 * THE REPORTED CASE (OHBOX-THREAD-OPEN-LEAVES-ITS-NEW-MESSAGES-UNREAD), through the shipped shell:
 * a conversation of several unread replies opened from the Ohbox showed no state and left them
 * unread. Now every message in a conversation the person ENTERED turns read once its first lines
 * have been on screen for the 0.7 s dwell and its sender line, or the end of its text, has been on
 * screen (owner ruling 2026-10-23: "having seen the top part of a message should be sufficient to mark
 * it read"), and the write goes out after the dwell, never before. The column of squares and
 * the tint say which are new; a j/k preview reads nothing; Mark unread sits in each message's ⋯
 * beside Reply and Forward. The reader has a laid-out geometry here (`thread-layout.ts`): an 800px
 * viewport, the bar at 740, panels 400px tall and 20 apart, a sender line 20px down and the first
 * lines from 80px to 152px; the dwell is passed by hand (`passDwell`).
 */

/*
 * RE-POINTED (share reader-1, the switch's older tests): the shell these cases walk is the new one (the shared
 * fixtures mount the web's `MailShell`: the frame over the mail ground, the seated Ohbox and the reader), and every
 * part is found where the new reader draws it: the reading sheet's scrolling box, a letter by `data-conv-id` (the
 * mark the read rule reads), the action panel's verbs and a letter's own menu by role and name, the column of
 * squares by its name ("4 messages, 4 unread") with each square's state (`data-kind`: unseen, seen, own) read as
 * today's square classes said it. Expectations as they stood; a case whose part the new reader does not draw says so
 * where it stands.
 */
const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
const deliberate = () => patches.filter((p) => p.via === undefined);
/** The reading sheet's scrolling box: the column the letters scroll in. */
const col = (): HTMLElement => readingScroller(document)!;
/** The column of squares beside the letters, by its name ("4 messages, 4 unread"; "2 messages, all read"). */
const squaresColumn = (): HTMLElement | null =>
  [...(readingColumn(document)?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])]
    .find((g) => /^\d+ messages, /.test(g.getAttribute("aria-label") ?? "")) ?? null;
const KIND: Record<string, string> = { unseen: "unread", seen: "read", own: "own", draft: "draft" };
const squares = (): string[] =>
  [...(squaresColumn()?.querySelectorAll<HTMLElement>("[data-square]") ?? [])].map((s) => KIND[s.dataset.kind ?? ""] ?? "?");
const panel = (id: string): HTMLElement | null => letterShown(document, id);
const unseen = (id: string): boolean => panel(id)?.hasAttribute("data-unseen") ?? false;
/** The letter the ring stands on: the square the reader is on (`data-here`), by its place in the conversation. */
const ring = (): string | undefined => {
  const at = squaresColumn()?.querySelector<HTMLElement>("[data-square][data-here]")?.dataset.square;
  return at === undefined ? undefined : lettersShown(document)[Number(at)];
};
/** Letter `id`'s square in the column beside the letters. */
const squareOf = (id: string): HTMLElement | null =>
  squaresColumn()?.querySelector<HTMLElement>(`[data-square="${lettersShown(document).indexOf(id)}"]`) ?? null;
/** A letter's own menu button, at its head ("Message"). */
const letterMenu = (id: string): HTMLElement | null => panel(id)?.querySelector<HTMLElement>('button[aria-label="Message"]') ?? null;
const bodies = (ids: string[]): void => answerStoreWith([], Object.fromEntries(ids.map((id) => [id, `the words of ${id}`])));
const four = () => [msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30)];
const rowOf = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[role="listbox"] :is(.row, [role=option])[data-id="${id}"]`);
let layout: ThreadLayout;

beforeAll(async () => {
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => {
  installShellEnv();
  layout = stubThreadLayout();
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  layout.restore();
  await teardownShellEnv();
  vi.unstubAllGlobals();
});

/** The dwell passes, and the write it owes lands. */
async function dwell(): Promise<void> {
  await layout.passDwell();
  await settle();
}

/** Today's item ids, by the names the letter's own menu gives the same items. */
const ITEM: Record<string, string> = { Reply: "reply", "Reply all": "reply_all", Forward: "forward", "Mark unread": "mark_unread" };
/** The items of letter `of`'s own menu, read with it open and closed again. */
async function menuOf(of: string): Promise<string[]> {
  await click(letterMenu(of), `${of}'s menu`);
  const items = menuItems().map((el) => ITEM[(el.textContent ?? "").trim()] ?? (el.textContent ?? "").trim());
  await click(letterMenu(of), `${of}'s menu again`);
  return items;
}

describe("the reported case: a conversation of unread replies, opened with ↵", () => {
  it("the column shows a square per message; the newest, on screen, is read once the dwell is done", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    expect(unseen("p4"), "the opened panel wears the unread state while it is unread").toBe(true);
    expect(glances(), "a preview reads nothing").toEqual([]);
    await key("Enter");
    expect(glances(), "the write waits for the dwell").toEqual([]);
    expect(squares()).toEqual(["unread", "unread", "unread", "unread"]);
    await dwell();
    expect(squares(), "oldest first: three new, the one on screen read").toEqual(["unread", "unread", "unread", "read"]);
    expect(glances(), "one glance, for the newest").toEqual([["p4"]]);
    expect(deliberate()).toEqual([]);
    expect(unseen("p3")).toBe(true);
    expect(unseen("p4")).toBe(false);
  }, 30_000);

  it("scrolling up reads each earlier message whose top stays in view, a cut sender line over its whole text too; a pass reads nothing", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await key("Enter");
    await dwell();
    // p3's top comes in and goes again before the dwell: a pass.
    await layout.handScroll(layout.topOf("p3") - 10);
    await settle();
    await layout.handScroll(layout.topOf("p4") - 14);
    await settle();
    await dwell();
    expect(glances(), "a pass shorter than the dwell").toEqual([["p4"]]);
    // p3's top stays: read, though its end is under p4.
    await layout.handScroll(layout.topOf("p3") - 10);
    await settle();
    await dwell();
    expect(glances()).toEqual([["p4"], ["p3"]]);
    // p2's sender line scrolled off the top by 10px, its first lines and the end of its text in view.
    await layout.handScroll(layout.topOf("p2") + 30);
    await settle();
    await dwell();
    expect(glances(), "its whole text was on screen").toEqual([["p4"], ["p3"], ["p2"]]);
    expect(squares()).toEqual(["unread", "read", "read", "read"]);
    await click(readSlot(document), "Mark read");
    expect(deliberate(), "the rest of the conversation in one request").toEqual([{ ids: ["p1"], unread: false, openRead: true }]);
  }, 30_000);

  it("leaving before the dwell is done writes nothing for the newest (the write is after the dwell, not before)", async () => {
    bodies(["p1", "p2", "p3", "p4", "s1"]);
    const host = await mountThread([...four(), msg("s1", 40, { threadId: "S" })]);
    await click(rowOf(host, "p4"), "the conversation's row");
    expect(glances(), "entered, on screen, the dwell under way").toEqual([]);
    await click(rowOf(host, "s1"), "another conversation's row, at once");
    await dwell();
    expect(glances().flat(), "the quick pass left p4 unread").not.toContain("p4");
    expect(glances(), "the conversation now open reads after its own dwell").toEqual([["s1"]]);
  }, 30_000);
});

/**
 * THE OWNER'S CASE (2026-10-26): the latest of two messages went to 34 people, so its To list fills
 * the screen and its body starts far below its sender line. The sender line is seen at the open, the
 * first lines on the way down; held for the dwell, they read it. Here the latest is 2400px tall, its
 * body 900px down; the view is the 740px above the bar.
 */
describe("a To list taller than the view: the latest of two, opened and read down", () => {
  const tallHeader = async (older: Record<string, unknown> = {}): Promise<HTMLElement> => {
    layout.restore();
    layout = stubThreadLayout({ heights: { q2: 2400 }, bodyAt: { q2: 900 } });
    bodies(["q1", "q2"]);
    return mountThread([msg("q1", 0, older), msg("q2", 10)]);
  };
  /** A person reading down: a wheel's 240px at a time, a dwell's worth of reading at each stop. */
  const readDown = async (to: number): Promise<void> => {
    for (let y = layout.scroller().scrollTop; y < to;) {
      y = Math.min(to, y + 240);
      await layout.handScroll(y);
      await settle();
      await dwell();
    }
  };
  const theEnd = (): number => layout.topOf("q2") + 2400 - layout.barTop;

  it("opened and read down to its end: it turns read, the reader's line and the row's dot go", async () => {
    const host = await tallHeader({ unread: false });
    await goTo("ohbox/m/q2");
    await settle();
    await dwell();
    expect(glances(), "its sender line alone is not its top").toEqual([]);
    await readDown(layout.topOf("q2") + 200);
    expect(glances(), "the To list on screen, the first lines still under the bar").toEqual([]);
    await readDown(theEnd());
    expect(glances(), "one \\Seen write, once its first lines held on the way down").toEqual([["q2"]]);
    expect(unseen("q2"), "the reader's unread line").toBe(false);
    expect(theRow(host)?.hasAttribute("data-unseen"), "the row's dot").toBe(false);
  }, 60_000);

  it("both unread: the older, never on screen, keeps the row's dot until its own top is seen", async () => {
    const host = await tallHeader();
    await goTo("ohbox/m/q2");
    await settle();
    await dwell();
    await readDown(theEnd());
    expect(glances(), "the latest, read down").toEqual([["q2"]]);
    expect(unseen("q1"), "the older was never on screen").toBe(true);
    expect(theRow(host)?.hasAttribute("data-unseen"), "the row keeps its dot for the older").toBe(true);
    await layout.handScroll(layout.topOf("q1"));
    await settle();
    await dwell();
    expect(glances()).toEqual([["q2"], ["q1"]]);
    expect(theRow(host)?.hasAttribute("data-unseen"), "the row's dot").toBe(false);
  }, 60_000);

  it("a single letter to as many, opened at its top and read down: read", async () => {
    layout.restore();
    layout = stubThreadLayout({ heights: { s1: 2400 }, bodyAt: { s1: 900 } });
    bodies(["s1"]);
    const host = await mountThread([msg("s1", 0, { threadId: "S" })]);
    await click(theRow(host), "the letter's row");
    await dwell();
    expect(glances(), "its sender line alone").toEqual([]);
    await readDown(layout.topOf("s1") + 2400 - layout.barTop);
    expect(glances()).toEqual([["s1"]]);
    expect(theRow(host)?.hasAttribute("data-unseen"), "the row's dot").toBe(false);
  }, 60_000);
});

/**
 * FIFTEEN MESSAGES, THE LAST THREE UNREAD, opened by choosing its last message.
 * m14's sender line sits just above the view while its first lines and the end of its text stand on
 * screen: it turns read with m15. m13, off screen or only its tail on screen, stays unread with the
 * row's dot and its dark square until its first lines have held on screen.
 */
describe("fifteen messages, the last three unread, opened at the end", () => {
  const fifteen = async (heights: Record<string, number>): Promise<HTMLElement> => {
    layout.restore();
    layout = stubThreadLayout({ heights });
    const ids = Array.from({ length: 15 }, (_, i) => `m${i + 1}`);
    bodies(ids);
    const host = await mountThread(ids.map((id, i) => msg(id, i * 10, i < 12 ? { unread: false } : {})));
    await goTo("ohbox/m/m15");
    await settle();
    await press(col(), "the column");
    return host;
  };
  /** Where a message's top stands in the view. */
  const inView = (id: string): number => layout.topOf(id) - layout.scroller().scrollTop;

  it("m14's sender line cut, its first lines and its end on screen: read with m15; m13 off screen keeps the row's dot", async () => {
    const host = await fifteen({ m14: 500, m15: 230 });
    expect(inView("m14"), "m14's sender line cut at the top").toBe(-50);
    expect(inView("m13") + 400, "m13 wholly above the view").toBeLessThan(0);
    await dwell();
    await dwell();
    expect(glances()).toEqual([["m14", "m15"]]);
    expect(squares().slice(-3)).toEqual(["unread", "read", "read"]);
    expect(unseen("m13")).toBe(true);
    expect(theRow(host)?.hasAttribute("data-unseen"), "the row's dot, for m13").toBe(true);
  }, 60_000);

  it("m13 with only its tail on screen stays unread; its first lines held, its sender line cut, read it", async () => {
    const host = await fifteen({ m13: 600, m14: 300, m15: 230 });
    expect(inView("m13") + 600, "m13's tail on screen").toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) await dwell();
    expect(glances()).toEqual([["m14", "m15"]]);
    expect(unseen("m13"), "only its tail was on screen").toBe(true);
    expect(theRow(host)?.hasAttribute("data-unseen")).toBe(true);
    await layout.handScroll(layout.topOf("m13") + 50);
    await settle();
    await dwell();
    expect(glances()).toEqual([["m14", "m15"], ["m13"]]);
    expect(theRow(host)?.hasAttribute("data-unseen"), "the row's dot").toBe(false);
  }, 60_000);
});

describe("a preview reads nothing until rested on", () => {
  it("j and a second of looks write nothing; a wheel in the column then reads", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await tick(500);
    await act(async () => { window.dispatchEvent(new Event("focus")); }); // a look, with the time passed
    await tick(500);
    expect(patches, "no write for a preview left within the rest").toEqual([]);
    expect(squares()).toEqual(["unread", "unread", "unread", "unread"]);
    await layout.handScroll(layout.topOf("p4") - 14);
    await settle();
    await dwell();
    expect(glances()).toEqual([["p4"]]);
  }, 30_000);

  it("j and a rest: what is on screen reads, as after a click", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await tick(2400);
    await settle();
    expect(glances()).toEqual([["p4"]]);
    expect(squares()).toEqual(["unread", "unread", "unread", "read"]);
  }, 30_000);

  it("a click on the row enters it: what is on screen reads after the dwell", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    const host = await mountThread(four());
    await click(theRow(host), "the conversation's row");
    expect(layout.scroller().scrollTop).toBeGreaterThan(500);
    expect(ring()).toBe("p4");
    await dwell();
    expect(glances()).toEqual([["p4"]]);
  }, 30_000);

  it("a click on the bar's Later in a preview files the conversation unread; its Mark read is one write", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const later = barVerb(document, "Later");
    // A real click: the press, a moment, the click — the press enters the visit, the verb runs at the click.
    await act(async () => { later?.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await tick(90);
    await click(later, "the bar's Later");
    await dwell();
    expect(glances(), "the press on the verb read nothing before the verb ran").toEqual([]);

    bodies(["q1", "q2", "q3", "q4"]);
    await teardownShellEnv();
    installShellEnv();
    window.location.hash = "#/ohbox";
    await mountThread([msg("q1", 0), msg("q2", 10), msg("q3", 20), msg("q4", 30)]);
    await key("j");
    const read = readSlot(document);
    await act(async () => { read?.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await tick(90);
    await click(read, "the bar's Mark read");
    await dwell();
    expect(glances(), "no glance split off").toEqual([]);
    expect(deliberate().map((p) => p.ids), "the whole conversation in one write").toEqual([["q1", "q2", "q3", "q4"]]);
  }, 60_000);
});

/** A press as a person makes it, held: the pointer (or a finger) goes down and stays. */
const press = async (el: Element | null | undefined, what: string, type: "pointerdown" | "touchstart" | "touchmove" = "pointerdown"): Promise<void> => {
  expect(el, `nothing to press: ${what}`).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new Event(type, { bubbles: true })); });
  await settle();
};

describe("a press on a verb is not reading: it never enters a preview", () => {
  it("a mouse press on Later held past the dwell reads nothing", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await press(barVerb(document, "Later"), "the bar's Later");
    await dwell();
    expect(glances(), "the press on the bar read the previewed message").toEqual([]);
  }, 60_000);

  it("a touch on Later held past the dwell reads nothing, nor does a tap's jitter on it", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const later = barVerb(document, "Later");
    await press(later, "the bar's Later", "touchstart");
    await dwell();
    expect(glances(), "the touch on the bar read the previewed message").toEqual([]);
    await press(later, "the bar's Later", "touchmove");
    await dwell();
    expect(glances(), "a touchmove with no scroll read the previewed message").toEqual([]);
  }, 60_000);

  it("Resurface opened by mouse, the dwell passed, then Tomorrow: nothing read", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const resurface = barVerb(document, "Resurface");
    await press(resurface, "the bar's Resurface");
    await click(resurface, "the bar's Resurface");
    await dwell();
    const tomorrow = menuItem("Tomorrow");
    await press(tomorrow, "Tomorrow");
    await click(tomorrow, "Tomorrow");
    await dwell();
    expect(glances(), "the chooser's presses read the previewed message").toEqual([]);
  }, 60_000);

  it("Move by mouse, the dwell passed, then → News: nothing read", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    // Move stands behind More on the new panel (the reader's design): More, then Move, then News, each a press.
    const more = barVerb(document, "More");
    await press(more, "the bar's More");
    await click(more, "the bar's More");
    const move = menuItem("Move");
    await press(move, "More's Move");
    await click(move, "More's Move");
    await dwell();
    const news = menuItem("News");
    await press(news, "→ News");
    await click(news, "→ News");
    await dwell();
    expect(glances(), "the Move presses read the previewed message").toEqual([]);
  }, 60_000);

  it("a press on a message's ⋯ reads nothing", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await press(letterMenu("p4"), "p4's ⋯");
    await dwell();
    expect(glances(), "the press on the ⋯ read the previewed message").toEqual([]);
  }, 60_000);

  it("a single message: a press on its bar's own ground, inside its panel, reads nothing", async () => {
    bodies(["s1"]);
    await mountThread([msg("s1", 0, { threadId: "S" })]);
    await key("j");
    const bar = readingColumn(document)?.querySelector('[role="toolbar"][aria-label="Actions"]');
    expect(bar, "the single message's bar sits inside its panel").toBeTruthy();
    await press(bar, "the single message's bar");
    await dwell();
    expect(glances(), "a press on the bar's ground read the previewed message").toEqual([]);
  }, 60_000);

  it("a press on a message's text enters: what is on screen reads after the dwell", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await press(panel("p4")?.querySelector("[data-read-body]"), "p4's text");
    await dwell();
    expect(glances()).toEqual([["p4"]]);
  }, 60_000);

  it("a press on the column's own box (its scrollbar) enters", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await press(col(), "the column");
    await dwell();
    expect(glances()).toEqual([["p4"]]);
  }, 60_000);
});

describe("Mark unread in a message's ⋯, beside Reply and Forward", () => {
  it("writes an unread for that message only, the square is solid again, and it is not read back", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await key("Enter");
    await dwell();
    expect(await menuOf("p4"), "appended after the production menu").toEqual(["reply", "forward", "mark_unread"]);
    await click(letterMenu("p4"), "p4's ⋯");
    const item = menuItem("Mark unread");
    expect(item?.textContent).toContain("Mark unread");
    await click(item, "Mark unread");
    expect(deliberate()).toEqual([{ ids: ["p4"], unread: true }]);
    expect(squares()).toEqual(["unread", "unread", "unread", "unread"]);
    await layout.handScroll(0);
    await layout.handScroll(layout.topOf("p4") - 14);
    await settle();
    await dwell();
    expect(glances().flat().filter((id) => id === "p4"), "kept unread for the visit").toEqual(["p4"]);
  }, 30_000);

  it("is not offered on an unread message, nor on the account's own", async () => {
    bodies(["p1", "p2", "p3", "o1"]);
    await mountThread([
      msg("p1", 0), msg("p2", 10, { unread: false }),
      msg("o1", 15, { unread: false, folder: "Sent", from: { name: "Walker", address: ME } }), msg("p3", 20),
    ]);
    await key("j");
    expect(await menuOf("p1"), "unread: nothing to mark").not.toContain("mark_unread");
    expect(await menuOf("o1"), "your own message").not.toContain("mark_unread");
    expect(await menuOf("p2"), "a read message from someone else").toContain("mark_unread");
  }, 30_000);
});

describe("u keeps the opened message unread", () => {
  it("u on the previewed message, then ↵: the rule leaves it unread", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await key("u");
    await key("Enter");
    await settle();
    await dwell();
    expect(glances().flat()).not.toContain("p4");
    expect(unseen("p4")).toBe(true);
  }, 30_000);
});

describe("a single message", () => {
  it("has no column and no row squares; a long one reads once its top has been in view, its end not needed", async () => {
    bodies(["s1"]);
    layout.heights.s1 = 1400;
    const host = await mountThread([msg("s1", 0, { threadId: "S" })]);
    expect(theRow(host)?.querySelector('[role="group"][aria-label*="messages"]'), "no squares for one message").toBeNull();
    await key("j");
    await key("Enter");
    expect(squaresColumn(), "no column").toBeNull();
    expect(glances(), "the dwell is under way").toEqual([]);
    await dwell();
    expect(glances(), "its end is under the bar, its top was read").toEqual([["s1"]]);
  }, 30_000);

  it("opens at its own top, never at the offset the conversation before it left (by click and by j)", async () => {
    bodies(["p1", "p2", "p3", "p4", "s1"]);
    layout.heights.s1 = 2000;
    const host = await mountThread([...four(), msg("s1", 1, { threadId: "S" })]);
    await click(rowOf(host, "p4"), "the conversation's row");
    expect(layout.scroller().scrollTop, "the conversation opens on its newest").toBeGreaterThan(500);
    expect(ring()).toBe("p4");
    await layout.handScroll(layout.topOf("p3"));
    expect(layout.scroller().scrollTop).toBeGreaterThan(500);
    await click(rowOf(host, "s1"), "the single letter's row");
    expect(panel("s1"), "the single letter is open").not.toBeNull();
    expect(layout.scroller().scrollTop, "the letter starts at its sender line").toBe(0);
    await click(rowOf(host, "p4"), "the conversation again");
    await layout.handScroll(layout.topOf("p3"));
    expect(layout.scroller().scrollTop).toBeGreaterThan(500);
    await key("j");
    expect(panel("s1"), "j previews the letter").not.toBeNull();
    expect(layout.scroller().scrollTop, "a preview lands at its top too").toBe(0);
  }, 30_000);
});

describe("the column of squares stands beside the scroller, never in it", () => {
  /* Owner report, desktop: the squares flickered and jumped while the conversation scrolled.
     WebKitGTK moves a sticky box inside a scroller apart from the scroll itself, so for a frame
     the column rode with the panels and snapped back. Outside the scroller nothing moves it. */
  const bar = (): HTMLElement => squaresColumn()!;

  it("is not inside the reading column; a scroll there moves the panels and the ring, never the squares", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await key("Enter");
    expect(bar(), "the column of squares").not.toBeNull();
    expect(col().contains(bar()), "the squares scroll with the panels").toBe(false);
    expect(bar().closest(".oh-sheet-gutter")?.parentElement, "beside the column, in its view").toBe(col().parentElement);
    await layout.handScroll(layout.topOf("p1"));
    await settle();
    expect(ring(), "the ring follows the panel in view").toBe("p1");
  }, 30_000);

  it("a wheel over the squares scrolls the conversation and is the person's, as when they stood in it", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await dwell();
    const from = layout.scroller().scrollTop;
    expect(from, "opened on the newest, far down").toBeGreaterThan(300);
    await act(async () => { bar().dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true, cancelable: true })); });
    expect(layout.scroller().scrollTop).toBe(from - 300);
    await act(async () => { bar().dispatchEvent(new WheelEvent("wheel", { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true })); });
    expect(layout.scroller().scrollTop, "lines are 40px").toBe(from - 300 + 120);
    await settle();
    await dwell();
    expect(glances(), "the preview was entered: what is on screen reads").not.toEqual([]);
  }, 30_000);

  it("comes back with the Ohbox: a conversation still open on return has its squares, and so has the next", async () => {
    /* Review finding: remounted with the selection set, the column's box was looked for before the
       reading column's ref was attached, and never again: no squares until the pane remounted. */
    bodies(["p1", "p2", "p3", "p4", "s1", "s2"]);
    await mountThread([...four(), msg("s1", 40, { threadId: "S" }), msg("s2", 41, { threadId: "S" })]);
    await key("j");
    await key("Enter");
    expect(squares()).toHaveLength(2);
    // The new shell keeps the open letter in the address: the way back to it is the address it stood on (Back).
    const open = window.location.hash.slice(2);
    for (const away of ["history", "settings", "screener"]) {
      await goTo(away);
      await goTo(open);
      await settle();
      expect(squares(), `back from ${away}`).toHaveLength(2);
    }
    await key("j");
    expect(squares(), "the next conversation's own").toHaveLength(4);
    await key("k");
    expect(squares()).toHaveLength(2);
  }, 30_000);

  it("in the reader sheet (a narrow window) the squares stay inside the sheet's conversation", async () => {
    /* Review finding: the sheet's scroller is `.reader`, not the split's column; the box stood
       beside it in `.app-root`, under the opaque sheet, and a press closed the sheet. */
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await key("Enter");
    const sheet = openLetter(document);
    expect(sheet, "the reading sheet").not.toBeNull();
    const ofTheConversation = (g: Element): boolean => /^\d+ messages, /.test(g.getAttribute("aria-label") ?? "") && g.closest('[role="option"]') === null;
    const marks = [...sheet!.querySelectorAll<HTMLElement>('[role="group"]')].find(ofTheConversation) ?? null;
    expect(marks, "the column, in the sheet's conversation").not.toBeNull();
    expect(marks!.querySelectorAll("[data-square]")).toHaveLength(4);
    expect([...document.querySelectorAll('[role="group"]')].filter((g) => ofTheConversation(g) && !sheet!.contains(g)), "nothing beside the sheet").toHaveLength(0);
  }, 30_000);
});

describe("a reply that arrives into the open conversation", () => {
  it("is not read while the window is away; back, it reads once its top has been in view for the dwell", async () => {
    bodies(["p1", "p2", "p3"]);
    // A short conversation: the whole of it, and the reply to come, fit above the bar.
    Object.assign(layout.heights, { p1: 150, p2: 150, p3: 150 });
    const host = await mountThread([msg("p1", 0), msg("p2", 10)]);
    await click(theRow(host), "the conversation's row");
    await dwell();
    expect(glances()).toEqual([["p1", "p2"]]);
    // The person switches to another window; a short reply lands in view under the open panels.
    layout.focused = false;
    arriveLater([msg("p3", 20)], ["p1", "p2", "p3"]);
    await tick(20_000);
    await settle();
    expect(panel("p3"), "the reply never arrived: the case is not exercised").not.toBeNull();
    await dwell();
    expect(unseen("p3"), "read while nobody was looking").toBe(true);
    // The window comes back: the reply's top is in view, and the dwell then reads it — no key needed.
    layout.focused = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(glances(), "not before the dwell").toEqual([["p1", "p2"]]);
    await dwell();
    expect(glances()).toEqual([["p1", "p2"], ["p3"]]);
  }, 60_000);
});

/** A row opens on the newest letter whether clicked or entered from the keyboard. */
describe("a conversation opens on its newest, every time", () => {
  const holding = (host: HTMLElement, id: string): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[role="listbox"] :is(.row, [role=option])[data-ids~="${id}"]`) ?? rowOf(host, id);
  const focused = ring;
  const a20 = async (): Promise<HTMLElement> => {
    layout.restore();
    layout = stubThreadLayout({ heights: { p2: 2400, p3: 2400 }, bodyAt: { p2: 900 } });
    bodies(["p1", "p2", "p3", "p4", "s1"]);
    const host = await mountThread([...four(), msg("s1", 40, { threadId: "S" })]);
    await click(holding(host, "p4"), "the conversation's row");
    expect(focused(), "the first open").toBe("p4");
    expect(layout.scroller().scrollTop).toBeGreaterThan(500);
    await click(squareOf("p1"), "the oldest message square");
    expect(focused()).toBe("p1");
    await dwell();
    expect(glances()).toEqual([["p1"]]);
    await click(holding(host, "s1"), "another conversation");
    await dwell();
    expect(glances()).toEqual([["p1"], ["s1"]]);
    return host;
  };

  it("reopened by click: lands on p4, reads nothing; a second click stays; p3's top in view reads it as an open read", async () => {
    const host = await a20();
    expect(holding(host, "p4")?.dataset.id, "the row stands for its newest").toBe("p4");
    await click(holding(host, "p4"), "the conversation again");
    expect(focused(), "the reopen lands on the newest").toBe("p4");
    await dwell();
    expect(glances(), "the reopen reads nothing it did not show").toEqual([["p1"], ["s1"], ["p4"]]);
    await click(squareOf("p2"), "an earlier square");
    expect(focused()).toBe("p2");
    await click(holding(host, "p4"), "the same row again");
    expect(focused(), "the same row returns to the newest").toBe("p4");
    await dwell();
    expect(glances()).toEqual([["p1"], ["s1"], ["p4"]]);
    await layout.handScroll(layout.topOf("p3") - 10);
    await settle();
    await dwell();
    expect(glances().at(-1)).toEqual(["p3"]);
    const last = patches.filter((p) => p.via === "glance").at(-1) as { openRead?: boolean };
    expect(last.openRead, "the conversation is held: the read is an open read").toBe(true);
  }, 60_000);

  it("reopened by ↵: lands on p4 and reads nothing", async () => {
    const host = await a20();
    const rows = [...host.querySelectorAll<HTMLElement>('[role="listbox"] :is(.row, [role=option])')];
    const step = rows.indexOf(holding(host, "p4")!) > rows.indexOf(holding(host, "s1")!) ? "j" : "k";
    await key("Escape");
    await key(step);
    await key("Enter");
    expect(focused(), "the reopen lands on the newest").toBe("p4");
    await dwell();
    expect(glances(), "the reopen reads only the letter it showed").toEqual([["p1"], ["s1"], ["p4"]]);
  }, 60_000);
});

/**
 * THE WALK (owner 2026-10-24, o9): the ring is the LAST message whose top has crossed a reading
 * line 30 % down the view, the line sliding so every top crosses it in order and the last message
 * is current at the very end, a one-line one too; never a step back on a one-way scroll. A press
 * puts that message's top on the line and holds the ring there until the person scrolls. The open
 * conversation's ROW carries the same squares (the strip) with the same ring; a press on either
 * scrolls the reader. Geometry here: tops 0/420/840/1260, p4 60px tall, the view 740 (the bar at
 * 740), so the scroll's end is 620.
 */
describe("the walk: the ring follows the reading line, the row's strip follows the ring", () => {
  const railButton = squareOf;
  const ORDER = ["p1", "p2", "p3", "p4"];
  /** Where a press on p2 lands: its top on the line (computed apart from the code under test). */
  const P2_LANDS = 119;
  const shortLast = async (extra: unknown[] = []): Promise<HTMLElement> => {
    layout.restore();
    layout = stubThreadLayout({ heights: { p4: 60 } });
    bodies(["p1", "p2", "p3", "p4", "s1"]);
    return mountThread([...four(), ...extra]);
  };

  it("at the top the first is current, at the end the one-line last; a sweep down never steps back", async () => {
    await shortLast();
    await key("j");
    await key("Enter");
    await layout.handScroll(0);
    await settle();
    expect(ring(), "the top").toBe("p1");
    const seen: string[] = [];
    for (let y = 0; y <= 620; y += 31) {
      await layout.handScroll(y);
      await settle();
      seen.push(ring()!);
    }
    await layout.handScroll(620);
    await settle();
    expect(ring(), "the very end: the short last message").toBe("p4");
    const idx = seen.map((id) => ORDER.indexOf(id));
    expect(idx.every((v, i) => i === 0 || v >= idx[i - 1]!), `a step back: ${seen.join(" ")}`).toBe(true);
    expect(new Set(seen), "every message is passed on the way").toEqual(new Set(ORDER));
  }, 30_000);

  it("a press on p2 puts its top on the line, holds the ring there until a hand scroll, and enters", async () => {
    await shortLast();
    await key("j");
    await click(railButton("p2"), "p2's square");
    expect(layout.scroller().scrollTop, "p2's top on the reading line").toBe(P2_LANDS);
    expect(ring()).toBe("p2");
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await settle();
    expect(ring(), "a measure keeps the pressed square").toBe("p2");
    await dwell();
    expect(glances().flat(), "the press entered the preview: p2's top on screen reads").toContain("p2");
    await layout.handScroll(0);
    await settle();
    expect(ring(), "the person's scroll ends the hold").toBe("p1");
  }, 30_000);

  /** The one chip on screen, or null. */
  /* The new reader's squares draw no chip yet (the rows say whose it is): what names a square is looked for as a tip. */
  const chip = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="tooltip"]');
  const point = async (el: Element | null, type: "pointerover" | "pointerout", related: Element | null = null): Promise<void> => {
    expect(el, `nothing to point at (${type})`).toBeTruthy();
    await act(async () => { el!.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: related })); });
  };

  /** A finger on `el`: down, then up after `ms`. */
  const touch = async (el: Element | null, type: "pointerdown" | "pointerup"): Promise<void> => {
    expect(el, `nothing to touch (${type})`).toBeTruthy();
    const e = new MouseEvent(type, { bubbles: true });
    Object.defineProperty(e, "pointerType", { value: "touch" });
    await act(async () => { el!.dispatchEvent(e); });
  };

  it("a finger held on a square shows its chip and never presses it; the chip goes after the finger", async () => {
    await shortLast();
    await key("j");
    await key("Enter");
    const at = layout.scroller().scrollTop;
    const was = ring();
    await point(railButton("p2"), "pointerover");
    await point(railButton("p2"), "pointerout");
    await touch(railButton("p2"), "pointerdown");
    await tick(300);
    expect(chip(), "not before the hold's 380 ms").toBeNull();
    await tick(100);
    expect(chip(), "the held square shows its chip").not.toBeNull();
    expect(chip()!.textContent, "the hold names the square").toMatch(/^Lenayesterday \d\d:10/);
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { railButton("p2")!.dispatchEvent(menu); });
    expect(menu.defaultPrevented, "the held square suppresses the native menu").toBe(true);
    await touch(railButton("p2"), "pointerup");
    await click(railButton("p2"), "the click that ends the hold");
    expect(layout.scroller().scrollTop, "the hold pressed the square").toBe(at);
    expect(ring()).toBe(was);
    expect(chip(), "the chip stays a moment after the finger").not.toBeNull();
    await tick(1200);
    expect(chip(), "then goes").toBeNull();
  }, 30_000);

  it("in the reader sheet, a tap on another square while a hold's chip stays drops that chip and presses", async () => {
    vi.stubGlobal("innerWidth", 390);
    await shortLast();
    await key("j");
    await key("Enter");
    const inSheet = (): HTMLElement | null =>
      [...(openLetter(document)?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])].find((g) => /^\d+ messages, /.test(g.getAttribute("aria-label") ?? "")) ?? null;
    const sq = (id: string): HTMLElement | null => inSheet()?.querySelector<HTMLElement>(`[data-square="${lettersShown(document).indexOf(id)}"]`) ?? null;
    const sheetRing = (): string | undefined => {
      const at = inSheet()?.querySelector<HTMLElement>("[data-square][data-here]")?.dataset.square;
      return at === undefined ? undefined : lettersShown(document)[Number(at)];
    };
    await touch(sq("p1"), "pointerdown");
    await tick(400);
    expect(chip(), "the held square shows its chip in the reading dialog").not.toBeNull();
    expect(chip()!.textContent, "the hold names p1").toMatch(/^Lenayesterday \d\d:00/);
    await touch(sq("p1"), "pointerup");
    await click(sq("p1"), "the click that ends the hold");
    await tick(300);
    await touch(sq("p3"), "pointerdown");
    await touch(sq("p3"), "pointerup");
    await click(sq("p3"), "a tap on p3 within the chip's stay");
    expect(chip(), "the held square's chip went with the new press").toBeNull();
    expect(sheetRing(), "the tap pressed p3").toBe("p3");
    await tick(2000);
    expect(chip()).toBeNull();
  }, 30_000);

});

describe("a letter opened from Search: the open enters it, as ↵ on its row does", () => {
  const letters = () => [msg("p1", 0), msg("p2", 10), msg("s1", 40, { threadId: "S", subject: "Harbour kettle" })];
  const openHit = (): HTMLElement | null => {
    const row = screen.queryAllByRole("listitem").find((item) => item.getAttribute("data-hit") === "s1");
    return row ? within(row).queryByRole("button", { name: /Harbour kettle/ }) : null;
  };
  /** Search asks the store: `GET /search?q=` answers s1 for "harbour". */
  async function search(q: string): Promise<HTMLInputElement> {
    const s1 = (msg("s1", 40, { threadId: "S", subject: "Harbour kettle" }) as { entity: unknown }).entity;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (!/\/search\?/.test(url)) return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
      const items = /harbour/i.test(new URL(url, "https://harness.invalid").searchParams.get("q") ?? "") ? [s1] : [];
      return liveAccountResponse(Response.json({ items, total: items.length, totalExact: true, ms: 4 }));
    }) as unknown as typeof globalThis.fetch;
    await goTo("search");
    const box = screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(box, q);
      box!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(1_000);
    await settle();
    expect(openHit(), "the hit").not.toBeNull();
    return box!;
  }

  it("↵ on the hit opens the letter unread; after the dwell it is read", async () => {
    await mountThread(letters());
    const box = await search("Harbour");
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(window.location.hash).toContain("ohbox");
    expect(unseen("s1"), "unread on arrival").toBe(true);
    expect(glances(), "nothing before the dwell").toEqual([]);
    await dwell();
    await dwell();
    expect(glances()).toEqual([["s1"]]);
  }, 60_000);

  it("a click on the hit: the same", async () => {
    await mountThread(letters());
    await search("Harbour");
    await click(openHit(), "the hit");
    expect(panel("s1"), "the column shows the letter").not.toBeNull();
    await dwell();
    await dwell();
    expect(glances()).toEqual([["s1"]]);
  }, 60_000);

  it("a narrow window: the hit opens the sheet and the sheet reads it", async () => {
    vi.stubGlobal("innerWidth", 390);
    await mountThread(letters());
    await search("Harbour");
    await click(openHit(), "the hit");
    const sheet = screen.getByRole("dialog", { name: "Reading" });
    expect(sheet.querySelector('[data-conv-id="s1"]'), "the sheet shows the letter").not.toBeNull();
    await dwell();
    await dwell();
    expect(glances()).toEqual([["s1"]]);
  }, 60_000);

  it("j within the dwell moves on: s1 is not read", async () => {
    await mountThread(letters());
    await search("Harbour");
    await click(openHit(), "the hit");
    expect(panel("s1")).not.toBeNull();
    await key("j");
    expect(window.location.hash).not.toContain("/m/s1");
    await dwell();
    await dwell();
    expect(glances().flat()).not.toContain("s1");
  }, 60_000);

  it("a link to the letter is still a preview: nothing read", async () => {
    await mountThread(letters());
    await act(async () => {
      window.location.hash = "#/ohbox/m/s1";
      window.dispatchEvent(new Event("hashchange"));
    });
    await settle();
    expect(panel("s1"), "the link opened the letter").not.toBeNull();
    await dwell();
    await dwell();
    expect(glances()).toEqual([]);
  }, 60_000);
});
