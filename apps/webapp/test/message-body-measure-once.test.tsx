/** @vitest-environment jsdom */
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@ohmail/ui";
import { MessageBody } from "../app/components/MessageBody";

/**
 * A FRAME IS MEASURED ONCE PER LOAD, AND AGAIN ONLY FOR A REAL CHANGE (`MessageBody.measure`).
 *
 * The probe — the frame shrunk to a constant, read, and set to the mail's height — is a forced
 * layout of the document. It ran on load, again from the loaded-key effect over the same state,
 * and again from the observer's first report; a pile shown again re-ran the effect and the
 * observer for every kept frame. Now the observer compares the sizes it reports with the ones the
 * last measurement left and probes only when they differ.
 *
 * jsdom lays nothing out, so the observer is a stand-in the test reports through, and a probe is
 * counted as a write of the 600px probe height to the frame's style (as `remote-images.test.tsx`
 * counts them). Mutations watched red: probe on every observer report (the unchanged rows); drop
 * the probe from the load (the first row); skip a report whose width moved (the width row).
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const HTML = '<table width="600" cellpadding="0"><tr><td><h1>Designed</h1><p>copy</p></td></tr></table>';

class FakeRO {
  static all: FakeRO[] = [];
  targets = new Set<Element>();
  constructor(public cb: (entries: ResizeObserverEntry[]) => void) { FakeRO.all.push(this); }
  observe(el: Element): void { this.targets.add(el); }
  unobserve(el: Element): void { this.targets.delete(el); }
  disconnect(): void { this.targets.clear(); FakeRO.all = FakeRO.all.filter((o) => o !== this); }
}

/** The observer reports every target at these sizes (border box, CSS px). */
async function report(size: (el: Element) => [number, number]): Promise<void> {
  for (const ro of [...FakeRO.all]) {
    const entries = [...ro.targets].map((target) => {
      const [w, hgt] = size(target);
      return { target, borderBoxSize: [{ inlineSize: w, blockSize: hgt }] } as unknown as ResizeObserverEntry;
    });
    await act(async () => { ro.cb(entries); });
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let heights: string[] = [];
let seen: MutationObserver | null = null;

const probes = (): number => {
  for (const r of seen!.takeRecords()) if (r.target instanceof HTMLIFrameElement) heights.push(r.oldValue ?? "");
  return heights.filter((v) => /height:\s*600px/.test(v)).length;
};

/** Count the measurement's layout reads off this frame's document — what a probe costs first. */
function countReads(frame: HTMLIFrameElement): () => number {
  let reads = 0;
  const root = frame.contentDocument!.documentElement;
  Object.defineProperty(root, "scrollWidth", { configurable: true, get: () => { reads += 1; return 0; } });
  return () => reads;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

beforeEach(() => {
  FakeRO.all = [];
  vi.stubGlobal("ResizeObserver", FakeRO);
  heights = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  seen = new MutationObserver((recs) => {
    for (const r of recs) if (r.target instanceof HTMLIFrameElement) heights.push(r.oldValue ?? "");
  });
  seen.observe(host, { subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true });
});

afterEach(async () => {
  seen?.disconnect();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.unstubAllGlobals();
});

describe("the frame is probed once per load", () => {
  it("the load probes once; the observer's first report and an unchanged one probe nothing", async () => {
    await act(async () => { root!.render(h(MessageBody, { text: "copy", html: HTML })); });
    await settle();
    expect(probes(), "the load did not probe the frame, or probed it twice").toBe(1);
    expect(FakeRO.all.length, "control: the observer was armed after the load").toBe(1);
    const reads = countReads(host!.querySelector("iframe")!);
    await report(() => [0, 0]); // what the measurement left: jsdom's zero box
    await report(() => [0, 0]);
    expect(probes(), "a report with nothing changed probed the frame").toBe(1);
    expect(reads(), "a report with nothing changed read the frame's layout").toBe(0);
  });

  it("a width that moved probes again", async () => {
    await act(async () => { root!.render(h(MessageBody, { text: "copy", html: HTML })); });
    await settle();
    expect(probes()).toBe(1);
    const frame = host!.querySelector("iframe")!;
    Object.defineProperty(frame, "clientWidth", { configurable: true, get: () => 520 });
    await report((el) => (el === frame.contentDocument?.body ? [0, 0] : [520, 0]));
    expect(probes(), "the column moved and the frame was not measured again").toBe(2);
  });

  it("a frame shown again under Activity probes nothing", async () => {
    const at = (mode: "visible" | "hidden") => h(Activity, { mode, children: h(MessageBody, { text: "copy", html: HTML }) });
    await act(async () => { root!.render(at("visible")); });
    await settle();
    expect(probes()).toBe(1);
    const reads = countReads(host!.querySelector("iframe")!);
    await act(async () => { root!.render(at("hidden")); });
    await act(async () => { root!.render(at("visible")); });
    await settle();
    expect(FakeRO.all.length, "control: the reveal armed the observer again").toBe(1);
    await report(() => [0, 0]);
    expect(probes(), "the reveal probed a frame whose document and column had not moved").toBe(1);
    expect(reads(), "the reveal read the layout of a frame nothing had moved").toBe(0);
  });
});

describe("the frame's document is touched only once it has loaded", () => {
  /* A mount used to write the dark attribute into the empty document every new frame starts
     with, before its own one loaded: a read of each frame's document per mount, for nothing.
     Mutation watched red: the dark effect back on `[dark, loadedKey, mail]` without the load check. */
  it("mounting reads no frame document before its load, and a flip still reaches the loaded one", async () => {
    const own = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentDocument")!;
    let reads = 0;
    let beforeLoad = -1;
    Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", {
      configurable: true,
      get(this: HTMLIFrameElement) { reads += 1; return own.get!.call(this); },
    });
    host!.addEventListener("load", () => { if (beforeLoad < 0) beforeLoad = reads; }, true);
    try {
      await act(async () => {
        root!.render(h(ThemeProvider, { defaultPreference: "dark", storageKey: null, children: h(MessageBody, { text: "copy", html: HTML }) }));
      });
      await settle();
      expect(beforeLoad, "control: the frame loaded").toBeGreaterThanOrEqual(0);
      expect(beforeLoad, "the frame's empty first document was read before its own loaded").toBe(0);
      const live = () => host!.querySelector("iframe")!.contentDocument!.documentElement.hasAttribute("data-ohmail-dark");
      const flip = async () => {
        const b = [...host!.querySelectorAll("button")].find((x) => /^(Original|Adapt)/.test(x.textContent ?? ""))!;
        await act(async () => { b.click(); });
      };
      await flip();
      expect(live(), "Original left the loaded document dark").toBe(false);
      await flip();
      expect(live(), "Adapt did not reach the loaded document").toBe(true);
    } finally {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", own);
    }
  });
});
