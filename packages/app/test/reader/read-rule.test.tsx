/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_DOM, scrollerOf } from "../../src/reader/read-dom.js";
import { freshRecord, letter, mountReader } from "./support/mail.js";

/**
 * THE READ RULE, UNCHANGED, IN THE NEW COLUMN: "A message turns read once its first lines have stayed on screen for
 * 0.7 s and its sender line has been fully on screen or the end of its text has been on screen, in either order.
 * Nothing that was never on screen turns read; Mark unread starts it over." The column is the kit's sheet; its parts
 * are found by the reader's names. jsdom lays nothing out: every box below is the layout a browser would give, the
 * scroller 800 tall and the action panel's foot from 700 down.
 */

type Box = { top: number; bottom: number };
const boxed = (el: Element | null, box: Box): void => {
  if (!el) throw new Error("no element to lay out");
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      ...box,
      left: 0,
      right: 600,
      width: 600,
      height: box.bottom - box.top,
      x: 0,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
};

interface Lay {
  sender: Box;
  body: Box;
  end: number;
}
function layOut(lays: Record<string, Lay>): void {
  const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!))!;
  boxed(scroller, { top: 0, bottom: 800 });
  Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
  boxed(document.querySelector(READER_DOM.stops), { top: 700, bottom: 760 });
  for (const [id, lay] of Object.entries(lays)) {
    const panel = document.querySelector(`[data-conv-id="${id}"]`)!;
    boxed(panel, { top: lay.sender.top, bottom: lay.end + 20 });
    boxed(panel.querySelector(READER_DOM.from), lay.sender);
    boxed(panel.querySelector(READER_DOM.body), lay.body);
    boxed(panel.querySelector("[data-own-end]"), { top: lay.end, bottom: lay.end });
  }
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}
const pass = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const reads = (mutations: readonly EngineMutation[]) =>
  mutations
    .filter((m): m is Extract<EngineMutation, { kind: "mark_seen" }> => m.kind === "mark_seen")
    .map((m) => ({ ids: m.messageIds, unread: m.unread }));

const thread = { threadId: "t1", subject: "Kiln schedule" };
const ON_SCREEN: Lay = { sender: { top: 10, bottom: 50 }, body: { top: 60, bottom: 400 }, end: 380 };

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  vi.setSystemTime(new Date("2026-11-15T09:00:00Z"));
  document.hasFocus = () => true;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the read rule in the reader", () => {
  it("a letter turns read once its first lines stayed 0.7 s with its sender line on screen, and not before", () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    layOut({ m1: ON_SCREEN });
    pass(500);
    expect(reads(mail.mutations)).toEqual([]);
    pass(400);
    expect(reads(mail.mutations)).toEqual([{ ids: ["m1"], unread: false }]);
    expect(mail.mutations.find((m) => m.kind === "mark_seen")).toMatchObject({
      via: "glance",
      readRow: "m1",
    });
  });

  it("a letter below the fold never turns read", () => {
    // Opened on the first: the conversation opens there, and the second stands below the fold.
    const { mail } = mountReader({
      letters: [letter("m1", thread), letter("m2", { ...thread, date: "2026-11-11T09:00:00.000Z" })],
      open: "m1",
    });
    layOut({
      m1: ON_SCREEN,
      m2: { sender: { top: 900, bottom: 940 }, body: { top: 950, bottom: 1300 }, end: 1280 },
    });
    pass(3000);
    expect(reads(mail.mutations)).toEqual([{ ids: ["m1"], unread: false }]);
  });

  it("an end under the action panel is not on screen; above it, it is", () => {
    const under: Lay = { sender: { top: -100, bottom: -60 }, body: { top: 600, bottom: 760 }, end: 720 };
    const first = mountReader({ letters: [letter("m1")], open: "m1" });
    layOut({ m1: under });
    pass(3000);
    expect(reads(first.mail.mutations)).toEqual([]);
    cleanup();
    const second = mountReader({ letters: [letter("m1")], open: "m1" });
    layOut({ m1: { ...under, body: { top: 600, bottom: 700 }, end: 690 } });
    pass(3000);
    expect(reads(second.mail.mutations)).toEqual([{ ids: ["m1"], unread: false }]);
  });

  it("Mark unread writes it unread and holds it for the visit: staying on screen does not read it again", () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    layOut({ m1: ON_SCREEN });
    pass(900);
    act(() => {
      mail.patch("m1", { unread: false });
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    act(() => {
      mail.patch("m1", { unread: true });
    });
    pass(5000);
    expect(reads(mail.mutations)).toEqual([
      { ids: ["m1"], unread: false },
      { ids: ["m1"], unread: true },
    ]);
  });

  it("a list's visit is the list's: the column reads through its record and writes nothing itself", () => {
    const onRead = vi.fn();
    const onEnter = vi.fn();
    const record = freshRecord();
    record.enter(Date.now());
    const { mail } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      meeting: {
        blank: null,
        visit: {
          openId: "m1",
          unread: true,
          readSet: ["m1"],
          act: vi.fn(),
          wiring: { look: "tint", record, onRead, onEnter, onMarkUnread: vi.fn() },
          step: {
            up: { disabled: true, run: vi.fn(), label: "up" },
            down: { disabled: true, run: vi.fn(), label: "down" },
          },
        },
      },
    });
    layOut({ m1: ON_SCREEN });
    pass(900);
    expect(onRead).toHaveBeenCalledWith(["m1"]);
    expect(onEnter).not.toHaveBeenCalled();
    expect(reads(mail.mutations)).toEqual([]);
    // The list's look: the sheet is washed, and a hidden word says it is unread.
    expect(screen.getByText("Unread")).toBeTruthy();
  });
});
