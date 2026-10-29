/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { useOhboxVisitMark } from "../app/shell/ohbox-visit";

/**
 * THE OHBOX VISIT ENDS WHEN THE PERSON LEAVES IT — a switch to another pile, the tab going hidden,
 * the page unloading — and only then does the where-line's mark move. Opening a message keeps the
 * Ohbox open; a visit nobody saw and the demo write nothing; nothing resets the count mid-visit.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

async function setVisibility(v: DocumentVisibilityState): Promise<void> {
  visibility = v;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

let marks = 0;
const engine = { markOhboxVisit: async () => { marks++; return true; } };

function Probe({ open, eng }: { open: boolean; eng: typeof engine | null }) {
  useOhboxVisitMark(eng, open);
  return null;
}

let root: Root | null = null;
async function draw(open: boolean, eng: typeof engine | null = engine): Promise<void> {
  if (!root) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => { root!.render(h(React.StrictMode, null, h(Probe, { open, eng }))); });
}

beforeEach(() => { marks = 0; visibility = "visible"; });
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

describe("a visit ends, and writes once", () => {
  it("on a switch to another pile", async () => {
    await draw(true);
    expect(marks).toBe(0);
    await draw(false);
    expect(marks).toBe(1);
    await draw(false);
    expect(marks).toBe(1);
  });

  it("on a switch, once the switch's frame has painted and not inside it", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => { frames.delete(n); });
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ top: 0, height: 900 }] as unknown as DOMRectList);
    await draw(true);
    await draw(false);
    expect(marks, "the mark was written in the switch's own frame").toBe(0);
    await act(async () => {
      const due = [...frames.values()];
      frames.clear();
      for (const f of due) f(0);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(marks).toBe(1);
  });

  it("when the tab is hidden, and again after the next visible spell", async () => {
    await draw(true);
    await setVisibility("hidden");
    expect(marks).toBe(1);
    await setVisibility("visible");
    expect(marks).toBe(1);
    await setVisibility("hidden");
    expect(marks).toBe(2);
  });

  it("when the page unloads", async () => {
    await draw(true);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(marks).toBe(1);
  });
});

describe("what is not a leave", () => {
  it("re-rendering the open Ohbox (a message opened, new mail arriving) writes nothing", async () => {
    await draw(true);
    for (let i = 0; i < 3; i++) await draw(true);
    expect(marks).toBe(0);
  });

  it("a visit that was never visible writes nothing", async () => {
    visibility = "hidden";
    await draw(true);
    await draw(false);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(marks).toBe(0);
  });

  it("the demo writes nothing", async () => {
    await draw(false, null);
    await draw(false, null);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(marks).toBe(0);
  });

  it("an unmount (a sign-out) writes nothing", async () => {
    await draw(true);
    await act(async () => { root!.unmount(); });
    root = null;
    expect(marks).toBe(0);
  });
});

describe("the shell wires it", () => {
  it("open only on the live Ohbox", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    expect(shell).toMatch(/useOhboxVisitMark\(demo \? null : engine, !demo && effectiveView === "ohbox"\)/);
  });
});
