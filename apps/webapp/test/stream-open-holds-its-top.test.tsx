/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { HOLD_QUIET_MS, StreamCardToggled, StreamShell, type StreamHandle } from "../app/shell/StreamShell";
import { StreamCardMemo } from "../app/shell/StreamCardMemo";

/**
 * A CARD THE READER OPENS MID-SCROLL MOVES NOTHING ABOVE IT — its own top included.
 *
 * The hold loop anchored on the first card whose top is inside the port, so a card straddling the
 * top edge was never the anchor: opening it held the card BELOW and pushed the opened card up by
 * its whole growth (measured in Chromium by a browser rig:
 * 110–5 303px at 390, 164–1 374px at 1440). The browser half lives in that rig; this file pins the
 * rule on the loop with stubbed geometry, and the wiring that tells the loop BEFORE the card moves.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let roots: Root[] = [];
let pending = new Map<number, FrameRequestCallback>();
let nextHandle = 1;
let clock = 1_000_000;

async function drainFrames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    const due = [...pending.values()];
    pending = new Map();
    await act(async () => { for (const cb of due) cb(clock); });
    clock += 16;
  }
}

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, cb);
    return handle;
  };
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (handle: number) => { pending.delete(handle); };
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/**
 * Four cards in content space and a 600px port. `c1` is tall, so `scrollTop` can sit deep enough
 * for `c2` to straddle the port's top edge; growing a card moves every card below it.
 */
async function mountStream(scrollTop0: number, heights: Record<string, number>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  let toggled: (sid: string, open: boolean) => void = () => {};
  function Probe() {
    toggled = React.useContext(StreamCardToggled);
    return null;
  }
  const ids = ["c1", "c2", "c3", "c4"];
  const handle = React.createRef<StreamHandle>();
  await act(async () => {
    root.render(h(StreamShell, {
      ref: handle,
      ariaLabel: "stream", onCurrentChange: () => {}, onSeen: () => {}, contentKey: 1,
      children: [h(Probe, { key: "probe" }), ...ids.map((sid) => h("div", { className: "scast", "data-sid": sid, key: sid }))],
    }));
  });
  const el = container.querySelector<HTMLElement>(".stream")!;
  let scrollTop = scrollTop0;
  const scrollTos: number[] = [];
  const topOf = (sid: string) => ids.slice(0, ids.indexOf(sid)).reduce((y, s) => y + heights[s]!, 0);
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => ids.reduce((y, s) => y + heights[s]!, 0) });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = Math.max(0, v); } });
  el.getBoundingClientRect = () => rect(0, 600);
  const cards = [...container.querySelectorAll<HTMLElement>(".scast")];
  for (const c of cards) c.getBoundingClientRect = () => rect(topOf(c.dataset.sid!) - scrollTop, heights[c.dataset.sid!]!);
  el.scrollTo = ((opts: ScrollToOptions) => { scrollTos.push(opts.top ?? 0); scrollTop = Math.max(0, opts.top ?? 0); }) as typeof el.scrollTo;
  await drainFrames(2); // the loop takes its anchor from the resting geometry
  const card = (sid: string) => cards.find((c) => c.dataset.sid === sid)!;
  return {
    scrollTos,
    handle,
    /** The reader's own scroll. */
    async scroll(top: number) {
      await act(async () => { scrollTop = top; el.dispatchEvent(new Event("scroll")); });
      await drainFrames(2);
    },
    /** Where a card sits in the port, as the reader sees it. */
    top: (sid: string) => card(sid).getBoundingClientRect().top,
    /** The press: the stream is told first, then the card changes height and says so in the DOM. */
    async press(sid: string, open: boolean, height: number, cls = open ? "scast open" : "scast") {
      await act(async () => { toggled(sid, open); });
      await act(async () => {
        heights[sid] = height;
        card(sid).setAttribute("class", cls);
        await Promise.resolve();
      });
      await drainFrames(4);
    },
    /** The card changes on its own — a body arriving — with the time that passed before it. */
    async change(sid: string, height: number, cls: string, afterMs: number) {
      clock += afterMs;
      await act(async () => {
        heights[sid] = height;
        card(sid).setAttribute("class", cls);
        await Promise.resolve();
      });
      await drainFrames(4);
    },
  };
}

