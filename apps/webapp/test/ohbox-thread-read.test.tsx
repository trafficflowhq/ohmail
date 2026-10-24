/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, answerStoreWith, goTo, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { ME, arriveLater, click, key, mountThread, msg, patches, readSlot, settle, theRow } from "./fixtures/thread-read-shell.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * THE REPORTED CASE (OHBOX-THREAD-OPEN-LEAVES-ITS-NEW-MESSAGES-UNREAD), through the shipped shell:
 * a conversation of several unread replies opened from the Ohbox showed no state and left them
 * unread. Now every message in a conversation the person ENTERED turns read once its TOP — its
 * sender line and its first lines — has been on screen for the 0.7 s dwell (owner ruling
 * 2026-10-23: "having seen the top part of a message should be sufficient to mark it read"); its
 * end is not needed, and the write goes out after the dwell, never before. The column of squares and
 * the tint say which are new; a j/k preview reads nothing; Mark unread sits in each message's ⋯
 * beside Reply and Forward. The reader has a laid-out geometry here (`thread-layout.ts`): an 800px
 * viewport, the bar at 740, panels 400px tall and 20 apart, a sender line 20px down and the first
 * lines from 80px to 152px; the dwell is passed by hand (`passDwell`).
 */

const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
const deliberate = () => patches.filter((p) => p.via === undefined);
const col = (): HTMLElement => document.querySelector<HTMLElement>(".read-col")!;
const squares = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".thread-marks .tm-sq")].map((s) => [...s.classList].find((c) => c !== "tm-sq")!);
const panel = (id: string): HTMLElement | null => col().querySelector<HTMLElement>(`[data-conv-id="${id}"]`);
const unseen = (id: string): boolean => panel(id)?.hasAttribute("data-unseen") ?? false;
const bodies = (ids: string[]): void => answerStoreWith([], Object.fromEntries(ids.map((id) => [id, `the words of ${id}`])));
const four = () => [msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30)];
const rowOf = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[role="listbox"] .row[data-id="${id}"]`);
let layout: ThreadLayout;

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
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
});

/** The dwell passes, and the write it owes lands. */
async function dwell(): Promise<void> {
  await layout.passDwell();
  await settle();
}

/** The items of panel `of`'s ⋯ menu, read with it open and closed again. */
async function menuOf(of: string): Promise<string[]> {
  const more = panel(of)?.querySelector(".msg-more");
  await click(more, `${of}'s ⋯`);
  const items = [...(panel(of)?.querySelectorAll<HTMLElement>('.msg-menu [role="menuitem"]') ?? [])].map((el) => el.dataset.item!);
  await click(more, `${of}'s ⋯ again`);
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

  it("scrolling up reads each earlier message whose top stays in view; a pass or a cut top reads nothing", async () => {
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
    // p2's first lines in view, its sender line scrolled off the top: its top was not seen.
    await layout.handScroll(layout.topOf("p2") + 30);
    await settle();
    await dwell();
    expect(glances(), "a cut top reads nothing").toEqual([["p4"], ["p3"]]);
    expect(squares()).toEqual(["unread", "unread", "read", "read"]);
    await click(readSlot(col()), "Mark read");
    expect(deliberate(), "the rest of the conversation in one request").toEqual([{ ids: ["p1", "p2"], unread: false, openRead: true }]);
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

describe("a preview reads nothing", () => {
  it("j and the dwell's worth of looks write nothing; a wheel in the column then reads", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await dwell();
    await act(async () => { window.dispatchEvent(new Event("focus")); }); // a look, with the time passed
    await dwell();
    expect(patches, "no write for a preview, however long it rests").toEqual([]);
    expect(squares()).toEqual(["unread", "unread", "unread", "unread"]);
    await layout.handScroll(layout.topOf("p4") - 14);
    await settle();
    await dwell();
    expect(glances()).toEqual([["p4"]]);
  }, 30_000);

  it("a click on the row enters it: what is on screen reads after the dwell", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    const host = await mountThread(four());
    await click(theRow(host), "the conversation's row");
    await dwell();
    expect(glances()).toEqual([["p4"]]);
  }, 30_000);

  it("a click on the bar's Later in a preview files the conversation unread; its Mark read is one write", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const later = col().querySelector<HTMLElement>(".abar .abar-later");
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
    const read = readSlot(col());
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
const barButton = (label: string): HTMLElement | undefined =>
  [...col().querySelectorAll<HTMLElement>(".abar button")].find((b) => b.textContent?.trim() === label);

describe("a press on a verb is not reading: it never enters a preview", () => {
  it("a mouse press on Later held past the dwell reads nothing", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await press(col().querySelector(".abar .abar-later"), "the bar's Later");
    await dwell();
    expect(glances(), "the press on the bar read the previewed message").toEqual([]);
  }, 60_000);

  it("a touch on Later held past the dwell reads nothing, nor does a tap's jitter on it", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const later = col().querySelector(".abar .abar-later");
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
    const resurface = col().querySelector(".abar .abar-resurface");
    await press(resurface, "the bar's Resurface");
    await click(resurface, "the bar's Resurface");
    await dwell();
    const tomorrow = barButton("Tomorrow");
    await press(tomorrow, "Tomorrow");
    await click(tomorrow, "Tomorrow");
    await dwell();
    expect(glances(), "the chooser's presses read the previewed message").toEqual([]);
  }, 60_000);

  it("Move by mouse, the dwell passed, then → News: nothing read", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const move = col().querySelector(".abar .abar-move");
    await press(move, "the bar's Move");
    await click(move, "the bar's Move");
    await dwell();
    const news = [...col().querySelectorAll<HTMLElement>(".abar button")].find((b) => b.textContent?.startsWith("→ News"));
    await press(news, "→ News");
    await click(news, "→ News");
    await dwell();
    expect(glances(), "the Move presses read the previewed message").toEqual([]);
  }, 60_000);

  it("a press on a message's ⋯ reads nothing", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await press(panel("p4")?.querySelector(".msg-more"), "p4's ⋯");
    await dwell();
    expect(glances(), "the press on the ⋯ read the previewed message").toEqual([]);
  }, 60_000);

  it("a single message: a press on its bar's own ground, inside its panel, reads nothing", async () => {
    bodies(["s1"]);
    await mountThread([msg("s1", 0, { threadId: "S" })]);
    await key("j");
    const bar = panel("s1")?.querySelector(".msg-actions");
    expect(bar, "the single message's bar sits inside its panel").toBeTruthy();
    await press(bar, "the single message's bar");
    await dwell();
    expect(glances(), "a press on the bar's ground read the previewed message").toEqual([]);
  }, 60_000);

  it("a press on a message's text enters: what is on screen reads after the dwell", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await press(panel("p4")?.querySelector(".pm-body, .msg-body"), "p4's text");
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

  it("a touch drag that starts on the bar and scrolls the column enters", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const later = col().querySelector(".abar .abar-later");
    await press(later, "the bar's Later", "touchstart");
    await press(later, "the bar's Later", "touchmove");
    await act(async () => {
      const sc = layout.scroller();
      sc.scrollTop = layout.topOf("p4") - 14;
      sc.dispatchEvent(new Event("scroll"));
    });
    await settle();
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
    await click(panel("p4")?.querySelector(".msg-more"), "p4's ⋯");
    const item = panel("p4")?.querySelector<HTMLElement>('.msg-menu [role="menuitem"][data-item="mark_unread"]');
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
    expect(theRow(host)?.querySelector(".row-marks"), "no squares for one message").toBeNull();
    await key("j");
    await key("Enter");
    expect(document.querySelector(".thread-marks"), "no column").toBeNull();
    expect(glances(), "the dwell is under way").toEqual([]);
    await dwell();
    expect(glances(), "its end is under the bar, its top was read").toEqual([["s1"]]);
  }, 30_000);

  it("opens at its own top, never at the offset the conversation before it left (by click and by j)", async () => {
    bodies(["p1", "p2", "p3", "p4", "s1"]);
    layout.heights.s1 = 2000;
    const host = await mountThread([...four(), msg("s1", 1, { threadId: "S" })]);
    await click(rowOf(host, "p4"), "the conversation's row");
    expect(layout.scroller().scrollTop, "the conversation opens at its newest, far down").toBeGreaterThan(500);
    await click(rowOf(host, "s1"), "the single letter's row");
    expect(panel("s1"), "the single letter is open").not.toBeNull();
    expect(layout.scroller().scrollTop, "the letter starts at its sender line").toBe(0);
    await click(rowOf(host, "p4"), "the conversation again");
    expect(layout.scroller().scrollTop).toBeGreaterThan(500);
    await key("j");
    expect(panel("s1"), "j previews the letter").not.toBeNull();
    expect(layout.scroller().scrollTop, "a preview lands at its top too").toBe(0);
  }, 30_000);
});

