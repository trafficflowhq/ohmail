/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWindowFacts, fragmentAddress, postureWindow } from "@ohmail/app/host/browser";
import { NONE, type FoldFeature, type FoldReading } from "../../src/host/index.js";
import { fakeWindow, movable } from "../support/fake-window.js";

/** The browser shells' answers to the frame's device keys: the fragment of the address bar and the window. */

afterEach(() => {
  window.history.replaceState(null, "", "#");
});

describe("the fragment as the frame's address", () => {
  it("reads the fragment, and a push and a replace each reach a subscriber", async () => {
    const address = fragmentAddress(window);
    const heard = vi.fn();
    const stop = address.subscribe(heard);
    address.write("#/reads", "replace");
    expect(address.read()).toBe("#/reads");
    expect(heard).toHaveBeenCalledTimes(1);
    const length = window.history.length;
    address.write("#/reads/m/42", "push");
    await new Promise((r) => setTimeout(r, 0));
    expect(address.read()).toBe("#/reads/m/42");
    expect(window.history.length).toBe(length + 1);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    address.write("#/triage", "replace");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("writes nothing and says nothing for the fragment that already stands", () => {
    const address = fragmentAddress(window);
    address.write("#/compose", "replace");
    const heard = vi.fn();
    address.subscribe(heard);
    address.write("#/compose", "replace");
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("the window as the frame's window", () => {
  it("reads the size and the pointer, keeps one object while nothing moved, and hears a resize", () => {
    const facts = browserWindowFacts(window);
    const first = facts.read();
    expect(first).toMatchObject({ width: window.innerWidth, height: window.innerHeight, posture: "flat" });
    expect(facts.read()).toBe(first);
    const heard = vi.fn();
    const stop = facts.subscribe(heard);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(facts.read().width).toBe(390);
    stop();
  });
});

describe("the window with its fold", () => {
  const upright = (x: number, state: FoldFeature["state"]): FoldReading => ({
    folds: [{ bounds: { x, y: 0, w: 0, h: 2145 }, state, orientation: "vertical", occlusion: "none" }],
    hasFold: true,
  });

  it("says book while a fold stands upright across a window of two columns, and flat when it goes", () => {
    const win = fakeWindow({
      width: 750,
      height: 800,
      pointer: "coarse",
      posture: "flat",
      reducedMotion: false,
    });
    const fold = movable<FoldReading>(upright(375, "flat"));
    const facts = postureWindow(win, fold);
    expect(facts.read().posture).toBe("book");
    expect(facts.read(), "one object while nothing moved").toBe(facts.read());
    const heard = vi.fn();
    const stop = facts.subscribe(heard);
    fold.set({ folds: [], hasFold: true });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(facts.read().posture).toBe("flat");
    win.resize(673);
    fold.set(upright(336.5, "half"));
    expect(facts.read()).toMatchObject({ width: 673, posture: "book" });
    stop();
  });

  it("is the window itself where the host has no fold", () => {
    const win = fakeWindow("phone");
    expect(postureWindow(win, NONE)).toBe(win);
  });
});
