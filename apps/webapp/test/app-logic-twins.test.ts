/** @vitest-environment jsdom */
/**
 * TWO THINGS EXIST TWICE: the geometry under the web door's text size, and the keys a browser
 * scrolls with. Behaviour may not import the component kit, and the kit needs both for itself.
 * Until the kit stops exporting them, each pair answers the same for the same page.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import * as kit from "@ohmail/ui";
import * as geometry from "@ohmail/app-logic/geometry";
import { SCROLL_KEYS } from "@ohmail/app-logic/keys";
import type { ToastFn, ToastOptions } from "@ohmail/app-logic/press/report";
import type { DecisionDestination, DecisionScope } from "@ohmail/app-logic/screener/decision";

const html = (): HTMLElement => document.documentElement;
afterEach(() => html().removeAttribute("style"));

function boxAt(x: number, y: number, width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  const r = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const numbers = ({ top, left, right, bottom, width, height, x, y }: geometry.CssRect) =>
  ({ top, left, right, bottom, width, height, x, y });

describe("the geometry's twin", () => {
  for (const stamp of [null, "1", "1.25", "0.9", "0", "wide"]) {
    it(`answers as the kit does with ${stamp === null ? "no zoom stamped" : `--ui-zoom: ${stamp}`}`, () => {
      if (stamp !== null) html().style.setProperty(kit.UI_ZOOM_VAR, stamp);
      const el = boxAt(50, 100, 250, 125);
      expect(geometry.UI_ZOOM_VAR).toBe(kit.UI_ZOOM_VAR);
      expect(geometry.uiZoom()).toBe(kit.uiZoom());
      expect(numbers(geometry.cssRect(el))).toEqual(numbers(kit.cssRect(el)));
      expect(geometry.cssPoint({ clientX: 30, clientY: 40 })).toEqual(kit.cssPoint({ clientX: 30, clientY: 40 }));
      expect(geometry.cssViewport()).toEqual(kit.cssViewport());
      expect(geometry.cssViewport(null)).toEqual(kit.cssViewport(null));
    });
  }

  it("hands back the browser's own rect where no zoom is stamped, as the kit does", () => {
    const el = boxAt(1, 2, 3, 4);
    const rect = el.getBoundingClientRect();
    el.getBoundingClientRect = () => rect;
    expect(geometry.cssRect(el)).toBe(rect);
    expect(kit.cssRect(el)).toBe(rect);
  });
});

describe("the scroll keys' twin", () => {
  it("names the keys the kit names, and no other", () => {
    expect([...SCROLL_KEYS].sort()).toEqual([...kit.SCROLL_KEYS].sort());
  });
});

/**
 * AND FOUR TYPES ARE DECLARED TWICE: what a toast takes, and where a decision sends a sender. The
 * press seam and the Screener's rules name them without the kit; the compiler holds each pair equal
 * here, and the decision's members are compared with the keys the kit's bar really binds.
 */
describe("the types behaviour declares beside the kit's", () => {
  it("a decision's destinations are the ones the kit's decision bar binds a key to", () => {
    const destinations: Record<DecisionDestination, true> = { ohbox: true, reads: true, receipts: true, screened: true, spam: true };
    expect(Object.keys(destinations).sort()).toEqual(Object.keys(kit.DECISION_KEY).sort());
    expectTypeOf<DecisionDestination>().toEqualTypeOf<kit.DecisionDestination>();
    expectTypeOf<DecisionScope>().toEqualTypeOf<kit.DecisionScope>();
  });

  it("the press seam's report is the kit's toast, option for option", () => {
    expectTypeOf<ToastOptions>().toEqualTypeOf<kit.ToastOptions>();
    expectTypeOf<ToastFn>().toEqualTypeOf<kit.ToastFn>();
  });
});
