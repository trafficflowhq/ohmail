/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, MessageBody, TagDTO, FeedPartition } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { ReadsView } from "../app/views/ReadsView";
import { ReceiptsView } from "../app/views/ReceiptsView";
import { KeymapProvider } from "../app/shell/keymap";
import { STREAM_CARD_ESTIMATE_PX, openingCount } from "../app/shell/stream-window";
import { NEAR_SEED } from "../app/shell/stream-near";

/**
 * A CARD BUILDS ITS RENDERED VIEWER ONLY NEAR THE SCREEN (`stream-near.ts`, `StreamCardMemo.viewer`).
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
const tags: TagDTO[] = [];
const HTML = '<table width="600" cellpadding="0"><tr><td><h1>Designed</h1><p>copy</p></td></tr></table>';

const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const fullBody = (): MessageBody =>
  ({ text: "copy", state: "full", html: HTML, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null } as unknown as MessageBody);

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
    target: host.querySelector(`.scast[data-sid="${id}"]`)!,
  }));
  await act(async () => { io.cb(entries); });
}

let roots: Root[] = [];
let restoreRect: (() => void) | null = null;

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>{node}</KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
  return host;
}

const reads = (hydrateBody: (id: string) => void = () => {}) => {
  const partition: FeedPartition = { waterline: null, fresh: Array.from({ length: N }, (_, i) => message(i)), seen: [], newCount: 0 };
  return (
    <ReadsView settled owed={false} partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
      aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
      bodyOf={fullBody} hydrateBody={hydrateBody} jumpTo={null} onJumped={() => {}} onAction={() => {}} />
  );
};

const receipts = (hydrateBody: (id: string) => void = () => {}) => (
  <ReceiptsView settled owed={false} messages={Array.from({ length: N }, (_, i) => message(i))} tags={tags} now={new Date(ISO)}
    cur={null} onCur={() => {}} unreadCount={0} isUnread={() => false} markSeen={() => {}}
    bodyOf={fullBody} hydrateBody={hydrateBody} jumpTo={null} onJumped={() => {}} onAction={() => {}} />
);

/** Give the stream a browser's geometry (the never-measured estimate per card), as the window test does. */
function armGeometry(host: HTMLElement, viewport: number): HTMLElement {
  const scroller = host.querySelector(".stream") as HTMLElement;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: viewport });
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: viewport, height: viewport } as DOMRect);
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const sid = this.dataset?.sid;
    if (sid && this.classList.contains("scast")) {
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
  [...host.querySelectorAll<HTMLElement>(".scast")].filter((c) => c.querySelector("iframe")).map((c) => c.dataset.sid!);
const mounted = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<HTMLElement>(".scast")].map((c) => c.dataset.sid!);

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
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  restoreRect?.();
  restoreRect = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const [name, view] of [["News", reads], ["Receipts", receipts]] as const) {
  describe(`${name}: a viewer is built only near the screen`, () => {
    it("the entry mounts one screen of cards, every one near and so a viewer", async () => {
      const host = await mount(view());
      const opening = openingCount(window.innerHeight);
      expect(mounted(host)).toHaveLength(opening);
      expect(mounted(host).length).toBeLessThanOrEqual(Math.ceil(window.innerHeight / STREAM_CARD_ESTIMATE_PX) + 2);
      expect(viewers(host)).toEqual(mounted(host));
    });

    it("the viewers join one per painted frame, the top of the slice first", async () => {
      /* A laid-out stream, so the arming and the pump wait for painted frames. */
      vi.useFakeTimers();
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return (this.classList.contains("stream") ? [{}] : []) as unknown as DOMRectList;
      });
      const host = await mount(view());
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
        return (this.classList.contains("stream") ? [{}] : []) as unknown as DOMRectList;
      });
      const host = await mount(view());
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
        return (this.classList.contains("stream") ? [{}] : []) as unknown as DOMRectList;
      });
      const frame = () => act(async () => { vi.advanceTimersByTime(17); });
      try {
        const host = await mount(view());
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
      const host = await mount(view());
      const scroller = armGeometry(host, 800);
      await scrollTo(scroller, 300 * STREAM_CARD_ESTIMATE_PX);
      const deep = mounted(host);
      expect(deep.length, "control: the window moved and mounted the deep cards").toBeGreaterThan(openingCount(window.innerHeight));
      expect(deep[0]).not.toBe("m0");
      expect(viewers(host), "a card nobody approached built its viewer").toEqual([]);
      await approach(host, ["m300", "m301"]);
      expect(viewers(host)).toEqual(["m300", "m301"]);
      // An open card keeps a viewer wherever it is: the reader asked for it.
      await act(async () => { host.querySelector<HTMLElement>('.scast[data-sid="m310"]')!.click(); });
      expect(viewers(host)).toContain("m310");
    });
  });
}

describe("the lookahead is a signal, never a fetch", () => {
  it("Receipts' approach fetches nothing; only the cursor's card asks", async () => {
    const asked: string[] = [];
    const host = await mount(receipts((id) => asked.push(id)));
    const cursor = [...new Set(asked)];
    expect(cursor, "control: the cursor's card asks for its body").toEqual(["m0"]);
    await approach(host, mounted(host));
    expect([...new Set(asked)], "an approach fetched a body in Receipts").toEqual(cursor);
  });

  it("Reads fetches on approach, once per id however often the card comes near", async () => {
    const asked: string[] = [];
    const host = await mount(reads((id) => asked.push(id)));
    asked.length = 0;
    await approach(host, ["m1", "m2"]);
    await approach(host, ["m1", "m2", "m3"]);
    expect(asked).toEqual(["m1", "m2", "m3"]);
  });
});
