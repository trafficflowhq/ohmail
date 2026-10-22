/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_READ_HOLD_MS, createThreadRead } from "@ohmail/client-engine";
import { EVIDENCE_WINDOW_MS, TOP_LINE_FALLBACK_PX, createThreadReadDom, panelsOf, viewOf } from "../app/shell/reader-seen";
import { scrollProgrammatically } from "../app/shell/programmatic-scroll";

/**
 * THE THREAD-READ ADAPTER over the DOM (owner ruling 2026-10-23: the top of a message read is the
 * message read). The top comes from the marker elements (`.msg-from`, then the body block's first
 * three lines, or the body to its end where it is shorter; a frame's top), the view ends at the sticky
 * bar's top, a message turns read once its top has been in view for the 0.7 s dwell, one look writes
 * one batch, a hidden tab or a window nobody attends reads nothing, and only the person's own scroll
 * or press ENTERS a preview. jsdom has no layout: every rect comes from `at`; the scroller is 800px
 * tall; a line is the 24px fallback, so a body's first lines are its first 72px.
 */

const LEAD = 3 * TOP_LINE_FALLBACK_PX;
let at: Record<string, { top: number; bottom: number }> = {};
let scroller: HTMLDivElement;
let shown = true;
let focused = true;
let reads: string[][] = [];
let enters = 0;
let frames: Array<() => void> = [];
let core: ReturnType<typeof createThreadReadDom> | null = null;
let record = createThreadRead();
let top = 0;

const rect = (key: string) => () => {
  const r = at[key] ?? { top: 0, bottom: 0 };
  return { ...r, left: 0, right: 600, width: 600, height: r.bottom - r.top, x: 0, y: r.top, toJSON: () => ({}) } as DOMRect;
};
/** A panel whose sender line is [top, top+40], whose body starts 50px down and whose end marker sits at `end`. */
function panel(
  id: string, topY: number, end: number,
  opts: { unseen?: boolean; ready?: boolean; marker?: boolean; framed?: { top: number; bottom: number } } = {},
): HTMLElement {
  const el = document.createElement("article");
  el.dataset.convId = id;
  if (opts.unseen ?? true) el.setAttribute("data-unseen", "");
  if (opts.ready ?? true) el.setAttribute("data-body-ready", "");
  at[id] = { top: topY, bottom: end + 30 };
  at[`${id}:from`] = { top: topY, bottom: topY + 40 };
  el.getBoundingClientRect = rect(id);
  const from = document.createElement("div");
  from.className = "msg-from";
  from.getBoundingClientRect = rect(`${id}:from`);
  el.appendChild(from);
  const body = document.createElement("div");
  body.className = "pm-body";
  at[`${id}:body`] = { top: topY + 50, bottom: end + 10 };
  body.getBoundingClientRect = rect(`${id}:body`);
  if (opts.framed) {
    const frame = document.createElement("iframe");
    frame.className = "mb-frame";
    at[`${id}:frame`] = { ...opts.framed };
    frame.getBoundingClientRect = rect(`${id}:frame`);
    body.appendChild(frame);
  }
  if (opts.marker ?? true) {
    const mark = document.createElement("span");
    mark.setAttribute("data-own-end", "");
    at[`${id}:end`] = { top: end, bottom: end };
    mark.getBoundingClientRect = rect(`${id}:end`);
    body.appendChild(mark);
  }
  el.appendChild(body);
  scroller.appendChild(el);
  return el;
}
function bar(topY: number): void {
  const el = document.createElement("div");
  el.className = "msg-actions";
  at.bar = { top: topY, bottom: topY + 50 };
  el.getBoundingClientRect = rect("bar");
  scroller.appendChild(el);
}
function mount(): void {
  core = createThreadReadDom({
    scroller, record,
    onRead: (ids) => reads.push(ids),
    onEnter: () => { enters += 1; record.enter(Date.now()); },
    visible: () => shown, frameHovered: () => false, documentFocused: () => focused,
    now: () => Date.now(),
    frame: (run) => { frames.push(run); return () => { frames = frames.filter((f) => f !== run); }; },
  });
}
/** One frame. */
const flushOne = (): void => { const run = frames; frames = []; for (const f of run) f(); };
/** Frames until none is asked for: a look that found the layout moved asks for the next. */
const flush = (): void => { for (let i = 0; i < 10 && frames.length > 0; i++) flushOne(); };
/** Time passes by `ms`; the looks the dwell's timer asks for run. */
const pass = (ms: number): void => { vi.advanceTimersByTime(ms); flush(); };
/** The whole dwell passes. */
const dwell = (): void => pass(THREAD_READ_HOLD_MS + 1);
const scrollBy = (dy: number): void => {
  for (const [k, r] of Object.entries(at)) if (k !== "scroller" && k !== "bar") { r.top -= dy; r.bottom -= dy; }
  top += dy;
  scroller.dispatchEvent(new Event("scroll"));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T09:00:00Z"));
  at = { scroller: { top: 0, bottom: 800 } };
  shown = true; focused = true; reads = []; enters = 0; frames = []; top = 0;
  record = createThreadRead();
  scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientHeight", { get: () => 800 });
  Object.defineProperty(scroller, "clientWidth", { get: () => 600 });
  Object.defineProperty(scroller, "scrollHeight", { get: () => 5000 });
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => { top = v; } });
  scroller.getBoundingClientRect = rect("scroller");
  document.body.appendChild(scroller);
});
afterEach(() => {
  core?.dispose();
  core = null;
  scroller.remove();
  vi.useRealTimers();
});

