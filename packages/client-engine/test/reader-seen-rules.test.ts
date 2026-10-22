import { describe, expect, it } from "vitest";
import {
  EVIDENCE_WINDOW_MS,
  THREAD_READ_FADE_MS,
  THREAD_READ_HOLD_MS,
  THREAD_TOP_LINES,
  THREAD_UNREAD_BACK_MS,
  createThreadRead,
  type ThreadPanel,
} from "../src/index.js";

/**
 * THE THREAD-READ RULE the web, the desktop and the phone share (owner ruling 2026-10-23: "having
 * seen the top part of a message should be sufficient to mark it read"). An unread message in a
 * conversation the person entered turns read once its TOP — its sender line and the first lines of
 * its body — has been wholly in view, without a break, for the dwell (0.7 s). Its last line is not
 * needed; a pass shorter than the dwell, a preview, a look nobody can see and a moving layout read
 * nothing. Each deciding line is mutated once and a case below turns red: the entered gate, the dwell's
 * length, the break that starts it over, the keep, the ready check, the height restart and the view
 * nobody sees.
 */

const HOLD = THREAD_READ_HOLD_MS;
const view = { top: 0, bottom: 800 };
/** A panel at `top`: its sender line its first 40px, its first lines the 72px from 60px down. */
const panel = (id: string, top: number, height: number, over: Partial<ThreadPanel> = {}): ThreadPanel => ({
  id, ready: true, height,
  first: { top, bottom: top + 40 },
  lead: { top: top + 60, bottom: top + 132 },
  ...over,
});
const unread = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe("the constants", () => {
  it("are the ruling's, the dwell the 0.7 s hold", () => {
    expect([THREAD_READ_HOLD_MS, THREAD_READ_FADE_MS, THREAD_UNREAD_BACK_MS, EVIDENCE_WINDOW_MS, THREAD_TOP_LINES])
      .toEqual([700, 850, 320, 1000, 3]);
  });
});

describe("a message turns read once its top has been in view for the dwell", () => {
  it("its top in view for 0.7 s reads it, not a moment before (the control)", () => {
    const r = createThreadRead();
    r.enter(5);
    expect(r.entered).toBe(true);
    expect(r.enteredAt).toBe(5);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 10), "the dwell starts").toEqual([]);
    expect(r.due, "the adapter looks again when the dwell is done").toBe(10 + HOLD);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 10 + HOLD - 1)).toEqual([]);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 10 + HOLD)).toEqual(["a"]);
    expect(r.due, "nothing under way").toBeNull();
  });

  it("its last line is not needed: a long message whose top was in view reads", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 9000)], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 9000)], view, unread("a"), HOLD), "its end is 8000px below").toEqual(["a"]);
  });

  it("a pass shorter than the dwell reads nothing, and a break starts the dwell over", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", -500, 300)], view, unread("a"), 300), "scrolled past").toEqual([]);
    expect(r.due).toBeNull();
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 400), "back in view").toEqual([]);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 1000), "700 since the first sighting, not since this one").toEqual([]);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 400 + HOLD)).toEqual(["a"]);
  });

  it("a fast scroll through the conversation reads nothing it passes", () => {
    const r = createThreadRead();
    r.enter(0);
    const panels = (y: number) => [panel("a", y, 300), panel("b", y + 340, 300), panel("c", y + 680, 300)];
    const out: string[] = [];
    for (let t = 0, y = 900; y > -1200; t += 16, y -= 60) out.push(...r.observe(panels(y), view, unread("a", "b", "c"), t));
    expect(out).toEqual([]);
  });

  it("the sender line alone does not count: its first lines under the view's bottom (the bar's top)", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 700, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", 700, 300)], view, unread("a"), 2 * HOLD), "lines end at 832").toEqual([]);
    r.observe([panel("a", 668, 300)], view, unread("a"), 3 * HOLD);
    expect(r.observe([panel("a", 668, 300)], view, unread("a"), 4 * HOLD), "at 800 they are in").toEqual(["a"]);
  });

  it("the first lines alone do not count: a sender line cut by 1px at the top", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", -1, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", -1, 300)], view, unread("a"), 2 * HOLD)).toEqual([]);
  });

  it("a read panel is never returned", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 300)], view, unread(), 0);
    expect(r.observe([panel("a", 100, 300)], view, unread(), HOLD)).toEqual([]);
  });

  it("each id is returned once, in panel order, each after its own dwell", () => {
    const r = createThreadRead();
    r.enter(0);
    const two = [panel("a", 0, 300), panel("b", 340, 300)];
    r.observe([panel("a", 0, 300), panel("b", 900, 300)], view, unread("a", "b"), 0);
    r.observe(two, view, unread("a", "b"), 200);
    expect(r.due, "the earliest dwell").toBe(HOLD);
    expect(r.observe(two, view, unread("a", "b"), HOLD)).toEqual(["a"]);
    expect(r.due).toBe(200 + HOLD);
    expect(r.observe(two, view, unread("a", "b"), 200 + HOLD)).toEqual(["b"]);
    expect(r.observe(two, view, unread("a", "b"), 3 * HOLD), "the write has not landed yet").toEqual([]);
  });

  it("a panel that leaves the reader drops its dwell", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 0, 300)], view, unread("a"), 0);
    r.observe([], view, unread(), 100);
    expect(r.due).toBeNull();
  });
});

