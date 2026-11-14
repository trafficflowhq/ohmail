/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ColumnHandles } from "../app/shell/ColumnHandles";
import {
  COLUMNS_KEY,
  LIST,
  RAIL,
  clampList,
  clampRail,
  splitUserValue,
} from "@ohmail/app-logic/lists/column-store";

/**
 * THE TWO COLUMN SEPARATORS, DRIVEN — one case per interaction the spec names.
 *
 * ── WHAT A JSDOM HARNESS CAN AND CANNOT SAY HERE, STATED HONESTLY ───────────────────────────
 *
 * jsdom has no layout engine, so `getBoundingClientRect()` is all zeroes and no `clamp()` is
 * ever evaluated. That makes it useless for "is the handle in the gap" — which is why the
 * rendered walk exists (`scripts/columns-render.mjs`, real Chromium, both faces, three widths)
 * and why this file does not attempt it.
 *
 * What it CAN say is everything the component decides for itself: the arithmetic of a drag, the
 * keyboard steps, what is written to the store and in what shape, that a reset removes one
 * field and leaves the other, and that the keys the handle owns never reach the shell's
 * dispatcher. So the harness supplies the one thing jsdom withholds and the component needs —
 * the column's resolved width — by MODELLING THE CSS: the fake rail answers
 * `clamp(200px, --rail-w, 360px)` and the fake list answers the same product the stylesheet
 * computes. A width that came back from a stub the test wrote itself would prove nothing about
 * the stylesheet, so the stylesheet's own numbers are pinned separately, at the text, in
 * `column-geometry.test.ts`; here the model stands in for layout so the LOGIC can be exercised.
 *
 * Mutations watched: dropping `clampRail` from `set()` → the over-drag case red; persisting on
 * `pointermove` instead of `pointerup` → "a drag writes once" red; downgrading the key handler's
 * `stopImmediatePropagation` to a plain `stopPropagation` (the defect two reviews caught) → the
 * CLAIM case red; making `reset()` clear the whole record → "one handle at a time" red; deleting
 * the unmount cleanup → the mid-drag-unmount case red; falling back to the shipped default in
 * `measure()` → the accumulation case red.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The split's inner width in the harness — wide enough that the list's own 720 ceiling binds. */
const SPLIT_W = 1200;

let roots: Root[] = [];
const root = () => document.documentElement;
const railVar = () => parseFloat(root().style.getPropertyValue("--rail-w")) || RAIL.dflt;
const listVar = () => {
  const raw = root().style.getPropertyValue("--split-user");
  const m = /min\((\d+)px,/.exec(raw);
  return m ? Number(m[1]) : LIST.dflt;
};

/** The CSS the browser would have applied, modelled so `measure()` has something honest to read. */
function rect(width: number): DOMRect {
  return {
    width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function Harness({ split = true }: { split?: boolean }) {
  return h(
    "div",
    { className: "deck" },
    h("nav", { className: "rail", key: "rail" }),
    h(ColumnHandles, { key: "handles" }),
    h(
      "main",
      { className: "stage", key: "stage" },
      // `split: false` is a view that carries no list column — Compose, Settings, or the
      // instant during a route change when the old view has gone and the new one has not
      // arrived. The list's separator is portalled into that column, so this is what unmounts
      // it out from under a live gesture.
      split
        ? h(
            "section",
            { className: "view split view-ohbox" },
            h("div", { className: "list-col" }),
            h("div", { className: "read-col" }),
          )
        : h("section", { className: "view view-compose" }),
    ),
  );
}

let rerender: (split: boolean) => Promise<void> = async () => {};

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = createRoot(container);
  roots.push(r);
  const paint = async (split: boolean) => {
    await act(async () => {
      r.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "UTC",
          children: h(Harness, { split }),
        }),
      );
    });
  };
  rerender = paint;
  await paint(true);
  // Model the layout the stylesheet would have produced, live: the rail wears its CSS clamp,
  // and the list wears its own clamp under the room the reading column's floor leaves.
  const rail = container.querySelector<HTMLElement>(".deck > .rail")!;
  rail.getBoundingClientRect = () => rect(clampRail(railVar()));
  const split = container.querySelector<HTMLElement>(".view.split")!;
  Object.defineProperty(split, "clientWidth", { value: SPLIT_W, configurable: true });
  const list = container.querySelector<HTMLElement>(".view.split > .list-col")!;
  list.getBoundingClientRect = () => rect(clampList(listVar()));
  // The portal lands on the second render; give it one.
  await act(async () => {});
  return container;
}