describe("a card opened while it straddles the port's top edge", () => {
  it("keeps its own top where it was — the growth goes below, nothing above moves", async () => {
    // c2 spans content 2000..2300 and the port starts at 2100: 100px of it above the edge.
    const s = await mountStream(2100, { c1: 2000, c2: 300, c3: 300, c4: 300 });
    expect(s.top("c2")).toBe(-100);
    await s.press("c2", true, 1300);
    expect(s.top("c2"), "the opened card's top did not move").toBe(-100);
    expect(s.scrollTos, "and the stream wrote no correction for its growth").toEqual([]);
    expect(s.top("c3"), "the card below moved down by the growth, which is the growth").toBe(1200);
  });

  it("a close re-anchors BELOW it, so the pill under the pointer stays where it was", async () => {
    // Open, read down to the card's end (its pill in the port, 300px down), close — all inside
    // the window the open is held in, so a close that kept the opened anchor would show here.
    const s = await mountStream(2100, { c1: 2000, c2: 300, c3: 300, c4: 300 });
    await s.press("c2", true, 1300);
    await s.scroll(3000);
    expect(s.top("c2")).toBe(-1000);
    expect(s.top("c3"), "c2's foot, where its pill sits").toBe(300);
    await s.press("c2", false, 300);
    expect(s.top("c3"), "the card below the closed one held its place").toBe(300);
    expect(s.top("c2"), "and the closed card ends where it ended").toBe(0);
  });

  it("A CARD ENTIRELY ABOVE THE PORT that opens is still compensated — the reader never saw it", async () => {
    // The positive control for the old rule: c1 ends at 2000 and the port starts at 2100, so it
    // is wholly above. Its growth must not move what is on screen.
    const s = await mountStream(2100, { c1: 2000, c2: 300, c3: 300, c4: 300 });
    const before = s.top("c3");
    await s.press("c1", true, 2400);
    expect(s.top("c3"), "the card on screen held").toBe(before);
    expect(s.scrollTos.at(-1), "the growth was absorbed by the stream").toBe(2500);
  });

  it("a card opened before its body arrived holds its top for as long as the body is on its way", async () => {
    // Opened as a snippet (`pend`), then nothing moves for longer than the quiet window, then the
    // body lands and the card grows: that growth is still the open's, so it goes below.
    const s = await mountStream(2100, { c1: 2000, c2: 300, c3: 300, c4: 300 });
    await s.press("c2", true, 400, "scast pend open");
    await s.change("c2", 400, "scast pend open", HOLD_QUIET_MS * 2);
    await s.change("c2", 1400, "scast viewer open", HOLD_QUIET_MS * 2);
    expect(s.top("c2"), "the late body grew the card below its top").toBe(-100);
    expect(s.scrollTos).toEqual([]);
  });

  it("a card opened fully inside the port changes nothing above it either", async () => {
    const s = await mountStream(2000, { c1: 2000, c2: 300, c3: 300, c4: 300 });
    expect(s.top("c2")).toBe(0);
    await s.press("c2", true, 900);
    expect(s.top("c2")).toBe(0);
    expect(s.scrollTos).toEqual([]);
  });
});

/* ── THE WIRING: the card tells the stream BEFORE it changes ─────────────────────────────── */

const ISO = "2026-08-04T09:00:00.000Z";
const message = {
  id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "subject", from: { name: "Sender", address: "s@x.invalid" }, to: [], cc: [], date: ISO,
  folder: "INBOX", snippet: "snippet", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
} as unknown as EngineMessage;

describe("StreamCardMemo tells the stream first", () => {
  it("calls the stream's witness from the press, while the card is still closed, then the view", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const calls: string[] = [];
    const witness = (sid: string, open: boolean) => {
      const open0 = container.querySelector(".scast")!.classList.contains("open");
      calls.push(`stream ${sid} ${open} (card open before: ${open0})`);
    };
    const onToggle = (id: string, open: boolean) => { calls.push(`view ${id} ${open}`); };
    await act(async () => {
      const card = h(StreamCardMemo, {
        m: message, now: new Date(ISO), current: false, expanded: false, viewer: true, unread: false,
        bodyText: "Two lines.\nOf text.", bodyState: "snippet", bodyHtml: null, bodyLoadedRemote: false,
        loadingLabel: "l", failedLabel: "f", withheldKey: "withheld", onReask: () => {},
        onSelect: () => {}, onToggle,
      });
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date(ISO),
        children: h(StreamCardToggled.Provider, { value: witness }, card),
      }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".sc-x")!.click(); });
    expect(calls).toEqual(["stream m1 true (card open before: false)", "view m1 true"]);
    expect(container.querySelector(".scast")!.classList.contains("open")).toBe(true);
  });
});

describe("the stream answers where a card is — what the verb bar waits on", () => {
  it("onScreen reads the port, and whenOffScreen fires once, on the scroll that takes the card out", async () => {
    const s = await mountStream(2100, { c1: 2000, c2: 300, c3: 300, c4: 300 });
    expect(s.handle.current!.onScreen("c2"), "straddling the top edge is on screen").toBe(true);
    expect(s.handle.current!.onScreen("c1"), "wholly above is not").toBe(false);
    let fired = 0;
    s.handle.current!.whenOffScreen("c2", () => { fired++; });
    await s.scroll(2250);
    expect(fired, "still 50px of it in the port").toBe(0);
    await s.scroll(2400);
    expect(fired, "out of the port").toBe(1);
    await s.scroll(2500);
    expect(fired, "once").toBe(1);
  });
});
