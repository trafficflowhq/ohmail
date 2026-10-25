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
  const ring = (): string | undefined =>
    document.querySelector<HTMLElement>('.thread-marks .tm-mb[aria-current="location"]')?.dataset.for;
  const railButton = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.thread-marks .tm-mb[data-for="${id}"]`);
  const strip = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>('[role="listbox"] .row-follow .tm-strip');
  const stripRing = (host: HTMLElement): string | undefined =>
    strip(host)?.querySelector<HTMLElement>('.tm-mb[aria-current="location"]')?.dataset.for;
  const stripButton = (host: HTMLElement, id: string): HTMLElement | null =>
    strip(host)?.querySelector<HTMLElement>(`.tm-mb[data-for="${id}"]`) ?? null;
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

  it("a scroll that zoomed text stops a fraction short of the end still rings the one-line last, in the row too", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    for (const y of [619.6, 619.33, 619.1]) {
      await layout.handScroll(0);
      await settle();
      await layout.handScroll(y);
      await settle();
      expect(ring(), `at ${y}`).toBe("p4");
      expect(stripRing(host), `the row at ${y}`).toBe("p4");
    }
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

  it("the open row carries the conversation's squares, ringed as the rail at every step", async () => {
    const host = await shortLast();
    const row = theRow(host);
    await key("j");
    await key("Enter");
    expect(strip(host), "the strip in the open row").not.toBeNull();
    expect(theRow(host), "the row's button was remounted (its focus lost) when the strip came").toBe(row);
    expect([...strip(host)!.querySelectorAll<HTMLElement>(".tm-mb")].map((b) => b.dataset.for)).toEqual(ORDER);
    expect(strip(host)!.closest("button"), "never inside the row's button").toBeNull();
    for (const y of [620, 0, 150, 300, 450, 620]) {
      await layout.handScroll(y);
      await settle();
      expect(stripRing(host), `at ${y}`).toBe(ring());
    }
  }, 30_000);

  it("a press on the strip scrolls the reader as the rail's press does", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await click(stripButton(host, "p2"), "p2 in the strip");
    expect(layout.scroller().scrollTop).toBe(P2_LANDS);
    expect(ring()).toBe("p2");
    expect(stripRing(host)).toBe("p2");
  }, 30_000);

  it("closed, the row keeps its ring where the person stopped; a press there opens and lands on it, nothing read", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await layout.handScroll(300);
    await settle();
    const stopped = ring();
    expect(stopped).toBeDefined();
    await click(document.querySelector(".read-col-close"), "the column's close");
    expect(document.querySelector(".thread-marks"), "the reader closed").toBeNull();
    expect(stripRing(host), "the row remembers the place").toBe(stopped);
    const before = glances().length;
    await click(stripButton(host, "p2"), "p2 in the strip, nothing open");
    expect(panel("p2"), "the conversation opened").not.toBeNull();
    expect(layout.scroller().scrollTop, "landed on p2, not the newest").toBe(P2_LANDS);
    expect(ring()).toBe("p2");
    expect(glances().length, "nothing read by the landing").toBe(before);
  }, 30_000);

  /** The kinds of the strip's squares, and the row's own squares in words (the strip draws them). */
  const stripKinds = (host: HTMLElement): string[] =>
    [...(strip(host)?.querySelectorAll<HTMLElement>(".tm-sq") ?? [])].map((s) => [...s.classList].find((c) => c !== "tm-sq")!);
  const rowSays = (host: HTMLElement): string =>
    strip(host)?.closest(".row-slot")?.querySelector(".row")?.getAttribute("aria-description") ?? "";

  it("closed, a reply that arrives gets its square in the strip, as in the row's own marks", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await dwell();
    await click(document.querySelector(".read-col-close"), "the column's close");
    expect(document.querySelector(".thread-marks"), "the reader closed").toBeNull();
    arriveLater([msg("p5", 40)], ["p1", "p2", "p3", "p4", "p5"]);
    await tick(20_000);
    await settle();
    expect(stripKinds(host).length, "the reply never arrived: the case is not exercised").toBe(5);
    expect(stripKinds(host)[4]).toBe("unread");
    const unread = stripKinds(host).filter((k) => k === "unread").length;
    expect(rowSays(host), "the strip draws the conversation as the row has it").toContain(`5 messages, oldest first: ${unread} unread`);
    expect(strip(host)?.querySelector('.tm-mb[data-for="p5"]'), "the reply's square").not.toBeNull();
  }, 60_000);

  it("closed, Mark unread on the conversation turns its squares in the strip, as in the row's own marks", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await dwell();
    await click(readSlot(col()), "Mark read");
    await key("x"); // picked, so u reaches the conversation with the column closed
    await click(document.querySelector(".read-col-close"), "the column's close");
    expect(document.querySelector(".thread-marks"), "the reader closed").toBeNull();
    expect(stripKinds(host)).toEqual(["read", "read", "read", "read"]);
    await key("u");
    const unread = stripKinds(host).filter((k) => k === "unread").length;
    expect(unread, "u never reached the strip").toBeGreaterThan(0);
    expect(rowSays(host), "the strip draws the conversation as the row has it").toContain(`4 messages, oldest first: ${unread} unread`);
  }, 30_000);

  /** The one chip on screen, or null. */
  const chip = (): HTMLElement | null => document.querySelector<HTMLElement>(".tm-tip");
  const point = async (el: Element | null, type: "pointerover" | "pointerout", related: Element | null = null): Promise<void> => {
    expect(el, `nothing to point at (${type})`).toBeTruthy();
    await act(async () => { el!.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: related })); });
  };

  it("a square names its message in the chip, on hover and on keyboard focus, in the rail and in the strip; no square has a title", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    expect(chip(), "no chip before anything is pointed at").toBeNull();
    await point(railButton("p2"), "pointerover");
    expect(chip()?.textContent, "the rail square's sender, its friendly date, its first line").toMatch(/^Lenayesterday \d\d:10the words of p2$/);
    await point(railButton("p2"), "pointerout");
    expect(chip(), "gone with the pointer").toBeNull();
    await act(async () => { railButton("p3")!.focus(); });
    expect(chip()?.textContent, "keyboard focus names the square too").toMatch(/^Lenayesterday \d\d:20/);
    await act(async () => { railButton("p3")!.blur(); });
    expect(chip()).toBeNull();
    await point(stripButton(host, "p1"), "pointerover");
    expect(chip()?.textContent, "the strip's square").toMatch(/^Lenayesterday \d\d:00/);
    expect(chip()?.getAttribute("data-place"), "under the strip").toBe("under");
    await point(stripButton(host, "p1"), "pointerout");
    await act(async () => { stripButton(host, "p4")!.focus(); });
    expect(chip()?.textContent).toMatch(/^Lenayesterday \d\d:30/);
    expect(chip()?.getAttribute("aria-hidden"), "the square's own label is its name").toBe("true");
    expect(document.querySelectorAll(".tm-mb[title]").length, "a native tooltip would name it twice").toBe(0);
  }, 30_000);

  /** A finger on `el`: down, then up after `ms`. */
  const touch = async (el: Element | null, type: "pointerdown" | "pointerup"): Promise<void> => {
    expect(el, `nothing to touch (${type})`).toBeTruthy();
    const e = new MouseEvent(type, { bubbles: true });
    Object.defineProperty(e, "pointerType", { value: "touch" });
    await act(async () => { el!.dispatchEvent(e); });
  };

  it("a finger held on a square shows its chip and never presses it; a tap still presses; the chip goes after the finger", async () => {
    const host = await shortLast();
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
    expect(chip()?.textContent, "the hold names the square").toMatch(/^Lenayesterday \d\d:10/);
    await touch(railButton("p2"), "pointerup");
    await click(railButton("p2"), "the click that ends the hold");
    expect(layout.scroller().scrollTop, "the hold pressed the square").toBe(at);
    expect(ring()).toBe(was);
    expect(chip(), "the chip stays a moment after the finger").not.toBeNull();
    await tick(1200);
    expect(chip(), "then goes").toBeNull();
    await touch(stripButton(host, "p2"), "pointerdown");
    await touch(stripButton(host, "p2"), "pointerup");
    await click(stripButton(host, "p2"), "a tap on p2 in the strip");
    expect(chip(), "a tap shows no chip").toBeNull();
    expect(layout.scroller().scrollTop, "a tap presses").toBe(P2_LANDS);
  }, 30_000);

  it("in the reader sheet, a tap on another square while a hold's chip stays drops that chip and presses", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    await shortLast();
    await key("j");
    await key("Enter");
    const sq = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`.reader .thread-marks .tm-mb[data-for="${id}"]`);
    await touch(sq("p1"), "pointerdown");
    await tick(400);
    expect(chip()?.textContent, "the hold names p1").toMatch(/^Lenayesterday \d\d:00/);
    await touch(sq("p1"), "pointerup");
    await click(sq("p1"), "the click that ends the hold");
    await tick(300);
    await touch(sq("p3"), "pointerdown");
    await touch(sq("p3"), "pointerup");
    await click(sq("p3"), "a tap on p3 within the chip's stay");
    expect(chip(), "the held square's chip went with the new press").toBeNull();
    expect(document.querySelector<HTMLElement>('.reader .tm-mb[aria-current="location"]')?.dataset.for, "the tap pressed p3").toBe("p3");
    await tick(2000);
    expect(chip()).toBeNull();
  }, 30_000);

  it("the chip names your own message 'you' and shows a clip for a message with a file", async () => {
    bodies(["p1", "o1", "p3"]);
    await mountThread([
      msg("p1", 0, { hasAttachments: true, attachmentCount: 1 }),
      msg("o1", 15, { unread: false, folder: "Sent", from: { name: "Walker", address: ME } }), msg("p3", 20),
    ]);
    await key("j");
    await key("Enter");
    await point(railButton("o1"), "pointerover");
    expect(chip()?.querySelector(".tm-tip-head b")?.textContent, "your own message").toBe("you");
    expect(chip()?.querySelector(".tm-tip-head svg"), "no file, no clip").toBeNull();
    await point(railButton("o1"), "pointerout");
    await point(railButton("p1"), "pointerover");
    expect(chip()?.querySelector(".tm-tip-head svg"), "the clip").not.toBeNull();
  }, 30_000);

  it("selecting another conversation takes the strip off the row", async () => {
    const host = await shortLast([msg("s1", 40, { threadId: "S" })]);
    await click(rowOf(host, "p4") ?? host.querySelector<HTMLElement>('[role="listbox"] .row[data-ids~="p4"]'), "the conversation's row");
    expect(strip(host)).not.toBeNull();
    await click(rowOf(host, "s1"), "another conversation");
    expect(strip(host), "the strip left with the conversation").toBeNull();
  }, 30_000);

  /** Every list row's strips of squares, as drawn: its own 8px line and the walking strip. */
  const stripsPerRow = (host: HTMLElement): Record<string, string[]> => Object.fromEntries(
    [...host.querySelectorAll<HTMLElement>('[role="listbox"] .row')].map((row) => {
      const unit = row.closest(".row-slot") ?? row;
      const drawn = [...unit.querySelectorAll(".row-marks, .tm-strip")].map((el) => (el.matches(".tm-strip") ? "strip" : "own"));
      return [(row.dataset.ids ?? row.dataset.id ?? "").split(" ").sort().join(" "), drawn];
    }),
  );
  const T = "p1 p2 p3 p4";
  const S = "s1 s2";
  it("one strip per row in every state: closed, opened, walked, closed again, another chosen, a reply, Mark unread", async () => {
    const host = await shortLast([msg("s1", 40, { threadId: "S" }), msg("s2", 41, { threadId: "S" })]);
    const expectRows = (state: string, rows: Record<string, string[]>): void =>
      expect(stripsPerRow(host), state).toEqual(rows);
    expectRows("nothing open", { [T]: ["own"], [S]: ["own"] });
    await click(rowOf(host, "p4") ?? host.querySelector<HTMLElement>('[role="listbox"] .row[data-ids~="p4"]'), "T's row");
    expectRows("T open", { [T]: ["strip"], [S]: ["own"] });
    await dwell();
    expectRows("T read", { [T]: ["strip"], [S]: ["own"] });
    for (const y of [0, 300, 620]) {
      await layout.handScroll(y);
      await settle();
      expectRows(`T walked to ${y}`, { [T]: ["strip"], [S]: ["own"] });
    }
    await click(document.querySelector(".read-col-close"), "the column's close");
    expectRows("T closed, its place kept", { [T]: ["strip"], [S]: ["own"] });
    arriveLater([msg("p5", 50)], ["p1", "p2", "p3", "p4", "p5"]);
    await tick(20_000);
    await settle();
    const withReply = `${T} p5`;
    expect(Object.keys(stripsPerRow(host)), "the reply never arrived: the case is not exercised").toContain(withReply);
    expectRows("a reply into closed T", { [withReply]: ["strip"], [S]: ["own"] });
    await click(host.querySelector<HTMLElement>('[role="listbox"] .row[data-ids~="s2"]') ?? rowOf(host, "s2"), "S's row");
    expectRows("S chosen", { [withReply]: ["own"], [S]: ["strip"] });
    await key("x");
    await key("u");
    expectRows("S picked and marked unread", { [withReply]: ["own"], [S]: ["strip"] });
  }, 60_000);

  it("an own reply in the strip opens its conversation on it, never a removed-elsewhere notice", async () => {
    bodies(["p1", "o1", "p3"]);
    const host = await mountThread([
      msg("p1", 0), msg("o1", 15, { unread: false, folder: "Sent", from: { name: "Walker", address: ME } }), msg("p3", 20),
    ]);
    await key("j");
    await key("Enter");
    expect(stripButton(host, "o1"), "the own reply has its square").not.toBeNull();
    await click(document.querySelector(".read-col-close"), "the column's close");
    await click(stripButton(host, "o1"), "the own reply's square");
    expect(document.querySelector(".msg-gone"), "a false 'removed elsewhere'").toBeNull();
    expect(panel("o1"), "the conversation is open").not.toBeNull();
    expect(ring()).toBe("o1");
  }, 30_000);
});

describe("at phone width, Back from a letter keeps the cursor on its row", () => {
  it("the row read wears the cursor, the focus and its strip after Back: a conversation, an unread letter, a read one", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    const host = await mountThread([
      msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30),
      msg("w1", 40, { threadId: "W" }), msg("u1", 50, { threadId: "U" }), msg("l1", 5, { threadId: "L", unread: false }),
    ]);
    const rowOn = (id: string): HTMLElement | null =>
      host.querySelector<HTMLElement>(`[role="listbox"] .row[data-id="${id}"], [role="listbox"] .row[data-ids~="${id}"]`);
    const order = (): string[] => [...host.querySelectorAll<HTMLElement>('[role="listbox"] .row')].map((r) => r.dataset.ids ?? r.dataset.id ?? "");
    expect(order()).toEqual(["u1", "w1", "p4 p3 p2 p1", "l1"]);
    const cursor = (): string[] => [...host.querySelectorAll<HTMLElement>('[role="listbox"] .row.sel')].map((r) => r.dataset.ids ?? r.dataset.id ?? "");
    for (const [id, row] of [["p4", "p4 p3 p2 p1"], ["w1", "w1"], ["u1", "u1"], ["l1", "l1"]] as const) {
      await click(rowOn(id), `${id}'s row`);
      expect(document.querySelector(".reader"), `${id} opens in the sheet`).not.toBeNull();
      await dwell();
      await click(document.querySelector(".reader-close"), "the sheet's Back");
      expect(cursor(), `after Back from ${id}`).toEqual([row]);
      expect(rowOn(id)?.getAttribute("aria-selected"), `${id} is the selected option`).toBe("true");
      expect(document.activeElement, `focus on ${id}'s row`).toBe(rowOn(id));
    }
    expect(order(), "w1 and u1 read and filed under Earlier, the last read first; T still has unread").toEqual(["p4 p3 p2 p1", "u1", "w1", "l1"]);
    expect(rowOn("p4")?.closest(".row-slot")?.querySelector(".tm-strip"), "the conversation's strip left with the cursor").toBeNull();
    await click(rowOn("p4"), "T's row again");
    await click(document.querySelector(".reader-close"), "Back");
    expect(rowOn("p4")?.closest(".row-slot")?.querySelector(".tm-strip"), "T keeps its walked strip after Back").not.toBeNull();
  }, 60_000);
});
