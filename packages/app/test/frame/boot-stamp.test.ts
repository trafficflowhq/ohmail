/** @vitest-environment jsdom */
/**
 * THE PRE-PAINT STAMPS SAY WHAT THE FRAME WILL SAY. The inline script's text, the function itself and the frame's own
 * root attributes agree on the scheme, the device and the pointer at a phone's width, an open Duo, either side of 700 under a
 * mouse, an unfolded phone upright, one on its side and a desktop, light and dark.
 */
import { afterEach, describe, expect, it } from "vitest";
import { frameBootScript, stampFrameAttributes } from "../../src/frame/boot-stamp.js";
import { attributesOf } from "../../src/frame/root-attributes.js";
import { layoutPlan } from "../../src/frame/layout-plan.js";
import type { WindowFacts } from "../../src/frame/contract.js";

const WINDOWS: readonly WindowFacts[] = [
  { width: 390, height: 844, pointer: "coarse", posture: "flat", reducedMotion: false },
  { width: 669, height: 951, pointer: "coarse", posture: "flat", reducedMotion: false },
  { width: 699, height: 800, pointer: "fine", posture: "flat", reducedMotion: false },
  { width: 700, height: 800, pointer: "fine", posture: "flat", reducedMotion: false },
  { width: 719, height: 781, pointer: "coarse", posture: "flat", reducedMotion: false },
  { width: 841, height: 673, pointer: "coarse", posture: "flat", reducedMotion: false },
  { width: 1440, height: 900, pointer: "fine", posture: "flat", reducedMotion: false },
];
const STAMPED = ["data-scheme", "data-device", "data-touch"] as const;

/** A window of these facts, whose system scheme is `dark` or light. */
function windowOf(w: WindowFacts, dark: boolean): Window {
  const matchMedia = (query: string) => ({
    matches:
      query === "(pointer: coarse)"
        ? w.pointer === "coarse"
        : query === "(prefers-color-scheme: dark)"
          ? dark
          : false,
  });
  return { innerWidth: w.width, innerHeight: w.height, matchMedia } as unknown as Window;
}
const stamped = () =>
  Object.fromEntries(STAMPED.map((name) => [name, document.documentElement.getAttribute(name)]));

afterEach(() => {
  for (const name of [...STAMPED, "data-theme"]) document.documentElement.removeAttribute(name);
});

describe("the frame's pre-paint stamps", () => {
  for (const w of WINDOWS) {
    for (const scheme of ["light", "dark"] as const) {
      it(`at ${w.width} wide under a ${w.pointer} pointer, ${scheme}: the script, the function and the frame agree`, () => {
        const frame = attributesOf(layoutPlan(w), { face: "paper", scheme }, w);
        const expected = Object.fromEntries(STAMPED.map((name) => [name, frame[name]]));

        stampFrameAttributes(document, windowOf(w, scheme === "dark"));
        expect(stamped()).toEqual(expected);

        for (const name of STAMPED) document.documentElement.removeAttribute(name);
        // The script's own text, run as a document runs it: it takes nothing but the page's document and window.
        new Function("document", "window", frameBootScript())(document, windowOf(w, scheme === "dark"));
        expect(stamped()).toEqual(expected);
      });
    }
  }

  it("follows the theme the theme script stamped over the system's scheme", () => {
    document.documentElement.setAttribute("data-theme", "light");
    stampFrameAttributes(document, windowOf(WINDOWS[6]!, true));
    expect(document.documentElement.getAttribute("data-scheme")).toBe("light");
    document.documentElement.setAttribute("data-theme", "dark");
    stampFrameAttributes(document, windowOf(WINDOWS[6]!, false));
    expect(document.documentElement.getAttribute("data-scheme")).toBe("dark");
  });
});