describe("no subject header, and no words in the column", () => {
  it("the conversation has per-message subjects only; the squares carry no text", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    const conv = col().querySelector(".conv")!;
    expect(conv.querySelectorAll("h1, h2, h3").length, "no heading element").toBe(0);
    expect(conv.querySelectorAll('[role="heading"]').length, "one subject line per message").toBe(4);
    expect(document.querySelector(".thread-marks")?.textContent).toBe("");
  }, 30_000);
});

describe("the column of squares stands beside the scroller, never in it", () => {
  /* Owner report, desktop: the squares flickered and jumped while the conversation scrolled.
     WebKitGTK moves a sticky box inside a scroller apart from the scroll itself, so for a frame
     the column rode with the panels and snapped back. Outside the scroller nothing moves it. */
  const bar = (): HTMLElement => document.querySelector<HTMLElement>(".tm-bar")!;
  const ring = (): string | undefined => document.querySelector<HTMLElement>('.tm-mb[aria-current="location"]')?.dataset.for;

  it("is not inside the reading column; a scroll there moves the panels and the ring, never the squares", async () => {
    bodies(["p1", "p2", "p3", "p4"]);
    await mountThread(four());
    await key("j");
    await key("Enter");
    expect(bar(), "the column of squares").not.toBeNull();
    expect(col().contains(bar()), "the squares scroll with the panels").toBe(false);
    expect(bar().closest(".thread-marks")?.parentElement, "beside the column, in its view").toBe(col().parentElement);
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
    for (const away of ["history", "settings", "screener"]) {
      await goTo(away);
      await goTo("ohbox");
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
    const sheet = document.querySelector<HTMLElement>(".reader");
    expect(sheet, "the reading sheet").not.toBeNull();
    const marks = sheet!.querySelector<HTMLElement>(".conv > .thread-marks");
    expect(marks, "the column, in the sheet's conversation").not.toBeNull();
    expect(marks!.querySelectorAll(".tm-sq")).toHaveLength(4);
    expect(document.querySelectorAll(".app-root > .thread-marks"), "nothing beside the sheet").toHaveLength(0);
  }, 30_000);
});

describe("the list's squares", () => {
  it("one square per message under the row, and ⤷ N steps back when they are as many", async () => {
    const host = await mountThread([msg("p1", 0), msg("p2", 10, { unread: false }), msg("p3", 20)]);
    const row = theRow(host)!;
    expect([...row.querySelectorAll(".rm-sq")].map((s) => s.className)).toEqual(["rm-sq unread", "rm-sq read", "rm-sq unread"]);
    expect(row.querySelector(".bdg-thread"), "the squares say the length").toBeNull();
    expect(row.getAttribute("aria-description")).toContain("3 messages, oldest first: 2 unread");
  }, 30_000);

  it("a server count past the messages in hand keeps ⤷ 9 beside four squares", async () => {
    const host = await mountThread([msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30)], { threadIds: { T: 9 } });
    const row = theRow(host)!;
    expect(row.querySelectorAll(".rm-sq").length).toBe(4);
    expect(row.querySelector(".bdg-thread")?.textContent).toBe("⤷ 9");
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

/**
 * A CONVERSATION ALWAYS OPENS ON ITS NEWEST (the c3 design): the reopen
 * case, p2 and p3 taller than the view. The first open reads p4; a reopen, by click or by ↵, lands
 * on p4 again and reads nothing it did not show (it landed on p3, the newest unread, and read it).
 * p3 reads only once its own top has been on screen, and that read is an open read (the row is held).
 */
describe("a conversation opens on its newest, every time", () => {
  const holding = (host: HTMLElement, id: string): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[role="listbox"] .row[data-ids~="${id}"]`) ?? rowOf(host, id);
  const focused = (): string | undefined =>
    col().querySelector<HTMLElement>('[data-conv-id][aria-current="true"]')?.dataset.convId;
  const a20 = async (): Promise<HTMLElement> => {
    layout.restore();
    layout = stubThreadLayout({ heights: { p2: 2400, p3: 2400 } });
    bodies(["p1", "p2", "p3", "p4", "s1"]);
    const host = await mountThread([...four(), msg("s1", 40, { threadId: "S" })]);
    await click(holding(host, "p4"), "the conversation's row");
    await dwell();
    expect(focused(), "the first open").toBe("p4");
    expect(glances()).toEqual([["p4"]]);
    await click(holding(host, "s1"), "another conversation");
    await dwell();
    expect(glances()).toEqual([["p4"], ["s1"]]);
    return host;
  };

  it("reopened by click: lands on p4, reads nothing; a second click stays; p3's top in view reads it as an open read", async () => {
    const host = await a20();
    expect(holding(host, "p4")?.dataset.id, "the row stands for its newest").toBe("p4");
    await click(holding(host, "p4"), "the conversation again");
    expect(focused(), "the reopen lands on the newest").toBe("p4");
    await dwell();
    expect(glances(), "the reopen reads nothing it did not show").toEqual([["p4"], ["s1"]]);
    await click(holding(host, "p4"), "a second click");
    expect(focused(), "a second click stays on the newest").toBe("p4");
    await dwell();
    expect(glances()).toEqual([["p4"], ["s1"]]);
    await layout.handScroll(layout.topOf("p3") - 10);
    await settle();
    await dwell();
    expect(glances().at(-1)).toEqual(["p3"]);
    const last = patches.filter((p) => p.via === "glance").at(-1) as { openRead?: boolean };
    expect(last.openRead, "the conversation is held: the read is an open read").toBe(true);
  }, 60_000);

  it("reopened by ↵: lands on p4 and reads nothing", async () => {
    const host = await a20();
    const rows = [...host.querySelectorAll<HTMLElement>('[role="listbox"] .row')];
    const step = rows.indexOf(holding(host, "p4")!) > rows.indexOf(holding(host, "s1")!) ? "j" : "k";
    await key("Escape");
    await key(step);
    await key("Enter");
    expect(focused(), "the reopen lands on the newest").toBe("p4");
    await dwell();
    expect(glances(), "the reopen reads nothing it did not show").toEqual([["p4"], ["s1"]]);
  }, 60_000);

  it("the lead circle names the unread letter's sender while the row opens on a newer read one", async () => {
    // One consented address under two names, so the circles differ by initial.
    bodies(["l1", "l2"]);
    const host = await mountThread([msg("l1", 0), msg("l2", 10, { from: { name: "Bob", address: "lena@example.invalid" }, unread: false })]);
    const row = holding(host, "l1")!;
    expect(row.dataset.id, "the row opens on its newest letter").toBe("l2");
    expect(row.querySelector(".av")?.textContent, "the lead circle is the unread sender's").toBe("L");
  }, 30_000);
});
