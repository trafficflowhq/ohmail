/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, answerStoreWith, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
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
  [...col().querySelectorAll<HTMLElement>(".thread-marks .tm-sq")].map((s) => [...s.classList].find((c) => c !== "tm-sq")!);
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
    expect(col().querySelector(".thread-marks"), "no column").toBeNull();
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
    expect(conv.querySelector(".thread-marks")?.textContent).toBe("");
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
