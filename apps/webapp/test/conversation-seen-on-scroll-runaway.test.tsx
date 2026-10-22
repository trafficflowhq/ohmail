/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { key, mountThread, msg, openTheRow, patches, settle } from "./fixtures/thread-read-shell.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * NOTHING IS READ IN A PREVIEW, IN THE SHIPPED SHELL — the class, guarded at the reader. A six-member
 * thread previewed with `j` lands on its newest, wholly on screen: the anchor, a ResizeObserver
 * tick, a bare `scroll` and ten seconds write nothing. A wheel in the column enters the visit, and
 * then what is on screen reads. A visit entered in one conversation does not carry into the next
 * one previewed. The reader is laid out by `fixtures/thread-layout.ts` (800px, panels 400 + 20).
 * Mutations: the entered gate dropped (the preview reads), the record kept across conversations
 * (the second one reads) — each red here.
 */

const observers: Array<() => void> = [];
let layout: ThreadLayout;
const col = (): HTMLElement => document.querySelector<HTMLElement>(".read-col")!;
const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
/** The app's own scroll: no input before it. */
const bareScroll = async (top: number): Promise<void> => {
  await act(async () => { layout.setScroll(top); });
};

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => {
  installShellEnv();
  layout = stubThreadLayout();
  window.location.hash = "#/ohbox";
  observers.length = 0;
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    constructor(private cb: () => void) { observers.push(() => this.cb()); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});
afterEach(async () => {
  layout.restore();
  await teardownShellEnv();
  delete (globalThis as Record<string, unknown>).ResizeObserver;
});

const SIX = ["p1", "p2", "p3", "p4", "p5", "p6"];
async function previewSix(): Promise<void> {
  await mountThread(SIX.map((id, i) => msg(id, i * 10)));
  await key("j");
  expect(document.querySelector('.read-col [aria-current="true"]')?.getAttribute("data-conv-id"), "landed at the newest").toBe("p6");
}

describe("nothing but a person's act enters a visit, and nothing is read before it", () => {
  it("in a preview the anchor, a ResizeObserver tick, a bare scroll and 10 s write nothing", async () => {
    await previewSix();
    await act(async () => { for (const tickObserver of observers) tickObserver(); });
    await bareScroll(layout.topOf("p5") - 10);
    await bareScroll(layout.topOf("p6") - 14);
    await tick(10_000);
    await settle();
    expect(glances(), "base: the dwell read p6").toEqual([]);
  }, 30_000);

  it("the control: a wheel in the column enters, and then each message whose top stays on screen reads", async () => {
    await previewSix();
    await layout.handScroll(layout.topOf("p6") - 14);
    await settle();
    await layout.passDwell();
    await settle();
    expect(glances()).toEqual([["p6"]]);
    await bareScroll(layout.topOf("p5") - 10);
    await settle();
    await layout.passDwell();
    await settle();
    expect(glances(), "entered: what comes on screen reads, however it got there").toEqual([["p6"], ["p5"]]);
    expect(col().querySelector('article.pm[data-conv-id="p5"]')?.hasAttribute("data-unseen")).toBe(false);
    expect(col().querySelector('article.pm[data-conv-id="p4"]')?.hasAttribute("data-unseen")).toBe(true);
  }, 30_000);

  it("a visit entered in one conversation does not carry into the next one previewed", async () => {
    const host = await mountThread([
      ...SIX.map((id, i) => msg(id, 100 + i * 10)),
      ...["q1", "q2", "q3"].map((id, i) => msg(id, i, { threadId: "U" })),
    ]);
    await openTheRow(host);
    await layout.passDwell();
    await settle();
    expect(glances(), "the click entered the first conversation").toEqual([["p6"]]);
    await key("j");
    expect(document.querySelector('.read-col [aria-current="true"]')?.getAttribute("data-conv-id"), "j moved to the second conversation").toBe("q3");
    await act(async () => { for (const tickObserver of observers) tickObserver(); });
    await bareScroll(100);
    await bareScroll(layout.topOf("q3") - 14);
    await tick(10_000);
    await settle();
    expect(glances(), "nothing in the second").toEqual([["p6"]]);
    expect(vi.isFakeTimers()).toBe(true);
  }, 30_000);
});
