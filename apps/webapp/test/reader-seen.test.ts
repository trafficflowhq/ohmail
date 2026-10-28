/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_READ_HOLD_MS, createThreadRead } from "@ohmail/client-engine";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { EngineMessage } from "@ohmail/client-engine";
import {
  EVIDENCE_WINDOW_MS, LANDING_REST_MS, TOP_LINE_FALLBACK_PX, createThreadReadDom, panelsOf, pressEnters, useReaderVisit, viewOf,
} from "../app/shell/reader-seen";
import { scrollProgrammatically } from "../app/shell/programmatic-scroll";
import { readLandedCard } from "../app/shell/stream-landing-read";

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
let stays = 0;
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
function mount(restMs?: number): void {
  core = createThreadReadDom({
    scroller, record, restMs,
    onRead: (ids) => reads.push(ids),
    onEnter: () => { enters += 1; record.enter(Date.now()); },
    onStay: () => { stays += 1; },
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
  shown = true; focused = true; reads = []; enters = 0; stays = 0; frames = []; top = 0;
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
  it("the sender line, the body's first three lines and the end of its text, the panel's readiness and height", () => {
    panel("a", 100, 400);
    expect(panelsOf(scroller)).toEqual([{
      id: "a", ready: true, height: 330, first: { top: 100, bottom: 140 }, lead: { top: 150, bottom: 150 + LEAD },
      end: { top: 400, bottom: 400 },
    }]);
  });
  it("a body shorter than three lines is its own top, to its end marker", () => {
    panel("a", 100, 180);
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 150, bottom: 180 });
  });
  it("without a marker the body block's foot ends a short body, and its text", () => {
    panel("a", 100, 160, { marker: false });
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 150, bottom: 170 });
    expect(panelsOf(scroller)[0]!.end).toEqual({ top: 170, bottom: 170 });
  });
  it("a line is the body's own line height", () => {
    const el = panel("a", 100, 900);
    el.querySelector<HTMLElement>(".pm-body")!.style.lineHeight = "30px";
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 150, bottom: 240 });
  });
  it("a framed body's first lines are the top of its frame, the end of its text the frame's foot", () => {
    panel("a", 100, 3000, { framed: { top: 210, bottom: 2990 } });
    expect(panelsOf(scroller)[0]!.lead).toEqual({ top: 210, bottom: 210 + LEAD });
    expect(panelsOf(scroller)[0]!.end).toEqual({ top: 2990, bottom: 2990 });
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
  it("a press on the verb bar, a control in a panel or the reply dock does not enter; a touch there neither", () => {
    const el = panel("a", 0, 300);
    bar(700);
    const more = document.createElement("button");
    el.appendChild(more);
    mount();
    for (const target of [scroller.querySelector(".msg-actions")!, more]) {
      target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      target.dispatchEvent(new Event("touchstart", { bubbles: true }));
      target.dispatchEvent(new Event("touchmove", { bubbles: true }));
    }
    expect(enters).toBe(0);
    el.querySelector(".pm-body")!.dispatchEvent(new Event("touchstart", { bubbles: true }));
    expect(enters).toBe(1);
  });
  it("pressEnters: a message's own panel and the scroller's box, never a control, a gutter or what lies outside", () => {
    const el = panel("a", 0, 300);
    bar(700);
    const add = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: Element, attrs: Record<string, string> = {}): HTMLElement => {
      const x = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v);
      parent.appendChild(x);
      return x;
    };
    const dock = add("div", scroller, { class: "reply-dock" });
    const cases: Array<[string, EventTarget | null, boolean]> = [
      ["the scroller's own box", scroller, true],
      ["a panel", el, true],
      ["a panel's text", el.querySelector(".pm-body"), true],
      ["the verb bar", scroller.querySelector(".msg-actions"), false],
      ["a word in the verb bar", add("span", scroller.querySelector(".msg-actions")!), false],
      ["a panel's button", add("button", el), false],
      ["a panel's role=button", add("span", el, { role: "button" }), false],
      ["a menu item", add("div", add("div", el, { role: "menu" }), { role: "menuitem" }), false],
      ["a field", add("input", el), false],
      ["an editable", add("div", el, { contenteditable: "true" }), false],
      ["the reply dock", add("textarea", dock), false],
      ["a gutter between panels", add("div", scroller), false],
      ["outside the scroller", document.body, false],
      ["nothing", null, false],
    ];
    for (const [what, target, enters] of cases) expect(pressEnters(scroller, target), what).toBe(enters);
    // What stands around the scroller counts for nothing: a control or a panel above it neither swallows nor enters.
    const around = document.createElement("div");
    around.className = "msg-actions";
    around.setAttribute("data-conv-id", "outer");
    document.body.appendChild(around);
    around.appendChild(scroller);
    expect(pressEnters(scroller, el.querySelector(".pm-body")), "a panel under a control-like ancestor").toBe(true);
    expect(pressEnters(scroller, scroller.lastElementChild), "a gutter under a panel-like ancestor").toBe(false);
    around.remove();
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

describe("a stream card opened from a search hit (readLandedCard)", () => {
  let stopLanded: (() => void) | null = null;
  let landedReads: string[] = [];
  /** A stream card: its sender line at [top+16, top+36], its clip (the text) at [top+70, top+270]. */
  function card(topY: number, opts: { unseen?: boolean; pend?: boolean } = {}): HTMLElement {
    const el = document.createElement("article");
    el.className = opts.pend ? "scast pend" : "scast";
    el.dataset.sid = "n1";
    if (opts.unseen ?? true) el.setAttribute("data-unseen", "1");
    at.n1 = { top: topY, bottom: topY + 300 };
    el.getBoundingClientRect = rect("n1");
    for (const [cls, dy, h] of [["sc-line", 16, 20], ["sc-clip", 70, 200]] as const) {
      const part = document.createElement("div");
      part.className = cls;
      at[`n1:${cls}`] = { top: topY + dy, bottom: topY + dy + h };
      part.getBoundingClientRect = rect(`n1:${cls}`);
      el.appendChild(part);
    }
    scroller.appendChild(el);
    return el;
  }
  function land(): void {
    stopLanded = readLandedCard({
      scroller, id: "n1", onRead: (id) => landedReads.push(id),
      visible: () => shown, documentFocused: () => focused, now: () => Date.now(),
      frame: (run) => { frames.push(run); return () => { frames = frames.filter((f) => f !== run); }; },
    });
    flush();
  }
  beforeEach(() => { landedReads = []; });
  afterEach(() => { stopLanded?.(); stopLanded = null; });

  it("its head on screen for the dwell: read once", () => {
    card(100);
    land();
    pass(THREAD_READ_HOLD_MS - 50);
    expect(landedReads).toEqual([]);
    pass(51);
    expect(landedReads).toEqual(["n1"]);
    pass(5 * THREAD_READ_HOLD_MS);
    expect(landedReads).toEqual(["n1"]);
  });
  it("scrolled off before the dwell: nothing; back on screen, the dwell starts over", () => {
    card(100);
    land();
    pass(THREAD_READ_HOLD_MS - 300);
    scrollBy(900);
    flush();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(landedReads).toEqual([]);
    scrollBy(-900);
    flush();
    pass(THREAD_READ_HOLD_MS - 300);
    expect(landedReads, "the dwell counts from its return").toEqual([]);
    dwell();
    expect(landedReads).toEqual(["n1"]);
  });
  it("a window not focused, or a hidden tab, reads nothing", () => {
    card(100);
    focused = false;
    land();
    pass(5 * THREAD_READ_HOLD_MS);
    shown = false;
    focused = true;
    window.dispatchEvent(new Event("focus"));
    flush();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(landedReads).toEqual([]);
  });
  it("a card already read, or one whose body is still on its way, reads nothing", () => {
    card(100, { unseen: false });
    land();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(landedReads).toEqual([]);
    stopLanded?.();
    scroller.replaceChildren();
    card(100, { pend: true });
    land();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(landedReads).toEqual([]);
  });
  it("a card whose body comes after the landing, with no scroll: read once it is in and the dwell has passed", async () => {
    const el = card(100, { pend: true });
    land();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(landedReads).toEqual([]);
    el.classList.remove("pend");
    await Promise.resolve();
    flush();
    pass(THREAD_READ_HOLD_MS - 50);
    expect(landedReads, "the dwell counts from the body's arrival").toEqual([]);
    dwell();
    expect(landedReads).toEqual(["n1"]);
  });
  it("stopped before the dwell is done: nothing", () => {
    card(100);
    land();
    pass(THREAD_READ_HOLD_MS - 300);
    stopLanded?.();
    pass(5 * THREAD_READ_HOLD_MS);
    expect(landedReads).toEqual([]);
  });
});

describe("a reader's visit off the Ohbox (useReaderVisit)", () => {
  const act = (React as unknown as { act: (cb: () => void) => void }).act;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const letter = (id: string) => ({ id }) as EngineMessage;
  let visit: ReturnType<typeof useReaderVisit>;
  const writes: unknown[][] = [];
  const Probe = ({ shown }: { shown: EngineMessage | null }) => {
    visit = useReaderVisit({ shown, markSeen: (...a: unknown[]) => { writes.push(a); } });
    return null;
  };
  let root: ReturnType<typeof createRoot>;
  const show = (shown: EngineMessage | null): void => { root.render(React.createElement(Probe, { shown })); };
  beforeEach(() => {
    writes.length = 0;
    root = createRoot(document.createElement("div"));
    act(() => show(null));
  });
  afterEach(() => { act(() => root.unmount()); });

  it("an open entered in the same pass that shows the letter takes effect; it starts unentered and is the dot look", () => {
    expect(visit.wiring).toBeNull();
    act(() => { visit.enter("a"); show(letter("a")); });
    expect(visit.wiring?.record.entered).toBe(true);
    expect(visit.wiring?.look).toBe("dot");
    act(() => show(letter("b")));
    expect(visit.wiring?.record.entered, "a preview").toBe(false);
  });

  it("another letter shown ends the visit: coming back starts over, and an enter for a letter not shown is dropped", () => {
    act(() => show(letter("a")));
    act(() => visit.wiring!.onEnter());
    expect(visit.wiring?.record.entered).toBe(true);
    act(() => show(letter("b")));
    act(() => show(letter("a")));
    expect(visit.wiring?.record.entered, "back on a: a new visit").toBe(false);
    act(() => visit.enter("c"));
    act(() => show(letter("c")));
    expect(visit.wiring?.record.entered, "c was not shown when it was entered").toBe(false);
  });

  it("reads go out as glances naming the shown letter as the row read; Mark unread is kept for the visit", () => {
    act(() => show(letter("a")));
    visit.wiring!.onRead(["a", "a0"]);
    visit.wiring!.onMarkUnread("a0");
    expect(writes).toEqual([[["a", "a0"], false, "glance", "a"], [["a0"], true]]);
    act(() => visit.wiring!.onEnter());
    const p = (id: string) => ({ id, ready: true, height: 100, first: { top: 0, bottom: 20 }, lead: { top: 20, bottom: 60 }, end: { top: 60, bottom: 60 } });
    const r = visit.wiring!.record;
    r.observe([p("a0")], { top: 0, bottom: 800 }, new Set(["a0"]), 0);
    expect(r.observe([p("a0")], { top: 0, bottom: 800 }, new Set(["a0"]), THREAD_READ_HOLD_MS + 1), "kept unread").toEqual([]);
  });

  it("a step key's landing rests: the wiring carries the rest and previews until stayed or entered", () => {
    act(() => show(letter("a")));
    expect(visit.wiring?.restMs, "shown by another path: no rest").toBeUndefined();
    expect(visit.wiring?.previewing).toBeFalsy();
    act(() => { visit.land("b"); show(letter("b")); });
    expect(visit.wiring?.restMs).toBe(LANDING_REST_MS);
    expect(visit.wiring?.previewing).toBe(true);
    act(() => visit.wiring!.onStay!());
    expect(visit.wiring?.previewing, "stayed: its pictures load").toBe(false);
    expect(visit.wiring?.restMs).toBe(LANDING_REST_MS);
    act(() => { visit.land("c"); show(letter("c")); });
    act(() => visit.wiring!.onEnter());
    expect(visit.wiring?.previewing, "entered").toBe(false);
  });

  it("a landing ends with its visit: back by another path is no landing, and a landing not shown is dropped", () => {
    act(() => { visit.land("a"); show(letter("a")); });
    act(() => show(letter("b")));
    expect(visit.wiring?.restMs, "b came by another path").toBeUndefined();
    act(() => show(letter("a")));
    expect(visit.wiring?.restMs, "back on a: a new visit").toBeUndefined();
    act(() => visit.land("c"));
    act(() => show(letter("c")));
    expect(visit.wiring?.restMs, "c was not shown when it was landed on").toBeUndefined();
  });
});

describe("a landing rested on (LANDING_REST_MS) is entered; a command or a press ends the rest", () => {
  const key = (k: string, taken: boolean): void => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    if (taken) document.addEventListener("keydown", (ev) => ev.preventDefault(), { once: true });
    document.body.dispatchEvent(e);
  };
  it("after the rest, attended: entered once, and the dwell then reads; not a moment before", () => {
    panel("a", 0, 300);
    mount(LANDING_REST_MS);
    flush();
    pass(LANDING_REST_MS - 10);
    expect(enters).toBe(0);
    pass(20);
    expect(enters).toBe(1);
    dwell();
    expect(reads).toEqual([["a"]]);
  });
  it("no rest given (a URL landing, a click, a reader the sheet shows): never entered", () => {
    panel("a", 0, 300);
    mount();
    pass(60_000);
    expect(enters).toBe(0);
    expect(reads).toEqual([]);
  });
  it("a key the app took ends it; a key it did not take does not", () => {
    panel("a", 0, 300);
    mount(LANDING_REST_MS);
    key("Shift", false);
    pass(LANDING_REST_MS + 10);
    expect(enters).toBe(1);
    core?.dispose();
    record = createThreadRead(); enters = 0;
    mount(LANDING_REST_MS);
    key("m", true);
    pass(60_000);
    expect(enters).toBe(0);
  });
  it("a press that does not enter, here or outside the reader, ends it; a press in the message enters at once", () => {
    const el = panel("a", 0, 300);
    bar(700);
    mount(LANDING_REST_MS);
    scroller.querySelector(".msg-actions")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    pass(60_000);
    expect(enters).toBe(0);
    core?.dispose();
    record = createThreadRead();
    mount(LANDING_REST_MS);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    pass(60_000);
    expect(enters).toBe(0);
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(enters).toBe(1);
    outside.remove();
  });
  it("the window away starts it over; back, the whole rest again", () => {
    panel("a", 0, 300);
    mount(LANDING_REST_MS);
    pass(LANDING_REST_MS - 100);
    focused = false;
    window.dispatchEvent(new Event("blur"));
    pass(60_000);
    expect(enters).toBe(0);
    focused = true;
    window.dispatchEvent(new Event("focus"));
    pass(LANDING_REST_MS - 100);
    expect(enters).toBe(0);
    pass(200);
    expect(enters).toBe(1);
  });
  it("a reader laid out nowhere (the column hidden) is not entered", () => {
    scroller.remove();
    scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { get: () => 0 });
    Object.defineProperty(scroller, "clientWidth", { get: () => 0 });
    Object.defineProperty(scroller, "scrollHeight", { get: () => 0 });
    at.scroller = { top: 0, bottom: 0 };
    scroller.getBoundingClientRect = rect("scroller");
    document.body.appendChild(scroller);
    panel("a", 0, 300);
    mount(LANDING_REST_MS);
    pass(60_000);
    expect(enters).toBe(0);
  });
  it("a page modal standing over it (one that came by no key or press) keeps the rest from entering", () => {
    panel("a", 0, 300);
    mount(LANDING_REST_MS);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    pass(60_000);
    expect(enters).toBe(0);
    modal.remove();
    core?.dispose();
    record = createThreadRead();
    document.body.appendChild(modal);
    mount(LANDING_REST_MS); // landed while it stood
    pass(60_000);
    expect(enters).toBe(0);
    modal.remove();
  });
  it("the key that made the landing (its adapter born inside that key's dispatch) does not end the rest", () => {
    panel("a", 0, 300);
    document.addEventListener("keydown", (ev) => { ev.preventDefault(); mount(LANDING_REST_MS); }, { once: true });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
    pass(LANDING_REST_MS + 10);
    expect(enters).toBe(1);
  });
  it("the rest's length on it is reported (its pictures load) even after a command ended the rest", () => {
    panel("a", 0, 300);
    mount(LANDING_REST_MS);
    key("x", true);
    pass(LANDING_REST_MS - 10);
    expect(stays).toBe(0);
    pass(20);
    expect([stays, enters]).toEqual([1, 0]);
    core?.dispose();
    stays = 0;
    mount(LANDING_REST_MS);
    pass(LANDING_REST_MS - 10);
    core?.dispose();
    core = null;
    pass(60_000);
    expect(stays, "moved on before it: nothing").toBe(0);
  });
  it("disposed (the cursor moved on) before the rest: never entered", () => {
    panel("a", 0, 300);
    mount(LANDING_REST_MS);
    pass(LANDING_REST_MS - 10);
    core?.dispose();
    core = null;
    pass(60_000);
    expect(enters).toBe(0);
  });
});