describe("a preview reads nothing", () => {
  it("before enter() nothing counts however long; after it the dwell starts at the next look", () => {
    const r = createThreadRead();
    expect(r.entered).toBe(false);
    r.observe([panel("a", 100, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 10_000)).toEqual([]);
    expect(r.due, "no dwell runs in a preview").toBeNull();
    r.enter(10_000);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 10_000)).toEqual([]);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 10_000 + HOLD)).toEqual(["a"]);
  });

  it("a second enter() keeps the first moment", () => {
    const r = createThreadRead();
    r.enter(10);
    r.enter(99);
    expect(r.enteredAt).toBe(10);
  });
});

describe("only a look the person can see counts", () => {
  it("a look with no view (the tab hidden, the window away) starts every dwell over", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 300)], null, unread("a"), 500)).toEqual([]);
    expect(r.due).toBeNull();
    r.observe([panel("a", 100, 300)], view, unread("a"), 600);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 1200)).toEqual([]);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 600 + HOLD)).toEqual(["a"]);
  });
});

describe("keepUnread", () => {
  it("a kept id is never read, however long it is shown", () => {
    const r = createThreadRead();
    r.enter(0);
    r.keepUnread("a");
    r.observe([panel("a", 100, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 5 * HOLD)).toEqual([]);
  });

  it("release() lets the rule see it again, with a dwell of its own", () => {
    const r = createThreadRead();
    r.enter(0);
    r.keepUnread("a");
    r.observe([panel("a", 100, 300)], view, unread("a"), 0);
    r.release("a");
    r.observe([panel("a", 100, 300)], view, unread("a"), 1000);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 1000 + HOLD)).toEqual(["a"]);
  });

  it("a read-to-unread turn the record sees keeps it (a refused write, another device): no loop", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), HOLD)).toEqual(["a"]);
    r.observe([panel("a", 100, 300)], view, unread(), HOLD + 10);
    r.observe([panel("a", 100, 300)], view, unread("a"), HOLD + 20);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 5 * HOLD), "turned back unread").toEqual([]);
  });

  it("a message read before and made unread elsewhere stays unread for the visit", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("b", 100, 300)], view, unread(), 0);
    r.observe([panel("b", 100, 300)], view, unread("b"), 10);
    expect(r.observe([panel("b", 100, 300)], view, unread("b"), 10 + 2 * HOLD)).toEqual([]);
  });
});

describe("what is not counted", () => {
  it("a panel that is not ready; once ready its dwell starts then", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 300, { ready: false })], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 300, { ready: false })], view, unread("a"), 2 * HOLD)).toEqual([]);
    r.observe([panel("a", 100, 300)], view, unread("a"), 2 * HOLD);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 3 * HOLD - 1), "the dwell counts from the ready look").toEqual([]);
    expect(r.observe([panel("a", 100, 300)], view, unread("a"), 3 * HOLD)).toEqual(["a"]);
  });

  it("a panel with no sender line or no first lines laid out", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 300, { first: null })], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 300, { first: null })], view, unread("a"), HOLD)).toEqual([]);
    const s = createThreadRead();
    s.enter(0);
    s.observe([panel("a", 100, 300, { lead: null })], view, unread("a"), 0);
    expect(s.observe([panel("a", 100, 300, { lead: null })], view, unread("a"), HOLD)).toEqual([]);
  });

  it("a change of the panel's height by more than 1px starts its dwell over (the layout moved)", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 120)], view, unread("a"), 0); // a snippet's first layout
    expect(r.observe([panel("a", 100, 900)], view, unread("a"), HOLD), "the body landed: not this top").toEqual([]);
    expect(r.observe([panel("a", 100, 900)], view, unread("a"), 2 * HOLD - 1)).toEqual([]);
    expect(r.observe([panel("a", 100, 900)], view, unread("a"), 2 * HOLD)).toEqual(["a"]);
  });

  it("a height change of 1px keeps the dwell", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 100, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", 100, 301)], view, unread("a"), HOLD)).toEqual(["a"]);
  });
});

describe("a message that arrives into the open visit", () => {
  it("turns read like any message: once its top has been in view for the dwell, no input needed", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 0, 300)], view, unread("a"), 0);
    expect(r.observe([panel("a", 0, 300)], view, unread("a"), HOLD)).toEqual(["a"]);
    // A reply lands wholly in view, nobody touches anything.
    r.observe([panel("a", 0, 300), panel("b", 340, 300)], view, unread("b"), 5000);
    expect(r.observe([panel("a", 0, 300), panel("b", 340, 300)], view, unread("b"), 5000 + HOLD - 1)).toEqual([]);
    expect(r.observe([panel("a", 0, 300), panel("b", 340, 300)], view, unread("b"), 5000 + HOLD)).toEqual(["b"]);
  });

  it("one that arrives off screen stays unread", () => {
    const r = createThreadRead();
    r.enter(0);
    r.observe([panel("a", 0, 300), panel("b", 900, 300)], view, unread("b"), 0);
    expect(r.observe([panel("a", 0, 300), panel("b", 900, 300)], view, unread("b"), 10 * HOLD)).toEqual([]);
  });
});
