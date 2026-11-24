/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { scrollProgrammatically, stampLive } from "@ohmail/app-logic/session/programmatic-scroll";

/**
 * THE STAMP OUTLIVES ANY TASK, IN REAL TIME. The browser sends a programmatic write's `scroll`
 * event in the next frame, so a task longer than any clock window between the write and that frame
 * let the first round's 100 ms stamp expire and the scroll read as the person's. Real timers here:
 * a 150 ms busy task after the write, the stamp still live; two animation frames later, gone.
 * Mutation: clear the stamp on a 100 ms timer instead — the first assertion goes red.
 */
const el = (): HTMLDivElement => {
  const d = document.createElement("div");
  let top = 0;
  Object.defineProperty(d, "scrollTop", { get: () => top, set: (v: number) => { top = v; } });
  document.body.appendChild(d);
  return d;
};
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

describe("the programmatic stamp is the frame's", () => {
  it("survives a 150 ms task after the write and clears two frames later", async () => {
    const sc = el();
    scrollProgrammatically(sc, 640);
    const end = performance.now() + 150;
    while (performance.now() < end) { /* the long task: a heavy body's parse */ }
    expect(stampLive(sc), "inside the task, the write's scroll event is still to come").toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(stampLive(sc), "the scroll event's turn: still stamped").toBe(true);
    await frame(); await frame(); await frame();
    expect(stampLive(sc)).toBe(false);
  });
  it("a value off the stamped one is not stamped", () => {
    const sc = el();
    scrollProgrammatically(sc, 640);
    sc.scrollTop = 900;
    expect(stampLive(sc)).toBe(false);
  });
});
