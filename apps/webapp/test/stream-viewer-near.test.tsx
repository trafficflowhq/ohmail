/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { letterBody } from "@ohmail/app/reader/body";
import { STREAM_CARD_ESTIMATE_PX, openingCount } from "@ohmail/app-logic/lists/stream-window";
import { NEAR_SEED } from "@ohmail/app-logic/lists/stream-near";

/**
 * A CARD BUILDS ITS RENDERED VIEWER ONLY NEAR THE SCREEN (`stream-near.ts`, the stream card's viewer in `packages/app/src/stream`).
 *
 * A switch into News mounted a viewer — a sanitize pass and a framed document — for every mounted
 * card: forty-five frames at entry over a large mirror. Now the entry mounts one screen of cards
 * (`stream-window.ts`), each near by construction, and a card further down shows its text until the
 * stream's lookahead reports it; an open card and the cursor's keep theirs. The lookahead is a
 * SIGNAL: Receipts takes it and still fetches nothing on a scroll, Reads' fetch on approach stays
 * once per id.
 *
 * jsdom has no layout; the window is moved through the same reads a browser answers (as
 * `stream-mount-window.test.tsx` does) and the lookahead is a stubbed IntersectionObserver whose
 * callback the test calls. Mutations watched red: render the viewer whatever `viewer` says (the
 * deep-window row); let the pump take a card while the stream flies (the flight row); fetch on `onApproach` (the Receipts row); fire `onNear` again for an id it
 * already reported (the Reads row); seed the near set with the whole opening slice, or let the
 * pump add more than one per frame (the per-frame row); grow the lookahead before the cards are
 * drawn (the lookahead row).
 */
const ISO = "2026-08-04T09:00:00.000Z";
const N = 400;
const HTML = '<table width="600" cellpadding="0"><tr><td><h1>Designed</h1><p>copy</p></td></tr></table>';

const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The stubbed lookahead: the near observer is the one with a viewport of margin each way. */
class FakeIO {
  static near: FakeIO[] = [];
  observed = new Set<Element>();
  constructor(public cb: (entries: Partial<IntersectionObserverEntry>[]) => void, opts?: IntersectionObserverInit) {
    if (opts?.rootMargin === "100% 0px") FakeIO.near.push(this);
  }
  observe(el: Element): void { this.observed.add(el); }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
}

/** The lookahead reports these cards, as the browser's would once they come within a viewport. */
async function approach(host: HTMLElement, ids: string[]): Promise<void> {
  const io = FakeIO.near.at(-1)!;
  const entries = ids.map((id) => ({
    isIntersecting: true,
    target: host.querySelector(`[data-stream-item="${id}"]`)!,
  }));
  await act(async () => { io.cb(entries); });
}

let restoreRect: (() => void) | null = null;

function mount(name: "News" | "Receipts", bodyAvailable = true) {
  const news = name === "News";
  const letters = Array.from({ length: N }, (_, i) => {
    const date = new Date(Date.parse(ISO) - i * 1000).toISOString();
    return (news ? issue : receipt)(`m${i}`, 1, {
      ...message(i),
      folder: news ? "ohmail/News" : "ohmail/Receipts",
      date,
      arrivedAt: date,
      body: undefined,
    });
  });
  const rows = bodyAvailable
    ? Object.fromEntries(letters.map(({ id }) => [
        `message_body:${id}`,
        { text: "copy", state: "ready", html: HTML, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null },
      ]))
    : {};
  const { mail } = mountStreamFrame({ at: news ? "#/reads" : "#/receipts", letters, readerBody: letterBody, rows });
  return { host: screen.getByRole("region", { name: `${name} stream` }), mail };
}

/** Give the stream a browser's geometry (the never-measured estimate per card), as the window test does. */
function armGeometry(host: HTMLElement, viewport: number): HTMLElement {
  const scroller = host.matches("[data-reading-scroll]") ? host
    : host.querySelector<HTMLElement>("[data-reading-scroll]")!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: N * STREAM_CARD_ESTIMATE_PX });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: viewport });
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: viewport, height: viewport } as DOMRect);
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const sid = this.dataset?.streamWindowItem ?? this.dataset?.streamItem;
    if (sid) {
      const y = Number(sid.slice(1)) * STREAM_CARD_ESTIMATE_PX - top;
      return { top: y, bottom: y + STREAM_CARD_ESTIMATE_PX, height: STREAM_CARD_ESTIMATE_PX } as DOMRect;
    }
    return original.call(this);
  };
  restoreRect = () => { proto.getBoundingClientRect = original; };
  return scroller;
}

const scrollTo = async (scroller: HTMLElement, px: number): Promise<void> => {
  await act(async () => {
    scroller.scrollTop = px;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
};

const viewers = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<HTMLElement>("[data-stream-item]")].filter((c) => c.querySelector("iframe")).map((c) => c.dataset.streamItem!);
const mounted = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<HTMLElement>("[data-stream-item]")].map((c) => c.dataset.streamItem!);

