/**
 * THE BROWSER'S WINDOW, AS A SIGNAL: what a browser shell hands the frame as `device.window`. The frame never reads
 * `window` itself; a shell that is not a browser answers the key its own way.
 */
import type { Pointer, WindowFacts } from "../device.js";
import type { Signal } from "../signals.js";

const COARSE = "(pointer: coarse)";
const STILL = "(prefers-reduced-motion: reduce)";

function factsOf(win: Window): WindowFacts {
  const pointer: Pointer = win.matchMedia?.(COARSE).matches ? "coarse" : "fine";
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    pointer,
    posture: "flat",
    reducedMotion: win.matchMedia?.(STILL).matches ?? false,
  };
}

const same = (a: WindowFacts, b: WindowFacts): boolean =>
  a.width === b.width &&
  a.height === b.height &&
  a.pointer === b.pointer &&
  a.posture === b.posture &&
  a.reducedMotion === b.reducedMotion;

/** The window's facts, read again on a resize and on a change of pointer or motion; one object while nothing moved. */
export function browserWindowFacts(win: Window): Signal<WindowFacts> {
  let held = factsOf(win);
  return {
    read() {
      const now = factsOf(win);
      if (!same(now, held)) held = now;
      return held;
    },
    subscribe(changed) {
      const queries = [COARSE, STILL].map((q) => win.matchMedia?.(q)).filter((q): q is MediaQueryList => !!q);
      win.addEventListener("resize", changed);
      for (const q of queries) q.addEventListener("change", changed);
      return () => {
        win.removeEventListener("resize", changed);
        for (const q of queries) q.removeEventListener("change", changed);
      };
    },
  };
}
