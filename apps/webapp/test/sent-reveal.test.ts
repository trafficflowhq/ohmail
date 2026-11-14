/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_READ_HOLD_MS, createThreadRead } from "@ohmail/client-engine";
import {
  REVEAL_MARGIN_PX, REVEAL_MAX_MS, REVEAL_MIN_MS, easeScroll, revealDuration, revealIn,
} from "../app/shell/sent-reveal";
import { createThreadReadDom } from "@ohmail/app-logic/reading/reader-seen";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout";

/**
 * THE SENT REPLY, EASED INTO VIEW (`sent-reveal.ts`). The column is `fixtures/thread-layout.ts`'s:
 * 800px tall, the bar's top at 740 (the view's foot), panels stacked with a 20px gap. Frames and the
 * clock are the fake timers', so the read rule and the motion share one time.
 */

let layout: ThreadLayout;
let col: HTMLElement;
let reduced = false;

function column(ids: Array<{ id: string; unseen?: boolean }>): void {
  col = document.createElement("div");
  col.className = "read-col";
  for (const { id, unseen } of ids) {
    const p = document.createElement("article");
    p.dataset.convId = id;
    p.setAttribute("data-body-ready", "");
    if (unseen) p.setAttribute("data-unseen", "");
    const from = document.createElement("div");
    from.className = "msg-from";
    const body = document.createElement("div");
    body.className = "pm-body";
    const end = document.createElement("span");
    end.setAttribute("data-own-end", "");
    body.appendChild(end);
    p.append(from, body);
    col.appendChild(p);
  }
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  col.appendChild(bar);
  document.body.appendChild(col);
}
const panel = (id: string): HTMLElement => col.querySelector<HTMLElement>(`[data-conv-id="${id}"]`)!;
/** Run frames until none is asked for, keeping each frame's place; a moved column sends its `scroll`, as a browser's does. */
function run(): number[] {
  const tops: number[] = [];
  for (let i = 0; i < 100 && vi.getTimerCount() > 0; i++) {
    const was = col.scrollTop;
    vi.advanceTimersByTime(16);
    if (col.scrollTop !== was) col.dispatchEvent(new Event("scroll"));
    tops.push(col.scrollTop);
  }
  return tops;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.setSystemTime(new Date("2026-11-04T09:00:00Z"));
  layout = stubThreadLayout();
  reduced = false;
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes("reduce"), media: q })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  layout.restore();
  col?.remove();
  vi.useRealTimers();
});

describe("the sent copy is eased into view", () => {
  it("one eased scroll ends with its bottom a margin above the bar; short, scaled to the distance", () => {
    column([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "s" }]);
    col.scrollTop = 700;
    const bottom = layout.topOf("s") + 400;
    expect(revealIn(col, panel("s"))).not.toBeNull();
    const tops = run();
    expect(col.scrollTop).toBe(bottom - 740 + REVEAL_MARGIN_PX);
    const steps = tops.map((t, i) => t - (tops[i - 1] ?? 700)).filter((d) => d > 0);
    expect(steps[0], "ease-out: the first step is the longest").toBeGreaterThan(steps[steps.length - 1]!);
    expect(tops.every((t, i) => i === 0 || t >= tops[i - 1]!), "it never goes back").toBe(true);
    // The fake frames' phase follows the real clock at install: the first frame comes 1-16 ms in.
    expect((tops.indexOf(col.scrollTop) + 1) * 16, "done within its duration").toBeLessThanOrEqual(revealDuration(236) + 32);
    expect(revealDuration(0)).toBe(REVEAL_MIN_MS);
    expect(revealDuration(5000)).toBe(REVEAL_MAX_MS);
  });

  it("a copy taller than the view: its top a margin below the view's top", () => {
    column([{ id: "a" }, { id: "s" }]);
    layout.heights.s = 1200;
    revealIn(col, panel("s"));
    run();
    expect(col.scrollTop).toBe(layout.topOf("s") - REVEAL_MARGIN_PX);
  });

  it("already wholly on screen: nothing moves and no frame is asked", () => {
    column([{ id: "a" }, { id: "s" }]);
    layout.heights.a = 200;
    layout.heights.s = 300;
    expect(revealIn(col, panel("s"))).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(col.scrollTop).toBe(0);
  });

  it.each([
    ["a wheel", () => window.dispatchEvent(new Event("wheel"))],
    ["a touch", () => col.dispatchEvent(new Event("touchstart", { bubbles: true }))],
    ["a scroll key", () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }))],
    ["a press on the scrollbar", () => col.dispatchEvent(new Event("pointerdown", { bubbles: true }))],
  ])("%s mid-motion ends it at once", (_what, hand) => {
    column([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "s" }]);
    revealIn(col, panel("s"));
    vi.advanceTimersByTime(16 * 4);
    const at = col.scrollTop;
    expect(at).toBeGreaterThan(0);
    hand();
    run();
    expect(col.scrollTop).toBe(at);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a key typed in a field is not a scroll and leaves the motion going", () => {
    column([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "s" }]);
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    revealIn(col, panel("s"));
    vi.advanceTimersByTime(16 * 2);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    run();
    expect(col.scrollTop).toBe(layout.topOf("s") + 400 - 740 + REVEAL_MARGIN_PX);
    field.remove();
  });

  it("a scroll that is not the motion's (a scrollbar drag) ends it", () => {
    column([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "s" }]);
    easeScroll(col, 900);
    vi.advanceTimersByTime(16 * 3);
    col.scrollTop = 120;
    run();
    expect(col.scrollTop).toBe(120);
  });

  it("reduced motion: one instant move, no frames", () => {
    reduced = true;
    column([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "s" }]);
    col.scrollTop = 700;
    revealIn(col, panel("s"));
    const to = layout.topOf("s") + 400 - 740 + REVEAL_MARGIN_PX;
    expect(col.scrollTop, "there at once").toBe(to);
    expect(run().every((t) => t === to)).toBe(true);
  });
});

describe("nothing the motion passes turns read", () => {
  it("an unread message scrolled past stays unread; the one it stops on reads after the dwell (the control)", () => {
    column([{ id: "a" }, { id: "p", unseen: true }, { id: "q", unseen: true }, { id: "s", unseen: true }]);
    layout.heights.a = 900;
    const reads: string[][] = [];
    const record = createThreadRead();
    record.enter(Date.now());
    const core = createThreadReadDom({
      scroller: col, record, onRead: (ids) => reads.push(ids), onEnter: () => {},
      frameHovered: () => false, documentFocused: () => true, visible: () => true,
    });
    vi.advanceTimersByTime(32);
    revealIn(col, panel("s"));
    run();
    expect(col.scrollTop).toBe(layout.topOf("s") + 400 - 740 + REVEAL_MARGIN_PX);
    vi.advanceTimersByTime(THREAD_READ_HOLD_MS * 3);
    expect(reads.flat()).toEqual(["s"]);
    core.dispose();
  });
});