beforeEach(() => {
  FakeIO.near = [];
  vi.stubGlobal("IntersectionObserver", FakeIO);
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  });
  (globalThis as unknown as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };
  (HTMLElement.prototype as unknown as { scrollTo?: () => void }).scrollTo ??= () => {};
  (HTMLElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => {};
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  restoreRect?.();
  restoreRect = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const name of ["News", "Receipts"] as const) {
  describe(`${name}: a viewer is built only near the screen`, () => {
    it("the entry mounts one screen of cards, every one near and so a viewer", async () => {
      const { host } = mount(name);
      const opening = openingCount(window.innerHeight);
      expect(mounted(host)).toHaveLength(opening);
      expect(mounted(host).length).toBeLessThanOrEqual(Math.ceil(window.innerHeight / STREAM_CARD_ESTIMATE_PX) + 2);
      expect(viewers(host)).toEqual(mounted(host));
    });

    it("the viewers join one per painted frame, the top of the slice first", async () => {
      /* A laid-out stream, so the arming and the pump wait for painted frames. */
      vi.useFakeTimers();
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return (this.matches("[data-reading-scroll]") ? [{}] : []) as unknown as DOMRectList;
      });
      const { host } = mount(name);
      const steps: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        await act(async () => { vi.advanceTimersByTime(17); });
        steps.push(viewers(host).length);
      }
      vi.useRealTimers();
      const opening = openingCount(window.innerHeight);
      expect(steps.at(-1), "control: every opening card built its viewer in the end").toBe(opening);
      expect(viewers(host)).toEqual(mounted(host).slice(0, opening));
      let last = 0;
      for (const n of steps) {
        expect(n - last, `one frame added ${n - last} framed documents (${steps.join(",")})`).toBeLessThanOrEqual(last === 0 ? NEAR_SEED : 1);
        last = n;
      }
    });

    it("the lookahead lands a frame after the opening slice, never in its commit", async () => {
      vi.useFakeTimers();
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return (this.matches("[data-reading-scroll]") ? [{}] : []) as unknown as DOMRectList;
      });
      const { host } = mount(name);
      armGeometry(host, 800);
      const steps: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        await act(async () => { vi.advanceTimersByTime(17); });
        steps.push(mounted(host).length);
      }
      vi.useRealTimers();
      const first = steps.find((n) => n > 0);
      expect(first, `the cards' first commit carried the lookahead (${steps.join(",")})`).toBe(openingCount(window.innerHeight));
      expect(Math.max(...steps), "control: the lookahead grew").toBeGreaterThan(openingCount(window.innerHeight));
    });

    it("no viewer joins while the stream flies, and the queue moves again where it stops", async () => {
      vi.useFakeTimers();
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return (this.matches("[data-reading-scroll]") ? [{}] : []) as unknown as DOMRectList;
      });
      const frame = () => act(async () => { vi.advanceTimersByTime(17); });
      try {
        const { host } = mount(name);
        const scroller = armGeometry(host, 800);
        await frame(); // the window samples the resting stream once
        await frame();
        const before = viewers(host);
        expect(before.length, "control: the opening slice is still joining").toBeLessThan(openingCount(window.innerHeight));
        let top = 0;
        for (let s = 1; s <= 8; s += 1) {
          top += 7000;
          await act(async () => {
            scroller.scrollTop = top;
            scroller.dispatchEvent(new Event("scroll"));
            vi.advanceTimersByTime(17);
          });
          expect(viewers(host), `a viewer joined or left at frame ${s} of the flight`).toEqual(before);
        }
        for (let i = 0; i < 3; i += 1) await frame();
        const rest = Math.floor(top / STREAM_CARD_ESTIMATE_PX);
        expect(mounted(host), "control: the window landed where the scroll stopped").toContain(`m${rest}`);
        await approach(host, [`m${rest}`, `m${rest + 1}`]);
        for (let i = 0; i < 4; i += 1) await frame();
        expect(viewers(host)).toEqual([`m${rest}`, `m${rest + 1}`]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("deep in the pile a mounted card shows its text until the lookahead reports it", async () => {
      const { host } = mount(name);
      const scroller = armGeometry(host, 800);
      await scrollTo(scroller, 300 * STREAM_CARD_ESTIMATE_PX);
      const deep = mounted(host);
      expect(deep.length, "control: the window moved and mounted the deep cards").toBeGreaterThan(openingCount(window.innerHeight));
      expect(deep[0]).not.toBe("m0");
      expect(viewers(host), "a card nobody approached built its viewer").toEqual([]);
      await approach(host, ["m300", "m301"]);
      expect(viewers(host)).toEqual(["m300", "m301"]);
      // An open card keeps a viewer wherever it is: the reader asked for it.
      const article = host.querySelector<HTMLElement>('[data-stream-item="m310"]')!;
      await act(async () => { fireEvent.click(within(article).getByRole("button", { name: "Expand" })); });
      expect(viewers(host)).toContain("m310");
    });
  });
}

describe("the lookahead is a signal, never a fetch", () => {
  it("Receipts' approach fetches nothing; only the cursor's card asks", async () => {
    const { host, mail } = mount("Receipts", false);
    const asked = mail.bodyAsks;
    const cursor = [...new Set(asked)];
    expect(cursor, "control: the cursor's card asks for its body").toEqual(["m0"]);
    await approach(host, mounted(host));
    expect([...new Set(asked)], "an approach fetched a body in Receipts").toEqual(cursor);
  });

  it("Reads fetches on approach, once per id however often the card comes near", async () => {
    const letters = Array.from({ length: N }, (_, i) =>
      issue(`m${i}`, 28 - i, { unread: false, body: undefined }),
    );
    const { mail } = mountStreamFrame({ at: "#/reads", letters });
    const stream = screen.getByRole("region", { name: "News stream" });
    const observer = FakeIO.near.at(-1)!;
    expect(observer).toBeDefined();
    const reportApproach = async (ids: string[]) => {
      const entries = ids.map((id) => {
        const target = stream.querySelector(`[data-stream-item="${id}"]`)!;
        expect(observer.observed.has(target), id).toBe(true);
        return { isIntersecting: true, target };
      });
      await act(async () => observer.cb(entries));
    };
    mail.bodyAsks.length = 0;
    await reportApproach(["m1", "m2"]);
    await reportApproach(["m1", "m2", "m3"]);
    expect(mail.bodyAsks).toEqual(["m1", "m2", "m3"]);
  });
});
