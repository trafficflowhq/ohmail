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
import {
  STREAM_CARD_ESTIMATE_PX,
  STREAM_WINDOW_MAX,
  openingCount,
} from "../app/shell/stream-window";

/** The opening window jsdom gets: the window's height stands in for the column (no layout). */
const OPENING = (): number => openingCount(window.innerHeight);

/**
 * THE READING STREAM IS A SLIDING WINDOW, NOT A PILE AND NOT A PREFIX.
 *
 * Two generations of the same defect stand behind these tests. First the stream mounted the
 * whole pile on every switch (a long blocked main thread at a real account's
 * full-size pile). Then it mounted a growing PREFIX, which fixed the switch and made
 * scroll depth a permanent tax instead: measured over a generated pile of tens of thousands of messages in real
 * Chromium, a deep scroll held thousands of cards, tens of thousands of DOM nodes and a large heap in the DOM,
 * with the scroll-spy walking every one of them per frame — and a deep jump mounted everything
 * above its target in one commit.
 *
 * The invariant now: the mounted cards are a CONTIGUOUS window near the viewport, bounded by
 * `STREAM_WINDOW_MAX` wherever the reader is, with spacers reserving the height of everything
 * else. Cards left behind UNMOUNT — the assertion the prefix model could never make.
 *
 * jsdom has no layout, so the sampler's geometry is stubbed per element through the same reads
 * a browser answers (`clientHeight`, `scrollTop`, `getBoundingClientRect`), with every card at
 * the never-measured estimate — nothing about the derivation itself is mocked.
 */

const ISO = "2026-08-04T09:00:00.000Z";
const N = 5000;
const tags: TagDTO[] = [];

const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const body = (): MessageBody =>
  ({ text: "body", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null } as unknown as MessageBody);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

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

const cardIndices = (host: HTMLElement): number[] =>
  [...host.querySelectorAll(".scast[data-sid]")].map((n) =>
    Number((n.getAttribute("data-sid") ?? "m-1").slice(1)),
  );

/** A contiguous ascending run — the property the scroll-spy's top-to-bottom walk relies on. */
const expectContiguous = (idx: number[]): void => {
  for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe(idx[i - 1]! + 1);
};

const reads = (count: number, jumpTo: string | null = null) => {
  const fresh = Math.floor(count / 4);
  const freshRows = Array.from({ length: fresh }, (_, i) => message(i));
  const partition: FeedPartition = {
    waterline: null,
    fresh: freshRows,
    seen: Array.from({ length: count - fresh }, (_, i) => message(i + fresh)),
    newCount: freshRows.filter((m) => m.unread).length,
  };
  return (
    <ReadsView settled owed={false} partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
      aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
      bodyOf={body} hydrateBody={() => {}} jumpTo={jumpTo} onJumped={() => {}} onAction={() => {}} />
  );
};

const receipts = (count: number, jumpTo: string | null = null) => (
  <ReceiptsView settled owed={false} messages={Array.from({ length: count }, (_, i) => message(i))} tags={tags} now={new Date(ISO)}
    cur={null} onCur={() => {}} unreadCount={0} isUnread={() => false} markSeen={() => {}}
    bodyOf={body} hydrateBody={() => {}} jumpTo={jumpTo} onJumped={() => {}} onAction={() => {}} />
);

/**
 * Give the stream a browser's geometry: a viewport, a scroll position, and card rects that
 * follow the estimate model (card i's top is `i * estimate - scrollTop`). Every card that
 * MOUNTS during the test inherits the model through a prototype-level stub keyed on its
 * `data-sid`, so window moves re-stub themselves.
 */
function armGeometry(host: HTMLElement, viewport: number): HTMLElement {
  const scroller = host.querySelector(".stream") as HTMLElement;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: viewport });
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: viewport, height: viewport } as DOMRect);
  // Cards are <article>s — stub at the shared HTMLElement level so every card that ever
  // mounts inherits the model. The scroller keeps its own-property stub above.
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const sid = this.dataset?.sid;
    if (sid && this.classList.contains("scast")) {
      const i = Number(sid.slice(1));
      const y = i * STREAM_CARD_ESTIMATE_PX - top;
      return { top: y, bottom: y + STREAM_CARD_ESTIMATE_PX, height: STREAM_CARD_ESTIMATE_PX } as DOMRect;
    }
    return original.call(this);
  };
  restoreRect = () => { proto.getBoundingClientRect = original; };
  return scroller;
}
let restoreRect: (() => void) | null = null;

/** One jump, then the frames that let it land: a move past a viewport is a flight, and the window
 *  commits only once two frames have passed with no scroll. */
const scrollTo = async (scroller: HTMLElement, px: number): Promise<void> => {
  await act(async () => {
    scroller.scrollTop = px;
    scroller.dispatchEvent(new Event("scroll"));
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 40)); // the rAF-coalesced sampler
  });
};

