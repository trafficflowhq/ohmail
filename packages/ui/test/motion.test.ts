/** @vitest-environment jsdom */
/**
 * The motion helper against the shipped motion tokens: the times it reads, what it plays, that a
 * new move replaces the running one, and that nothing is played for a person who asked for less
 * motion, whether the page says so or only their system does.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animate, flipPlay, flipSnap, motionEase, motionMs, motionReduced, motionShape } from "../src/motion/motion.js";

// Root-relative: under jsdom `import.meta.url` is not a file: URL.
const sheet = readFileSync(resolve(process.cwd(), "packages/tokens/src/design/motion.css"), "utf8");
const root = document.documentElement;

/** A stand-in for the browser's animation: it records what was asked and can be finished. */
function fakeAnimations(el: Element) {
  const made: { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
  el.animate = ((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    let done = () => {};
    const record = { keyframes, options, cancel: vi.fn(), finish: () => done() };
    made.push(record);
    return { cancel: record.cancel, addEventListener: (_: string, fn: () => void) => { done = fn; } } as unknown as Animation;
  }) as Element["animate"];
  return made;
}
const systemAsksForLess = (matches: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: matches && query === "(prefers-reduced-motion: reduce)" })) as typeof window.matchMedia;
};

beforeEach(() => {
  document.head.innerHTML = `<style>${sheet}</style>`;
  document.body.innerHTML = "";
  root.removeAttribute("data-rm");
  root.removeAttribute("style");
  systemAsksForLess(false);
});
afterEach(() => vi.restoreAllMocks());

describe("reading the tokens", () => {
  it("a time is its milliseconds", () => {
    expect(motionMs(root, "--d-move")).toBe(260);
    expect(motionMs(root, "--d-pop")).toBe(160);
    expect(motionMs(root, "--d-fold")).toBe(0);
  });

  it("under data-rm nothing travels and a fade is short", () => {
    root.setAttribute("data-rm", "1");
    expect(motionMs(root, "--d-move")).toBe(0);
    expect(motionMs(root, "--d-pop")).toBe(150);
    expect(motionShape(root, "--x-in")).toBe("none");
  });

  it("the time scale multiplies every time", () => {
    root.style.setProperty("--m-time", "4");
    expect(motionMs(root, "--d-move")).toBe(1040);
  });

  it("takes the forms a browser hands over, and 0 for a token that is not set", () => {
    const el = document.body.appendChild(document.createElement("div"));
    expect(motionMs(el, "--d-move")).toBe(0);
    for (const [text, ms] of [["calc(260ms * 1)", 260], ["calc(260ms * 0.5)", 130], ["150ms", 150], [".2s", 200], ["soon", 0]] as const) {
      el.style.setProperty("--d-move", text);
      expect(motionMs(el, "--d-move"), text).toBe(ms);
    }
  });

  it("a curve and a shape are read as written, with the still answer for one that is not set", () => {
    expect(motionEase(root, "--e-move")).toBe("cubic-bezier(.16,1,.3,1)");
    expect(motionShape(root, "--x-in")).toBe("translateY(8px)");
    expect(motionShape(root, "--o-pop")).toBe("0");
    const bare = document.body.appendChild(document.createElement("div"));
    expect([motionEase(bare, "--e-move"), motionShape(bare, "--x-in"), motionShape(bare, "--o-pop")]).toEqual(["linear", "none", "1"]);
  });
});

describe("reduced motion", () => {
  it("is the system's setting, read here, or data-rm on the element or above it", () => {
    const el = document.body.appendChild(document.createElement("div"));
    expect(motionReduced(el)).toBe(false);
    document.body.setAttribute("data-rm", "1");
    expect(motionReduced(el)).toBe(true);
    document.body.setAttribute("data-rm", "0");
    expect(motionReduced(el)).toBe(false);
    systemAsksForLess(true);
    expect(motionReduced(el)).toBe(true);
    document.body.removeAttribute("data-rm");
  });
});

