/** @vitest-environment jsdom */
/**
 * THE GEOMETRY EXISTS TWICE IN THE KIT: today's parts read it from `src/ui-zoom.ts`, and the next design's
 * may not import today's files (`old-new-apart.test.ts`), so `src/base/ui-zoom.ts` is its twin inside
 * that border. Until today's parts leave, the two answer the same for the same page.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as twin from "../../src/base/ui-zoom.js";
import * as today from "../../src/ui-zoom.js";

const html = (): HTMLElement => document.documentElement;
afterEach(() => html().removeAttribute("style"));

function boxAt(x: number, y: number, width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  const r = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const numbers = ({ top, left, right, bottom, width, height, x, y }: twin.CssRect) => ({
  top,
  left,
  right,
  bottom,
  width,
  height,
  x,
  y,
});

describe("the next design's geometry twin", () => {
  for (const stamp of [null, "1", "1.25", "0.9", "0", "wide"]) {
    it(`answers as today's does with ${stamp === null ? "no zoom stamped" : `--ui-zoom: ${stamp}`}`, () => {
      if (stamp !== null) html().style.setProperty(today.UI_ZOOM_VAR, stamp);
      const el = boxAt(50, 100, 250, 125);
      expect(twin.UI_ZOOM_VAR).toBe(today.UI_ZOOM_VAR);
      expect(twin.uiZoom()).toBe(today.uiZoom());
      expect(numbers(twin.cssRect(el))).toEqual(numbers(today.cssRect(el)));
      expect(twin.cssPoint({ clientX: 30, clientY: 40 })).toEqual(
        today.cssPoint({ clientX: 30, clientY: 40 }),
      );
      expect(twin.cssViewport()).toEqual(today.cssViewport());
      expect(twin.cssViewport(null)).toEqual(today.cssViewport(null));
    });
  }

  it("divides by the stamp, so the pair cannot agree by both doing nothing", () => {
    html().style.setProperty(twin.UI_ZOOM_VAR, "1.25");
    expect(numbers(twin.cssRect(boxAt(50, 100, 250, 125)))).toEqual({
      top: 80,
      left: 40,
      right: 240,
      bottom: 180,
      width: 200,
      height: 100,
      x: 40,
      y: 80,
    });
    expect(twin.cssPoint({ clientX: 125, clientY: 250 })).toEqual({ x: 100, y: 200 });
  });

  it("hands back the browser's own rect where no zoom is stamped, as today's does", () => {
    const el = boxAt(1, 2, 3, 4);
    const rect = el.getBoundingClientRect();
    el.getBoundingClientRect = () => rect;
    expect(twin.cssRect(el)).toBe(rect);
    expect(today.cssRect(el)).toBe(rect);
  });
});