describe("a message's top comes from the marker elements", () => {
  it("the sender line and the body's first three lines, the panel's readiness and height", () => {
    panel("a", 100, 400);
    expect(panelsOf(scroller)).toEqual([{
      id: "a", ready: true, height: 330, first: { top: 100, bottom: 140 }, lead: { top: 150, bottom: 150 + LEAD },
    }]);
  });
  it("a body shorter than three lines is its own top, to its end marker", () => {
    panel("a", 100, 180);
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 150, bottom: 180 });
  });
  it("without a marker the body block's foot ends a short body", () => {
    panel("a", 100, 160, { marker: false });
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 150, bottom: 170 });
  });
  it("a line is the body's own line height", () => {
    const el = panel("a", 100, 900);
    el.querySelector<HTMLElement>(".pm-body")!.style.lineHeight = "30px";
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 150, bottom: 240 });
  });
  it("a framed body's first lines are the top of its frame", () => {
    panel("a", 100, 3000, { framed: { top: 210, bottom: 2990 } });
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 210, bottom: 210 + LEAD });
  });
  it("the view ends at the sticky bar's top", () => {
    bar(700);
    expect(viewOf(scroller)).toEqual({ top: 0, bottom: 700 });
  });
});

describe("a message turns read once its top has been in view for the dwell", () => {
  it("an entered visit reads each top in view once the dwell is done, in one batch (the control)", () => {
    panel("a", 0, 300);
    panel("b", 340, 600);
    record.enter(0);
    mount();
    flush();
    expect(reads, "the dwell has only started").toEqual([]);
    pass(THREAD_READ_HOLD_MS - 50);
    expect(reads, "not a moment before it is done").toEqual([]);
    pass(51);
    expect(reads).toEqual([["a", "b"]]);
  });
  it("its last line is not needed: a long message whose end is screens below reads", () => {
    panel("a", 0, 6000);
    record.enter(0);
    mount();
    flush();
    dwell();
    expect(reads).toEqual([["a"]]);
  });
  it("first lines under the bar do not count, however long", () => {
    panel("a", 600, 2000); // its first lines run to 722
    bar(700);
    record.enter(0);
    mount();
    flush();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(reads).toEqual([]);
  });
  it("a fast scroll past reads nothing it passes", () => {
    panel("a", 900, 1300);
    panel("b", 1340, 1700);
    record.enter(0);
    mount();
    flush();
    for (let i = 0; i < 40; i++) { scrollBy(60); pass(16); }
    pass(5 * THREAD_READ_HOLD_MS);
    expect(reads).toEqual([]);
  });
  it("a preview reads nothing, however long its top is in view", () => {
    panel("a", 0, 300);
    mount();
    flush();
    pass(10_000);
    expect(reads).toEqual([]);
  });
  it("a panel not ready is not read; once it is, its dwell starts then", async () => {
    const el = panel("a", 0, 300, { ready: false });
    record.enter(0);
    mount();
    flush();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(reads).toEqual([]);
    el.setAttribute("data-body-ready", "");
    await Promise.resolve();
    flush();
    pass(THREAD_READ_HOLD_MS - 50);
    expect(reads).toEqual([]);
    dwell();
    expect(reads).toEqual([["a"]]);
  });
  it("frames coalesce: many scrolls before a frame are one look", () => {
    panel("a", 0, 300);
    record.enter(0);
    mount();
    for (let i = 0; i < 5; i++) scroller.dispatchEvent(new Event("scroll"));
    expect(frames.length).toBe(1);
  });
});

describe("only while the person can be reading", () => {
  it("nothing while the tab is hidden; back in view, the dwell starts over", () => {
    panel("a", 0, 300);
    record.enter(0);
    mount();
    flush();
    pass(THREAD_READ_HOLD_MS - 100);
    shown = false;
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(reads).toEqual([]);
    shown = true;
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    pass(THREAD_READ_HOLD_MS - 100);
    expect(reads, "the dwell counts from the tab's return").toEqual([]);
    dwell();
    expect(reads).toEqual([["a"]]);
  });
  it("nothing while the window is not focused; its focus starts the dwell", () => {
    panel("a", 0, 300);
    record.enter(0);
    focused = false;
    mount();
    flush();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(reads).toEqual([]);
    focused = true;
    window.dispatchEvent(new Event("focus"));
    flush();
    dwell();
    expect(reads).toEqual([["a"]]);
  });
  it("a window without focus that the person wheels reads what they wheel to", () => {
    panel("p4", 0, 300, { unseen: false });
    panel("p3", 1000, 1400);
    record.enter(0);
    focused = false;
    mount();
    flush();
    scroller.dispatchEvent(new Event("wheel", { bubbles: true }));
    scrollBy(1000);
    flush();
    dwell();
    expect(reads, "the wheel is the person, the window beside another app").toEqual([["p3"]]);
  });
  it("a reply that arrives into the open visit turns read once its top has been in view, no key needed", async () => {
    panel("a", 0, 300);
    record.enter(0);
    mount();
    flush();
    dwell();
    expect(reads).toEqual([["a"]]);
    panel("b", 340, 600);
    await Promise.resolve();
    flush();
    pass(THREAD_READ_HOLD_MS - 50);
    expect(reads).toEqual([["a"]]);
    dwell();
    expect(reads).toEqual([["a"], ["b"]]);
  });
});

