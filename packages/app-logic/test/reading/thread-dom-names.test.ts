/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createThreadRead } from "@ohmail/client-engine";
import {
  THREAD_DOM,
  TOP_LINE_FALLBACK_PX,
  createThreadReadDom,
  panelsOf,
  pressEnters,
  viewOf,
  type ThreadDomNames,
} from "../../src/reading/reader-seen.js";

/**
 * THE READ RULE OVER HANDED NAMES. The rule reads a column by its sender line, its text block and the
 * controls that end the view; a column drawn from other parts hands their names, and reads the same panels
 * and the same view as today's classes give. jsdom has no layout: every box comes from `at`.
 */

type Box = { top: number; bottom: number };
const NEW: ThreadDomNames = {
  from: "[data-read-from]",
  body: "[data-read-body]",
  stops: "[data-read-stop]",
  stopsRoot: "[data-read-column]",
};

function boxed(el: Element, box: Box): void {
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
}

/** One column of two letters, drawn with today's classes or with the handed names. */
function column(names: "today" | "new"): { root: HTMLElement; scroller: HTMLElement; foot: HTMLElement } {
  const root = document.createElement("div");
  if (names === "new") root.setAttribute("data-read-column", "");
  const scroller = document.createElement("div");
  boxed(scroller, { top: 0, bottom: 800 });
  Object.defineProperty(scroller, "clientHeight", { value: 800 });
  root.appendChild(scroller);
  for (const [id, top] of [
    ["a", 0],
    ["b", 680],
  ] as const) {
    const panel = document.createElement("article");
    panel.dataset.convId = id;
    panel.setAttribute("data-unseen", "");
    panel.setAttribute("data-body-ready", "");
    boxed(panel, { top, bottom: top + 400 });
    const from = document.createElement("div");
    if (names === "today") from.className = "msg-from";
    else from.setAttribute("data-read-from", "");
    boxed(from, { top, bottom: top + 40 });
    const body = document.createElement("div");
    if (names === "today") body.className = "msg-body";
    else body.setAttribute("data-read-body", "");
    boxed(body, { top: top + 50, bottom: top + 380 });
    const end = document.createElement("span");
    end.setAttribute("data-own-end", "");
    boxed(end, { top: top + 370, bottom: top + 370 });
    body.appendChild(end);
    panel.append(from, body);
    scroller.appendChild(panel);
  }
  const foot = document.createElement("div");
  if (names === "today") {
    foot.className = "msg-actions";
    scroller.appendChild(foot);
  } else {
    foot.setAttribute("data-read-stop", "");
    root.appendChild(foot); // the kit's panel floats beside the scroller, not in it
  }
  boxed(foot, { top: 700, bottom: 760 });
  const button = document.createElement("button");
  foot.appendChild(button);
  document.body.appendChild(root);
  return { root, scroller, foot };
}

describe("the read rule over handed names", () => {
  it("today's names stay the default", () => {
    expect(THREAD_DOM.from).toBe(".msg-from");
    const { scroller } = column("today");
    expect(panelsOf(scroller).map((p) => p.first)).toEqual([
      { top: 0, bottom: 40 },
      { top: 680, bottom: 720 },
    ]);
  });

  it("a column built with handed names reads the same panels and view as today's classes", () => {
    const today = column("today");
    const built = column("new");
    expect(panelsOf(built.scroller, NEW)).toEqual(panelsOf(today.scroller));
    expect(panelsOf(built.scroller, NEW)[0]!.lead).toEqual({
      top: 50,
      bottom: 50 + 3 * TOP_LINE_FALLBACK_PX,
    });
    expect(viewOf(built.scroller, NEW)).toEqual(viewOf(today.scroller));
  });

  it("a foot outside the scroller ends the view above it", () => {
    const built = column("new");
    expect(viewOf(built.scroller, NEW)).toEqual({ top: 0, bottom: 700 });
    // Without the root to look from, the foot is not found and the view runs to the scroller's end.
    expect(viewOf(built.scroller, { ...NEW, stopsRoot: undefined })).toEqual({ top: 0, bottom: 800 });
  });

  it("a press on the handed foot's control is no reading; on a panel it is", () => {
    const built = column("new");
    const panel = built.scroller.querySelector("article")!;
    expect(pressEnters(built.scroller, panel, NEW)).toBe(true);
    const inside = document.createElement("button");
    panel.appendChild(inside);
    expect(pressEnters(built.scroller, inside, NEW)).toBe(false);
  });

  it("the adapter reads with the names it is handed", () => {
    const built = column("new");
    const record = createThreadRead();
    const reads: string[][] = [];
    let t = 0;
    const frames: Array<() => void> = [];
    const dom = createThreadReadDom({
      scroller: built.scroller,
      record,
      names: NEW,
      onRead: (ids) => reads.push(ids),
      onEnter: () => {},
      now: () => t,
      visible: () => true,
      documentFocused: () => true,
      frame: (run) => {
        frames.push(run);
        return () => {};
      },
      after: () => () => {},
    });
    record.enter(0);
    const look = () => {
      while (frames.length) frames.shift()!();
      dom.poke();
      while (frames.length) frames.shift()!();
    };
    look();
    t = 800;
    look();
    // `a` stood whole above the foot; `b`'s sender line runs under it (680..720), its first lines and end below: it stays unread.
    expect(reads.flat()).toEqual(["a"]);
    dom.dispose();
  });
});