const handle = (c: HTMLElement, kind: "rail" | "list"): HTMLElement => {
  const el = c.querySelector<HTMLElement>(`.col-handle-${kind}`);
  expect(el, `the ${kind} separator is not on screen`).toBeTruthy();
  return el!;
};

const pointer = async (el: HTMLElement, type: string, clientX: number): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }),
    );
  });
};

/** A whole gesture: press, eight moves (the probe's own cadence), release. */
async function drag(el: HTMLElement, dx: number): Promise<void> {
  await pointer(el, "pointerdown", 500);
  for (let i = 1; i <= 8; i++) await pointer(el, "pointermove", 500 + (dx * i) / 8);
  await pointer(el, "pointerup", 500 + dx);
}

const press = async (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};

const stored = (): unknown => {
  const raw = window.localStorage.getItem(COLUMNS_KEY);
  return raw === null ? null : JSON.parse(raw);
};

/** The pointer-capture stubs jsdom does not implement — installed per test and REMOVED after,
 *  so a later suite sharing this environment still sees their genuine absence (a component that
 *  feature-detects `setPointerCapture` would otherwise take the wrong branch for ever). */
const CAPTURE_STUBS = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;

beforeEach(() => {
  window.localStorage.clear();
  root().removeAttribute("style");
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.hasPointerCapture = () => false;
});

afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  document.body.innerHTML = "";
  root().removeAttribute("style");
  window.localStorage.clear();
  const proto = Element.prototype as unknown as Record<string, unknown>;
  for (const name of CAPTURE_STUBS) delete proto[name];
});

