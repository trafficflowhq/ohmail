/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fitRowMenu, useRowMenuFit } from "../app/shell/row-menu-fit";

/**
 * ═══ A ROW'S MENU STAYS ON SCREEN ═══════════════════════════════════════════════════════════
 *
 * CELL LAYOUT-WEB read the Screener's destination menu, opened from a lower row at 360x780, ending
 * 21px past the viewport (53px in German); the cut lines were the unsubscribe note. jsdom lays
 * nothing out, so boxes are planted from `data-rect`; the browser read is the layout cell.
 *
 * Mutation: `fitRowMenu` returning `{ up: false, maxHeight: null, scroll: 0 }` unconditionally
 * reddens the flip, scroll, cap and hook arms.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const VH = 780;

describe("fitRowMenu — below, else up, else the list scrolls, else capped to the larger side", () => {
  const band = { top: 0, bottom: VH };
  it("the room below, plus one pixel of rounding, is admitted below; a pixel more is not", () => {
    // below = 780 − 10 − 509 = 261
    expect(fitRowMenu({ natural: 262, downTop: 509, triggerTop: 470, gap: 4 }, band)).toEqual({ up: false, maxHeight: null, scroll: 0 });
    expect(fitRowMenu({ natural: 263, downTop: 509, triggerTop: 470, gap: 4 }, band)).toEqual({ up: true, maxHeight: null, scroll: 0 });
  });
  it("neither side holds it: capped to the larger side, so it scrolls and never leaves the screen", () => {
    // below = 780 − 10 − 420 = 350; above = 380 − 4 − 10 = 366
    expect(fitRowMenu({ natural: 500, downTop: 420, triggerTop: 380, gap: 4 }, band)).toEqual({ up: true, maxHeight: 366, scroll: 0 });
    // below = 780 − 10 − 300 = 470; above = 260 − 4 − 10 = 246
    expect(fitRowMenu({ natural: 500, downTop: 300, triggerTop: 260, gap: 4 }, band)).toEqual({ up: false, maxHeight: 470, scroll: 0 });
  });
});

const realRect = Element.prototype.getBoundingClientRect;
const planted = (el: Element): DOMRect => {
  const [top, bottom] = (el.getAttribute("data-rect") ?? "0,0").split(",").map(Number);
  return { top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON() {} } as DOMRect;
};
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  Element.prototype.getBoundingClientRect = realRect;
});

function Harness({ rowRect, natural, scroller }: { rowRect: string; natural: number; scroller?: string }) {
  const menu = React.useRef<HTMLDivElement>(null);
  const more = React.useRef<HTMLButtonElement>(null);
  const fit = useRowMenuFit(menu, more, true, 4);
  const [top, bottom] = rowRect.split(",").map(Number);
  return (
    <div data-rect={scroller ?? `0,${VH}`} style={scroller ? { overflowY: "auto" } : undefined}>
      <div className="row-slot" data-rect={rowRect} style={{ position: "relative" }}>
        <button ref={more} data-rect={`${bottom - 36},${bottom - 10}`}>more</button>
        <div
          ref={(el) => {
            if (el) {
              Object.defineProperty(el, "scrollHeight", { configurable: true, value: natural });
              (menu as React.MutableRefObject<HTMLDivElement | null>).current = el;
            }
          }}
          data-testid="menu"
          data-rect={`${bottom + 4},${bottom + 4 + natural}`}
          data-capped={fit.capped || undefined}
          style={fit.style}
        >
          {top}
        </div>
      </div>
    </div>
  );
}

function mount(node: React.ReactElement): HTMLElement {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VH });
  Element.prototype.getBoundingClientRect = function () { return planted(this); };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host.querySelector<HTMLElement>("[data-testid=menu]")!;
}

describe("useRowMenuFit — the decision reaches the menu's style before the first paint", () => {
  it("a menu no side holds is capped, scrolls inside and says so for the note to lead", () => {
    const el = mount(<Harness rowRect="300,420" natural={600} />);
    expect(el.style.maxHeight).toBe("370px"); // above = 384 − 4 − 10 vs below = 780 − 10 − 424
    expect(el.style.overflowY).toBe("auto");
    expect(el.getAttribute("data-capped")).toBe("true");
  });
});