describe("animate", () => {
  it("plays a role's shape for its time on the curve named", () => {
    const made = fakeAnimations(root);
    expect(animate(root, "in", { ease: "--e-arrive" })).not.toBeNull();
    expect(made[0].keyframes).toEqual([{ transform: "translateY(8px)", opacity: "1" }, { transform: "none", opacity: "1" }]);
    expect(made[0].options).toEqual({ duration: 220, easing: "cubic-bezier(.16,1,.3,1)", fill: "none" });
  });

  it("plays a leaving role towards its shape and holds it there", () => {
    const made = fakeAnimations(root);
    animate(root, "out");
    expect(made[0].keyframes).toEqual([{ transform: "none", opacity: "1" }, { transform: "translateX(-28px)", opacity: "0" }]);
    expect(made[0].options).toEqual({ duration: 200, easing: "ease", fill: "forwards" });
  });

  it("plays the frames it is handed in place of the shape", () => {
    const made = fakeAnimations(root);
    const keyframes = [{ opacity: "0" }, { opacity: "1" }];
    animate(root, "fade", { keyframes });
    expect(made[0].keyframes).toBe(keyframes);
  });

  it("replaces the move running on the same element, and tells only the last one's end", () => {
    const made = fakeAnimations(root);
    const first = vi.fn();
    const second = vi.fn();
    animate(root, "in", { onDone: first });
    animate(root, "pop", { onDone: second });
    expect(made[0].cancel).toHaveBeenCalledTimes(1);
    expect(made[1].cancel).not.toHaveBeenCalled();
    made[1].finish();
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    animate(root, "in");
    expect(made[1].cancel).not.toHaveBeenCalled();
  });

  it("takes a leave that has ended off the element before the next move: it was still holding its end", () => {
    const made = fakeAnimations(root);
    animate(root, "out");
    made[0].finish();
    animate(root, "in");
    expect(made[0].cancel).toHaveBeenCalledTimes(1);
    made[1].finish();
    animate(root, "leave");
    made[2].finish();
    root.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    flipPlay(flipSnap([root]), [root]);
    expect(made[2].cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the system asks for less motion", () => systemAsksForLess(true)],
    ["the page is stamped data-rm", () => root.setAttribute("data-rm", "1")],
  ])("ends a leave where it would have ended, at once, when %s", (_when, arrange) => {
    const made = fakeAnimations(root);
    arrange();
    const onDone = vi.fn();
    expect(animate(root, "out", { onDone })).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
    expect(made[0].keyframes[1].opacity).toBe("0");
    expect(made[0].options).toEqual({ duration: 0, fill: "forwards" });
    animate(root, "in");
    expect(made[0].cancel).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
  });

  it.each([
    ["the system asks for less motion", () => systemAsksForLess(true)],
    ["the page is stamped data-rm", () => root.setAttribute("data-rm", "1")],
  ])("plays nothing and is done at once when %s", (_when, arrange) => {
    const made = fakeAnimations(root);
    animate(root, "in");
    arrange();
    const onDone = vi.fn();
    expect(animate(root, "pop", { onDone })).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0].cancel).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("plays nothing for a role whose time is 0", () => {
    const made = fakeAnimations(root);
    const onDone = vi.fn();
    expect(animate(root, "fold", { onDone })).toBeNull();
    expect(made).toHaveLength(0);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("rows closing a gap", () => {
  const at = (el: Element, left: number, top: number) => {
    el.getBoundingClientRect = () => ({ left, top }) as DOMRect;
  };
  const row = () => {
    const el = document.body.appendChild(document.createElement("div"));
    for (const token of ["--d-move", "--e-move", "--m-time"]) el.style.setProperty(token, getComputedStyle(root).getPropertyValue(token));
    return el;
  };

  it("moves each row from where it stood to where it stands, on the travel tokens", () => {
    const [moved, still, fresh] = [row(), row(), row()];
    const made = [moved, still, fresh].map(fakeAnimations);
    at(moved, 0, 144);
    at(still, 0, 72);
    const before = flipSnap([moved, still]);
    at(moved, 0, 72);
    at(fresh, 0, 144);
    flipPlay(before, [moved, still, fresh]);
    expect(made.map((m) => m.length)).toEqual([1, 0, 0]);
    expect(made[0][0].keyframes).toEqual([{ transform: "translate(0px, 72px)" }, { transform: "none" }]);
    expect(made[0][0].options).toEqual({ duration: 260, easing: "cubic-bezier(.16,1,.3,1)", fill: "none" });
  });

  it("measures the way in the page's own px when a text size is stamped", () => {
    const el = row();
    const made = fakeAnimations(el);
    root.style.setProperty("--ui-zoom", "1.25");
    at(el, 0, 180);
    const before = flipSnap([el]);
    at(el, 0, 90);
    flipPlay(before, [el]);
    expect(made[0].keyframes[0]).toEqual({ transform: "translate(0px, 72px)" });
  });

  it("leaves every row where it stands under reduced motion, and stops a move that was running", () => {
    const el = row();
    const made = fakeAnimations(el);
    at(el, 0, 144);
    const before = flipSnap([el]);
    at(el, 0, 72);
    flipPlay(before, [el]);
    systemAsksForLess(true);
    flipPlay(before, [el]);
    expect(made).toHaveLength(1);
    expect(made[0].cancel).toHaveBeenCalledTimes(1);
  });
});