describe("the separators exist, and say what they are", () => {
  it("both are focusable separators with the width they are on", async () => {
    const c = await mount();
    for (const [kind, min, dflt] of [
      ["rail", RAIL.min, RAIL.dflt],
      ["list", LIST.min, LIST.dflt],
    ] as const) {
      const el = handle(c, kind);
      expect(el.getAttribute("role")).toBe("separator");
      expect(el.getAttribute("aria-orientation")).toBe("vertical");
      expect(el.tabIndex).toBe(0);
      expect(el.getAttribute("aria-label")).toBeTruthy();
      expect(Number(el.getAttribute("aria-valuemin"))).toBe(min);
      expect(Number(el.getAttribute("aria-valuenow"))).toBe(dflt);
    }
  });

  it("the list's separator is portalled INTO the split's list column, not left beside the deck", async () => {
    const c = await mount();
    const listCol = c.querySelector(".view.split > .list-col")!;
    expect(listCol.contains(handle(c, "list"))).toBe(true);
    expect(c.querySelector(".deck > .col-handle-rail")).toBeTruthy();
  });

  it("a shell nobody has dragged writes NOTHING — neither a property nor a key", async () => {
    await mount();
    expect(root().style.getPropertyValue("--rail-w")).toBe("");
    expect(root().style.getPropertyValue("--split-user")).toBe("");
    expect(stored()).toBeNull();
  });

  it("the list's announced ceiling is the room, not the raw maximum, when the room is smaller", async () => {
    const c = await mount();
    const split = c.querySelector<HTMLElement>(".view.split")!;
    // 900 of room leaves 420 once the reading column keeps its 480 floor — under the 720 max.
    Object.defineProperty(split, "clientWidth", { value: 900, configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(Number(handle(c, "list").getAttribute("aria-valuemax"))).toBe(900 - LIST.viewerMin);
  });
});

describe("dragging", () => {
  it("moves the rail by the pointer's travel and persists ONCE, on release", async () => {
    const c = await mount();
    const el = handle(c, "rail");
    await pointer(el, "pointerdown", 500);
    await pointer(el, "pointermove", 580);
    // Mid-gesture the geometry is live and the store is untouched: a drag somebody is still
    // making up their mind about must not be written on every frame.
    expect(root().style.getPropertyValue("--rail-w")).toBe("304px");
    expect(stored()).toBeNull();
    await pointer(el, "pointerup", 580);
    expect(stored()).toEqual({ v: 1, rail: 304 });
    expect(Number(el.getAttribute("aria-valuenow"))).toBe(304);
  });

  it("moves the list, and writes the split's whole track list", async () => {
    const c = await mount();
    await drag(handle(c, "list"), 160);
    expect(root().style.getPropertyValue("--split-user")).toBe(splitUserValue(560));
    expect(stored()).toEqual({ v: 1, list: 560 });
  });

  it("clamps at both ends rather than following the pointer past them", async () => {
    const c = await mount();
    await drag(handle(c, "rail"), 600);
    expect(stored()).toEqual({ v: 1, rail: RAIL.max });
    await drag(handle(c, "rail"), -900);
    expect(stored()).toEqual({ v: 1, rail: RAIL.min });
    await drag(handle(c, "list"), 3000);
    expect(stored()).toEqual({ v: 1, rail: RAIL.min, list: LIST.max });
    await drag(handle(c, "list"), -3000);
    expect(stored()).toEqual({ v: 1, rail: RAIL.min, list: LIST.min });
  });

  it("…and the clamp is on the LIVE property, not only on the way into the store", async () => {
    // The two are not the same guard, and the store's clamp hides the live one from anything
    // that only reads the store. `--split-user` is `min(<chosen>, <the room>)`, so an
    // unclamped 3000 costs nothing at 1440 — the room binds first — and on a 2560 display it
    // stands a 1800px list beside a reading column, until a reload snaps it back to the 720
    // the store DID clamp. So the property itself is asserted, at both ends and both handles.
    const c = await mount();
    await drag(handle(c, "list"), 3000);
    expect(root().style.getPropertyValue("--split-user")).toBe(splitUserValue(LIST.max));
    await drag(handle(c, "list"), -3000);
    expect(root().style.getPropertyValue("--split-user")).toBe(splitUserValue(LIST.min));
    await drag(handle(c, "rail"), 900);
    expect(root().style.getPropertyValue("--rail-w")).toBe(`${RAIL.max}px`);
    await drag(handle(c, "rail"), -900);
    expect(root().style.getPropertyValue("--rail-w")).toBe(`${RAIL.min}px`);
  });

  it("a press that never moves leaves the record exactly as it was", async () => {
    const c = await mount();
    const el = handle(c, "rail");
    await pointer(el, "pointerdown", 500);
    await pointer(el, "pointerup", 500);
    // NOT `{v:1,rail:224}`: a click is not a choice, and writing the default as if it were one
    // would freeze this reader at 224 the day the default changes.
    expect(stored()).toBeNull();
  });

  it("a gesture whose handle is UNMOUNTED mid-drag still releases the shell", async () => {
    /**
     * `.deck.col-resizing` puts `cursor: col-resize !important` and `user-select: none
     * !important` on the deck and every descendant, and takes pointer events off every mail-body
     * iframe. Right for half a second, catastrophic if it sticks: nothing selectable, every
     * cursor a resize cursor, message bodies refusing clicks, until a reload.
     *
     * And a pointerup is NOT guaranteed to arrive at this element. The list's separator is
     * portalled into whichever view is mounted, so navigating mid-gesture unmounts it and the
     * release lands on nothing — the exact sequence driven here.
     */
    const c = await mount();
    const deck = c.querySelector(".deck")!;
    await pointer(handle(c, "list"), "pointerdown", 500);
    expect(deck.classList.contains("col-resizing")).toBe(true);
    await rerender(false);
    expect(c.querySelector(".col-handle-list"), "the portalled handle should be gone").toBeNull();
    expect(
      deck.classList.contains("col-resizing"),
      "the shell was left in the drag state with no handle to end it",
    ).toBe(false);
  });

  it("marks the deck while the gesture is live, so nothing under the pointer claims it", async () => {
    const c = await mount();
    const deck = c.querySelector(".deck")!;
    const el = handle(c, "rail");
    await pointer(el, "pointerdown", 500);
    expect(deck.classList.contains("col-resizing")).toBe(true);
    expect(el.classList.contains("dragging")).toBe(true);
    await pointer(el, "pointerup", 500);
    expect(deck.classList.contains("col-resizing")).toBe(false);
    expect(el.classList.contains("dragging")).toBe(false);
  });
});

describe("the keyboard, on a focused separator", () => {
  it("←/→ move by one step and ⇧ by the coarse one", async () => {
    const c = await mount();
    const el = handle(c, "rail");
    await press(el, "ArrowRight");
    expect(railVar()).toBe(RAIL.dflt + 16);
    await press(el, "ArrowRight", { shiftKey: true });
    expect(railVar()).toBe(RAIL.dflt + 16 + 64);
    await press(el, "ArrowLeft", { shiftKey: true });
    expect(railVar()).toBe(RAIL.dflt + 16);
    await press(el, "ArrowLeft");
    expect(railVar()).toBe(RAIL.dflt);
    // Unlike a drag, every key press is a settled decision and is persisted at once.
    expect(stored()).toEqual({ v: 1, rail: RAIL.dflt });
  });

  it("steps ACCUMULATE where the column cannot be measured, instead of restarting from the default", async () => {
    const c = await mount();
    const el = handle(c, "rail");
    // A column with no layout — mid-transition, just detached by a view swap, or any jsdom.
    // The old fallback was the shipped 224, so two presses landed on 240 and not 256.
    const rail = c.querySelector<HTMLElement>(".deck > .rail")!;
    rail.getBoundingClientRect = () => rect(0);
    await press(el, "ArrowRight");
    await press(el, "ArrowRight");
    await press(el, "ArrowRight");
    expect(railVar()).toBe(RAIL.dflt + 48);
    expect(stored()).toEqual({ v: 1, rail: RAIL.dflt + 48 });
  });

  it("Home and End are the floor and the ceiling", async () => {
    const c = await mount();
    const el = handle(c, "list");
    await press(el, "End");
    expect(stored()).toEqual({ v: 1, list: LIST.max });
    await press(el, "Home");
    expect(stored()).toEqual({ v: 1, list: LIST.min });
  });

  it("⌫ resets THIS handle and leaves the other one's width standing", async () => {
    const c = await mount();
    await drag(handle(c, "rail"), 80);
    await drag(handle(c, "list"), 80);
    expect(stored()).toEqual({ v: 1, rail: 304, list: 480 });
    await press(handle(c, "rail"), "Backspace");
    expect(stored()).toEqual({ v: 1, list: 480 });
    expect(root().style.getPropertyValue("--rail-w")).toBe("");
    expect(root().style.getPropertyValue("--split-user")).toBe(splitUserValue(480));
  });

  it("resetting the LAST width removes the key rather than storing the defaults", async () => {
    const c = await mount();
    await drag(handle(c, "rail"), 80);
    await press(handle(c, "rail"), "Delete");
    expect(window.localStorage.getItem(COLUMNS_KEY)).toBeNull();
  });

  it("a double-click resets the same way a ⌫ does", async () => {
    const c = await mount();
    const el = handle(c, "rail");
    await drag(el, 80);
    await act(async () => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(root().style.getPropertyValue("--rail-w")).toBe("");
  });

  it("a key the separator handles CLAIMS the event — and `stopPropagation` is not enough", async () => {
    /**
     * THIS HARNESS CANNOT REPRODUCE THE DEFECT, AND SAYING SO IS THE POINT — the same sentence
     * `action-bar.test.ts` carries over `MoreMenu`, for the same mechanism.
     *
     * On the web door the App Router hydrates the whole document, so React's delegated keydown
     * listener and `keymap.tsx`'s `document.addEventListener("keydown", …)` are two bubble
     * listeners on the SAME node, and `stopPropagation` only stops an event moving to the next
     * NODE. The registry ran anyway: → widened the rail AND fired the zone model's step into
     * the reader, pulling focus off the separator, so keyboard resizing was single-shot in a
     * browser and correct on the desktop (which mounts at `#root`, below `document`).
     *
     * This test mounts into a `<div>`, where React's listener genuinely IS below `document` and
     * a plain `stopPropagation` genuinely does work — so the outcome case below is green either
     * way and cannot be the guard. What is watched is the CALL, which is the only thing that
     * differs between the broken build and this one.
     */
    const c = await mount();
    for (const kind of ["rail", "list"] as const) {
      const el = handle(c, kind);
      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete"]) {
        const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        let immediate = 0;
        e.stopImmediatePropagation = () => { immediate++; };
        await act(async () => { el.dispatchEvent(e); });
        expect(immediate, `${kind}: ${key} did not claim the event away from the document listener`).toBe(1);
        expect(e.defaultPrevented, `${kind}: ${key} left its default action standing`).toBe(true);
      }
      // …and a key the separator does NOT handle is left entirely alone, so the claim comes
      // from the branch that acts and not from a handler that swallows everything.
      const pass = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
      let touched = 0;
      pass.stopImmediatePropagation = () => { touched++; };
      await act(async () => { el.dispatchEvent(pass); });
      expect(touched, `${kind}: j was claimed by a separator that does not act on it`).toBe(0);
      expect(pass.defaultPrevented).toBe(false);
    }
  });

  it("the keys the handle owns never reach the shell's dispatcher — and the others still do", async () => {
    const c = await mount();
    const el = handle(c, "rail");
    const seen: string[] = [];
    const spy = (e: Event) => seen.push((e as KeyboardEvent).key);
    document.addEventListener("keydown", spy);
    try {
      // The zone model's own ←/→ are registered on `document` (keymap.tsx). While this widget
      // holds focus they must not fire, or one press would both widen the rail and walk zones.
      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete"]) {
        await press(el, key);
      }
      expect(seen).toEqual([]);
      // …and nothing else is swallowed: `j` on a focused handle is still the shell's `j`.
      await press(el, "j");
      expect(seen).toEqual(["j"]);
    } finally {
      document.removeEventListener("keydown", spy);
    }
  });
});

describe("persistence, across a reload of the shell", () => {
  it("a stored record is the geometry the next mount starts from", async () => {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify({ v: 1, rail: 288, list: 512 }));
    const c = await mount();
    // NOTHING stamped these properties in this harness — no boot script runs here — so this
    // case is also the guard on the self-heal: the shell adopts the record itself, which is
    // what makes the FIRST nudge relative to the stored width instead of to the default.
    expect(root().style.getPropertyValue("--rail-w")).toBe("288px");
    expect(root().style.getPropertyValue("--split-user")).toBe(splitUserValue(512));
    await press(handle(c, "rail"), "ArrowRight");
    expect(stored()).toEqual({ v: 1, rail: 304, list: 512 });
  });

  it("a record written past the bounds is clamped on the way IN, not carried around", async () => {
    // A jar hand-edited, or written by a build with different bounds. The screen must not
    // stand at 9999 for a frame, and the next write must not persist it back.
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify({ v: 1, rail: 9999, list: -5 }));
    const c = await mount();
    expect(root().style.getPropertyValue("--rail-w")).toBe(`${RAIL.max}px`);
    expect(root().style.getPropertyValue("--split-user")).toBe(splitUserValue(LIST.min));
    await press(handle(c, "list"), "ArrowRight");
    expect(stored()).toEqual({ v: 1, rail: RAIL.max, list: LIST.min + 16 });
  });

  it("a record from an unknown version reads as no preference, and the next write replaces it", async () => {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify({ v: 2, rail: 9999, list: 9999 }));
    const c = await mount();
    expect(root().style.getPropertyValue("--rail-w")).toBe("");
    await press(handle(c, "rail"), "ArrowRight");
    expect(stored()).toEqual({ v: 1, rail: RAIL.dflt + 16 });
  });

  it("a jar that refuses is a preference that does not persist, never a broken shell", async () => {
    const jar = window.localStorage;
    const refuse = () => {
      throw new Error("QuotaExceededError");
    };
    const real = { getItem: jar.getItem, setItem: jar.setItem };
    Object.defineProperty(jar, "getItem", { value: refuse, configurable: true });
    Object.defineProperty(jar, "setItem", { value: refuse, configurable: true });
    try {
      const c = await mount();
      await press(handle(c, "rail"), "ArrowRight");
      // The width still moved for this session — the store simply did not keep it.
      expect(railVar()).toBe(RAIL.dflt + 16);
    } finally {
      Object.defineProperty(jar, "getItem", { value: real.getItem, configurable: true });
      Object.defineProperty(jar, "setItem", { value: real.setItem, configurable: true });
    }
  });
});