describe("what enters a preview", () => {
  it("a wheel on the scroller enters, and the dwell then reads", () => {
    panel("a", 0, 300);
    mount();
    flush();
    scroller.dispatchEvent(new Event("wheel", { bubbles: true }));
    expect(enters).toBe(1);
    flush();
    dwell();
    expect(reads).toEqual([["a"]]);
  });
  it("a pointer press in the reader enters", () => {
    const el = panel("a", 0, 300);
    mount();
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(enters).toBe(1);
  });
  it("a scroll the app stamped does not enter", () => {
    panel("a", 1000, 1300);
    mount();
    scrollProgrammatically(scroller, 900);
    scrollBy(0);
    flush();
    dwell();
    expect(enters).toBe(0);
    expect(reads).toEqual([]);
  });
  it("a scroll after a key the app took (j) does not enter", () => {
    panel("a", 1000, 1300);
    mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    scrollBy(900);
    flush();
    dwell();
    expect(enters).toBe(0);
    expect(reads).toEqual([]);
  });
  it("a free scroll key, then the scroll, enters; past the window it does not", () => {
    panel("a", 1000, 1300);
    mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    vi.advanceTimersByTime(EVIDENCE_WINDOW_MS + 1);
    scrollBy(100);
    expect(enters).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    scrollBy(800);
    expect(enters).toBe(1);
    flush();
    dwell();
    expect(reads).toEqual([["a"]]);
  });
});

describe("a look counts only a layout that has settled", () => {
  const shift = (id: string, dy: number): void => {
    for (const k of [id, `${id}:from`, `${id}:body`, `${id}:end`]) { at[k]!.top += dy; at[k]!.bottom += dy; }
  };
  const grow = (id: string, dy: number): void => {
    at[id]!.bottom += dy; at[`${id}:body`]!.bottom += dy; at[`${id}:end`]!.top += dy; at[`${id}:end`]!.bottom += dy;
  };
  /** z's body lands and grows by 400px: at the old scroll, a (above the view) is pushed wholly into it. */
  async function land(): Promise<void> {
    const z = scroller.querySelector<HTMLElement>('[data-conv-id="z"]')!;
    grow("z", 400);
    shift("a", 400);
    shift("b", 400);
    z.setAttribute("data-body-ready", "");
    await Promise.resolve();
  }
  beforeEach(() => {
    panel("z", -300, -230, { ready: false });
    panel("a", -150, -40);
    panel("b", 0, 1400, { unseen: false }); // the opened panel the anchor holds
    record.enter(0);
    mount();
    flush();
  });
  it("a body landing above the anchored panel reads nothing the anchor kept off screen", async () => {
    await land();
    flushOne();
    expect(reads, "a frame nobody saw").toEqual([]);
    scrollBy(400); // the anchor puts b back at the top before paint
    flush();
    dwell();
    expect(reads).toEqual([]);
  });
  it("the control: with no correction a stays in view, and its dwell then reads it", async () => {
    await land();
    flushOne();
    expect(reads).toEqual([]);
    flush();
    dwell();
    expect(reads).toEqual([["a"]]);
  });
});

describe("a framed body is ready once its frame was measured", () => {
  it("a frame without its end marker is not ready, whatever its state says; with it, its top's dwell reads", async () => {
    const el = panel("a", 0, 300, { framed: { top: 60, bottom: 290 }, marker: false });
    record.enter(0);
    mount();
    expect(panelsOf(scroller)[0]!.ready).toBe(false);
    flush();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(reads).toEqual([]);
    const mark = document.createElement("span");
    mark.setAttribute("data-own-end", "");
    at["a:end"] = { top: 300, bottom: 300 };
    mark.getBoundingClientRect = rect("a:end");
    el.querySelector(".pm-body")!.appendChild(mark);
    await Promise.resolve();
    flush();
    dwell();
    expect(reads).toEqual([["a"]]);
  });
  it("a body standing in for its frame (the text before the mount) is not ready", () => {
    const el = panel("a", 0, 300);
    const pending = document.createElement("span");
    pending.setAttribute("data-body-pending", "");
    el.querySelector(".pm-body")!.appendChild(pending);
    expect(panelsOf(scroller)[0]!.ready).toBe(false);
    pending.remove();
    expect(panelsOf(scroller)[0]!.ready).toBe(true);
  });
});