/** One scroll event and one frame, on fake timers. */
const step = async (scroller: HTMLElement, px: number): Promise<void> => {
  await act(async () => {
    scroller.scrollTop = px;
    scroller.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(17);
  });
};
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { vi.advanceTimersByTime(17); });
};

describe("the reading stream is a sliding window", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    // jsdom ships no `CSS`; the post-commit scroll (`pendingScroll`) reaches
    // `StreamShell.scrollTo`, which escapes the id. Identity is enough — no selector is
    // matched against real layout here.
    (globalThis as unknown as { CSS?: { escape: (s: string) => string } }).CSS ??= {
      escape: (s: string) => s,
    };
    // jsdom has no layout and no element scrolling; the post-commit scroll only needs to not
    // throw — what is asserted is which cards are IN the DOM, never scroll geometry.
    (HTMLElement.prototype as unknown as { scrollTo?: () => void }).scrollTo ??= () => {};
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

  for (const [name, render] of [
    ["News", reads],
    ["Receipts", receipts],
  ] as const) {
    it(`${name}: a switch mounts one screen of cards at ${N}, not ${N}`, async () => {
      const host = await mount(render(N));
      const idx = cardIndices(host);
      // The load-bearing assertion — mapping the whole pile again makes this the pile's length,
      // and the old sixty-card opening run several screens of it.
      expect(idx.length).toBe(OPENING());
      expect(idx.length).toBeLessThanOrEqual(Math.ceil(window.innerHeight / STREAM_CARD_ESTIMATE_PX) + 2);
      expect(idx).toEqual(Array.from({ length: OPENING() }, (_, i) => i));
    });

    it(`${name}: under a Text size zoom the opening screen is counted in CSS px`, async () => {
      document.documentElement.style.setProperty("--ui-zoom", "2");
      try {
        const host = await mount(render(N));
        expect(cardIndices(host).length).toBe(openingCount(window.innerHeight / 2));
        expect(openingCount(window.innerHeight / 2)).toBeLessThan(OPENING());
      } finally {
        document.documentElement.style.removeProperty("--ui-zoom");
      }
    });

    it(`${name}: a short pile mounts whole, with no spacers`, async () => {
      const short = OPENING() - 1;
      const host = await mount(render(short));
      expect(cardIndices(host).length).toBe(short);
      expect(host.querySelector(".stream [data-stream-tail]")).toBeNull();
      expect(host.querySelector(".stream [data-stream-head]")).toBeNull();
    });

    it(`${name}: a pile past one screen reserves the rest as height, not cards`, async () => {
      const host = await mount(render(24));
      expect(cardIndices(host).length).toBe(OPENING());
      expect(host.querySelector(".stream [data-stream-head]")).toBeNull();
      const tail = host.querySelector<HTMLElement>(".stream [data-stream-tail]");
      expect(tail?.style.height).toBe(`${(24 - OPENING()) * STREAM_CARD_ESTIMATE_PX}px`);
    });

    it(`${name}: a jump beyond the window REPOSITIONS it around the target`, async () => {
      const host = await mount(render(N, "m3000"));
      // jumpTo schedules on a frame; let it run.
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      const idx = cardIndices(host);
      // The target is mounted — a scroll to a missing card is a silent no-op, so this is the
      // difference between "jump works" and "jump quietly does nothing".
      expect(idx).toContain(3000);
      // …and the jump did NOT mount the thousands of cards above it: the window MOVED.
      expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
      expect(idx[0]).toBeGreaterThan(2000);
      expectContiguous(idx);
      // Both sides of the pile are reserved height now, not DOM.
      expect(host.querySelector(".stream [data-stream-head]")).not.toBeNull();
      expect(host.querySelector(".stream [data-stream-tail]")).not.toBeNull();
    });
  }

  it("scrolling deep SLIDES the window: cards left behind unmount, the count stays bounded", async () => {
    const host = await mount(reads(N));
    const scroller = armGeometry(host, 800);

    // Deep into the pile: the window follows the viewport there.
    await scrollTo(scroller, 2500 * STREAM_CARD_ESTIMATE_PX);
    let idx = cardIndices(host);
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
    // The anti-prefix assertion: the opening cards are OUT of the DOM.
    expect(idx[0]).toBeGreaterThan(2000);
    expect(idx.some((i) => i >= 2500)).toBe(true);
    expectContiguous(idx);
    expect(host.querySelector(".stream [data-stream-head]")).not.toBeNull();

    // Half a pile further: still bounded, still near the viewport.
    await scrollTo(scroller, 4500 * STREAM_CARD_ESTIMATE_PX);
    idx = cardIndices(host);
    expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
    expect(idx[0]).toBeGreaterThan(4000);
    expectContiguous(idx);

    // And back to the top: the early cards return, the deep ones unmount.
    await scrollTo(scroller, 0);
    idx = cardIndices(host);
    expect(idx[0]).toBe(0);
    expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
    expectContiguous(idx);
  });

  it("the end-of-pile line is only claimed while the last card is mounted", async () => {
    const big = await mount(reads(N));
    expect(big.querySelector(".stream .tail-row")).toBeNull();
    const scroller = armGeometry(big, 800);
    await scrollTo(scroller, (N - 3) * STREAM_CARD_ESTIMATE_PX);
    expect(cardIndices(big)).toContain(N - 1);
    expect(big.querySelector(".stream .tail-row")).not.toBeNull();

    const small = await mount(reads(OPENING() - 1));
    expect(small.querySelector(".stream .tail-row")).not.toBeNull();
  });

  /* End in News: WebKit animates the stream over a dozen frames, each far past the mounted
     window. Re-committing on each one unmounted and mounted cards and their letter frames a
     dozen times inside the animation; the desktop's web process crashed there. */
  it("a flight holds the window and commits once, where it stops", async () => {
    vi.useFakeTimers();
    try {
      const host = await mount(reads(N));
      const scroller = armGeometry(host, 800);
      await frames(6); // the post-paint growth settles
      const held = cardIndices(host);
      let top = 0;
      for (let s = 1; s <= 12; s++) {
        top += 7000;
        await step(scroller, top);
        expect(cardIndices(host), `frame ${s} of the flight re-committed the window`).toEqual(held);
      }
      await frames(3);
      const idx = cardIndices(host);
      expect(idx).toContain(Math.floor(top / STREAM_CARD_ESTIMATE_PX));
      expect(idx.length).toBeLessThanOrEqual(STREAM_WINDOW_MAX);
      expectContiguous(idx);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hand scroll still moves the window while it scrolls", async () => {
    vi.useFakeTimers();
    try {
      const host = await mount(reads(N));
      const scroller = armGeometry(host, 800);
      await frames(6);
      for (let top = 300; top <= 12_000; top += 300) await step(scroller, top);
      // No rest frames: the window followed the hand.
      expect(cardIndices(host)).toContain(Math.floor(12_000 / STREAM_CARD_ESTIMATE_PX));
      expectContiguous(cardIndices(host));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the window under a pile that changes size", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    (globalThis as unknown as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };
    (HTMLElement.prototype as unknown as { scrollTo?: () => void }).scrollTo ??= () => {};
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("a view mounted MID-DRAIN grows its opening window as the pile arrives — no scroll needed", async () => {
    // The drain lands pages after the view is up: the first render sees a near-empty pile.
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const paint = async (count: number) =>
      act(() => {
        root.render(
          <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
            <KeymapProvider>{reads(count)}</KeymapProvider>
          </NextIntlClientProvider>,
        );
      });
    await paint(2);
    expect(cardIndices(host).length).toBe(2);
    // The pile fills in. Without a scroll event (there may never be one), the resting window
    // must widen to the opening size — a window pinned at two cards is a mailbox that looks
    // two messages long.
    await paint(N);
    expect(cardIndices(host).length).toBe(OPENING());
    expect(cardIndices(host)).toEqual(Array.from({ length: OPENING() }, (_, i) => i));
  });
});

describe("the never-measured estimate is DERIVED from the stylesheets, not conjoined by hand", () => {
  /**
   * `STREAM_CARD_ESTIMATE_PX` is the OUTER height of a card the browser has not rendered:
   * the `contain-intrinsic-size` box guess (app.css) plus `.scast`'s standing bottom margin
   * (stream.css) — two "taste" numbers in two files, and nothing else ties the three
   * together. This pin reddens the day either moves, so the estimate follows it instead of
   * silently drifting into the per-card spacer shortfall it exists to prevent.
   */
  it("equals the intrinsic-size guess plus the card's bottom margin, read from the CSS", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const app = readFileSync(join(__dirname, "..", "app", "app.css"), "utf8");
    const stream = readFileSync(
      join(__dirname, "..", "..", "..", "packages", "ui", "src", "composites", "stream.css"),
      "utf8",
    );
    /* THE GUESS IS A CUSTOM PROPERTY NOW, and its FALLBACK is what this constant twins.
       `contain-intrinsic-size: auto var(--sc-est, 200px)`: `StreamCard` writes `--sc-est` per
       card from that card's own subject and preview and from the column width the stream
       measured, so there is no single number for a card any more — but the fallback is what a
       card reserves where nothing could be measured (jsdom, and a first commit before the width
       is known), and it is the number this cache's own fallback has to mean the same thing as.
       Either spelling is accepted so the derivation keeps working whichever way the rule is
       written. */
    const box = /contain-intrinsic-size:\s*auto\s+(?:var\(--sc-est,\s*(\d+)px\)|(\d+)px)/.exec(app);
    const margin = /\.scast\{[^}]*margin:\s*0 auto (\d+)px/.exec(stream);
    expect(box, "app.css lost its contain-intrinsic-size guess").toBeTruthy();
    expect(margin, "stream.css lost .scast's bottom margin").toBeTruthy();
    expect(STREAM_CARD_ESTIMATE_PX).toBe(Number(box![1] ?? box![2]) + Number(margin![1]));
  });
});
