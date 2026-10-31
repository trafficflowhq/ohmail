/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, FeedPartition, MessageBody, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { openTargetFor, readerMessageFor } from "../app/shell/AppShell";
import { StreamShell, type StreamHandle, type StreamLeaveState } from "../app/shell/StreamShell";
import { ReadsView } from "../app/views/ReadsView";
import { ReceiptsView } from "../app/views/ReceiptsView";
import { KeymapProvider, useKeyBindings } from "../app/shell/keymap";
import { deleteKeyBindings } from "../app/shell/delete-undo";

/**
 * ═══ CLICKING A SEARCH RESULT OPENS THAT MESSAGE ════════════════════════════════════════════
 *
 * Reported live: a search for a July message rendered its hit, and clicking it navigated to
 * Reads and "scrolled to a position where there is no message". Three separate mechanisms sat
 * behind that one sentence, and each is a case below.
 *
 * ── 1. THE LANDING WAS AIMED AT AN ESTIMATE ─────────────────────────────────────────────────
 *
 * The mounted run DID extend through the target (`stream-window.ts`'s `ensure` — the case
 * `stream-mount-window.test.tsx` already pins). What failed was the scroll. Stream cards carry
 * `content-visibility: auto` with `contain-intrinsic-size: auto 200px` (`app.css`), so a mounted
 * card the reader has never approached has a box at the 200px guess and no layout; a one-shot
 * `scrollTo(card.top)` therefore aims at a sum of guesses, and every card the flight passes swaps
 * its guess for its real height while the destination offset stays fixed.
 *
 * Measured in a real Chromium against `ReadsView` with a long pile, jumping to a card deep in it:
 * the stream settled **18 301px short**, with m319–m322 on screen and the requested card 80 cards
 * below the fold, and it never arrived. With the anchored landing the same jump parks the target
 * 14px below the top of the scrollport — the reading line — in one frame.
 *
 * jsdom has no layout, so the drift is driven here through stubbed geometry that models exactly
 * that mechanism: a card's height is the guess until the scroller has been near it, and its real
 * height afterwards. What runs is the real `scrollTo`.
 *
 * ── 2. ARRIVING IS NOT OPENING ──────────────────────────────────────────────────────────────
 *
 * A jump set the cursor. The card stayed collapsed, so the message the reader clicked was a
 * two-line snippet among hundreds of identical ones. A jump from outside the pile now opens the
 * landed card the way a click opens it, and a step INSIDE the pile (j/k, an adjacent row) still
 * only moves the cursor.
 *
 * ── 3. A HIT CAN NAME A MESSAGE NO PILE HOLDS ───────────────────────────────────────────────
 *
 * `GET /search` answers over the whole archive; the mirror is a window over it. A hit for a row
 * this device does not hold routed by the folder on the wire item, so the shell navigated to Reads
 * and set a cursor to an id no card and no row carried — the scroll-to-nowhere with no windowing
 * involved at all. Routing now asks whether the pile HOLDS the message and falls to the reader
 * when it does not, and the reader can show the row the opener carried in.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-08-04T09:00:00.000Z";
const Activity = Reflect.get(React, "Activity") as React.ComponentType<{ mode: string; children?: React.ReactNode }>;

const msg = (over: Partial<EngineMessage> = {}): EngineMessage =>
  ({
    id: "m-1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "s", from: { name: "Lena", address: "lena@example.invalid" },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: "snip", unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
    remoteContent: "none", updatedAt: ISO,
    ...over,
  }) as unknown as EngineMessage;

const noRow = (): string | null => null;

/* ════════════════════════════════════════════════════════════════════════════════════════════
   1. THE DECISION: a pile that does not hold the message is never named
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("the decision: a hit is never sent to a pile that does not hold it", () => {
  const M = "m-1";
  const holdsNothing = () => false;
  const holdsEverything = () => true;

  it("a Reads hit the Reads pile does not hold opens the READER, not the stream", () => {
    // The archive-only case, which is the one the reader met live: the wire item says
    // `ohmail/News`, the mirror has no row, and navigating to Reads leaves them looking at a
    // pile the message is not in. Drop the `holds` consultation and this goes back to
    // `{ kind: "stream" }` — the scroll-to-nowhere.
    expect(
      openTargetFor(msg({ folder: "ohmail/News" }), false, noRow, undefined, undefined, holdsNothing),
    ).toEqual({ kind: "reader", id: M });
  });

  it("a Receipts hit the Receipts pile does not hold opens the READER", () => {
    expect(
      openTargetFor(msg({ folder: "ohmail/Receipts" }), false, noRow, undefined, undefined, holdsNothing),
    ).toEqual({ kind: "reader", id: M });
  });

  it("an Ohbox hit the Ohbox does not hold opens the READER — the split pane would show nothing", () => {
    // `selectedOhbox` is a `find` over the pile, so an id it does not contain resolves to null
    // and the reading column renders its empty state. Same defect, quieter surface.
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, undefined, undefined, holdsNothing),
    ).toEqual({ kind: "reader", id: M });
  });

  it("the pile that DOES hold it is still where the message opens — no regression", () => {
    // The ordinary case, which is the majority of every search: unchanged.
    expect(
      openTargetFor(msg({ folder: "ohmail/News" }), false, noRow, undefined, undefined, holdsEverything),
    ).toEqual({ kind: "stream", view: "reads", id: M });
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, undefined, undefined, holdsEverything),
    ).toEqual({ kind: "ohbox", id: M, reader: false });
  });

  it("with no pile knowledge at all it routes exactly as it did before — folder, then place", () => {
    // A harness mounted without a shell passes no predicate, and must not be told every message
    // is homeless. `undefined` means "not asked", never "no".
    expect(openTargetFor(msg({ folder: "ohmail/News" }), false, noRow)).toEqual({
      kind: "stream", view: "reads", id: M,
    });
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, new Map([[M, null]])),
    ).toEqual({ kind: "reader", id: M });
  });

  it("History still wins over the pile question — it is asked first and answers alone", () => {
    // A history-cut message is pile-less by construction, so `holds` is not consulted for it and
    // the answer cannot depend on what the piles happen to contain.
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, new Map([[M, null]]), undefined, holdsEverything),
    ).toEqual({ kind: "reader", id: M });
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   2. WHAT THE READER SHOWS when the mirror holds no row
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("the reader opens a message the mirror does not hold", () => {
  const wire = msg({ id: "archive-1", subject: "WG: from the archive" });
  const none = () => undefined;
  /** No tombstone anywhere in this group — these four cases are about the off-mirror fallback,
   *  and the "gone" answer has its own file (`reply-survives-its-parent.test.tsx`). */
  const notGone = () => false;

  it("shows the row the opener carried in — the sheet used to stay shut", () => {
    // `open={readerMessage != null}`: with `?? null` alone this was `false` and clicking an
    // archive-only hit did nothing whatever. Restore the `??` and this is the red.
    expect(readerMessageFor("archive-1", none, wire, notGone)).toBe(wire);
  });

  it("prefers the MIRROR's row whenever there is one — it carries this device's own state", () => {
    const mine = msg({ id: "archive-1", subject: "the mirror's copy" });
    expect(readerMessageFor("archive-1", () => mine, wire, notGone)).toBe(mine);
  });

  it("never shows a held row for a DIFFERENT open", () => {
    // The fallback is keyed on the id, so a stale carried row cannot leak into the next open —
    // which on a reading surface would be somebody else's mail under the wrong header.
    expect(readerMessageFor("other-9", none, wire, notGone)).toBeNull();
  });

  it("nothing open, nothing shown", () => {
    expect(readerMessageFor(null, () => wire, wire, notGone)).toBeNull();
  });

  it("a carried row another mail client took away reads gone, never the stale row", () => {
    // History's open at phone width carries its store row into the sheet; a tombstone for it
    // must win, or the sheet goes on showing the deleted message (GONE-NOTICE-NOT-ON-THE-OTHER-VIEWS).
    expect(readerMessageFor("archive-1", none, wire, () => true)).toBe("gone");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   3. THE LANDING: anchored against the estimate drift, not aimed once
   ════════════════════════════════════════════════════════════════════════════════════════════ */

let roots: Root[] = [];

/** A rect at `top`, `height` high. */
const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top,
     toJSON: () => ({}) }) as DOMRect;

async function settle(ms = 400): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("a deep landing re-measures until the card is at the reading line", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] { return []; }
    };
    (HTMLElement.prototype as unknown as { scrollTo?: () => void }).scrollTo ??= () => {};
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    delete (globalThis as Record<string, unknown>).IntersectionObserver;
    delete (globalThis as Record<string, unknown>).CSS;
    vi.restoreAllMocks();
  });

  it("lands on the target card even though every card above it starts at its intrinsic guess", async () => {
    const N = 40;
    const TARGET = 30;
    const VIEWPORT = 600;
    /** The `contain-intrinsic-size` guess a card that has never been rendered reports. */
    const GUESS = 200;
    /** What a card actually measures once the browser has laid it out. */
    const REAL = 300;

    const ref = React.createRef<StreamHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        h(StreamShell, {
          ref, ariaLabel: "stream", onCurrentChange: () => {}, onSeen: () => {}, contentKey: 1,
          children: Array.from({ length: N }, (_, i) =>
            h("div", { className: "scast", "data-sid": `c${i}`, key: `c${i}` }),
          ),
        }),
      );
    });

    const el = container.querySelector<HTMLElement>(".stream")!;
    /**
     * `content-visibility: auto` + `contain-intrinsic-size: auto` in one model: a card reports the
     * GUESS until the scroller has been within a viewport of it, and its REAL height for ever
     * after (`auto` remembers). Content offsets are therefore a prefix sum that MOVES as the
     * scroller travels — which is exactly what makes a single pre-computed destination wrong.
     */
    const laidOut = new Set<number>();
    const heightOf = (i: number) => (laidOut.has(i) ? REAL : GUESS);
    const topOf = (i: number) => {
      let t = 0;
      for (let k = 0; k < i; k++) t += heightOf(k);
      return t;
    };
    const total = () => topOf(N);
    let scrollTop = 0;
    const renderAround = () => {
      for (let i = 0; i < N; i++) {
        const top = topOf(i) - scrollTop;
        if (top + heightOf(i) > -VIEWPORT && top < VIEWPORT * 2) laidOut.add(i);
      }
    };
    renderAround();

    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => total() });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = Math.min(Math.max(0, v), Math.max(0, total() - VIEWPORT));
        renderAround();
      },
    });
    el.getBoundingClientRect = () => rect(0, VIEWPORT);
    for (const [i, c] of [...container.querySelectorAll<HTMLElement>(".scast")].entries()) {
      c.getBoundingClientRect = () => rect(topOf(i) - scrollTop, heightOf(i));
    }
    const scrolls: number[] = [];
    el.scrollTo = ((opts: ScrollToOptions) => {
      scrolls.push(opts.top ?? 0);
      el.scrollTop = opts.top ?? 0;
      el.dispatchEvent(new Event("scroll"));
    }) as typeof el.scrollTo;

    const landed = vi.fn();
    await act(async () => {
      ref.current!.scrollTo(`c${TARGET}`, landed);
    });
    await settle();

    const card = container.querySelector<HTMLElement>(`.scast[data-sid="c${TARGET}"]`)!;
    const offLine = card.getBoundingClientRect().top - el.getBoundingClientRect().top;

    // THE ASSERTION THE REPORT IS ABOUT: the card the jump asked for is AT the reading line, not
    // hundreds of pixels past wherever the guesses said it would be.
    expect(
      offLine,
      `the target parked ${Math.round(offLine)}px from the line; the first aim was ` +
        `${Math.round(scrolls[0] ?? -1)} and the scroller ended at ${scrollTop}`,
    ).toBeLessThanOrEqual(16);
    expect(offLine).toBeGreaterThanOrEqual(-2);
    // It took MORE THAN ONE scroll, which is the mechanism: a single aim computed from the
    // guesses is exactly what missed. Replace the loop with one `scrollTo` and both this and the
    // assertion above go red.
    expect(scrolls.length).toBeGreaterThan(1);
    // …and the landing is reported exactly once, however many corrections it took.
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it("after the reader drove, a far landing that corrects itself marks and tracks nothing it only flew past", async () => {
    // The reader reads the top, then a search jump lands short on its guesses and corrects. Only
    // what is on screen at rest, and after the next wheel, may be marked or anchor the leave.
    const N = 40, TARGET = 30, VIEWPORT = 600, GUESS = 200, REAL = 300;
    const ios: Array<{ cb: IntersectionObserverCallback; opts: IntersectionObserverInit; observed: Set<Element> }> = [];
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      rec: { cb: IntersectionObserverCallback; opts: IntersectionObserverInit; observed: Set<Element> };
      constructor(cb: IntersectionObserverCallback, opts: IntersectionObserverInit = {}) {
        this.rec = { cb, opts, observed: new Set() };
        ios.push(this.rec);
      }
      observe(t: Element): void { this.rec.observed.add(t); }
      unobserve(t: Element): void { this.rec.observed.delete(t); }
      disconnect(): void { this.rec.observed.clear(); }
      takeRecords(): [] { return []; }
    };
    const seen: string[] = [];
    const leaves: StreamLeaveState[] = [];
    const ref = React.createRef<StreamHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(h(StreamShell, {
        ref, ariaLabel: "stream", onCurrentChange: () => {}, onSeen: (id: string) => { seen.push(id); },
        onLeave: (l: StreamLeaveState) => { leaves.push(l); }, contentKey: 1,
        children: Array.from({ length: N }, (_, i) =>
          h("div", { className: "scast", "data-sid": `c${i}`, "data-unseen": "1", key: `c${i}` })),
      }));
    });
    const el = container.querySelector<HTMLElement>(".stream")!;
    const laidOut = new Set<number>();
    const heightOf = (i: number) => (laidOut.has(i) ? REAL : GUESS);
    const topOf = (i: number) => { let t = 0; for (let k = 0; k < i; k++) t += heightOf(k); return t; };
    const total = () => topOf(N);
    let scrollTop = 0;
    const renderAround = () => {
      for (let i = 0; i < N; i++) {
        const top = topOf(i) - scrollTop;
        if (top + heightOf(i) > -VIEWPORT && top < VIEWPORT * 2) laidOut.add(i);
      }
    };
    renderAround();
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => total() });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = Math.min(Math.max(0, v), Math.max(0, total() - VIEWPORT)); renderAround(); },
    });
    el.getBoundingClientRect = () => rect(0, VIEWPORT);
    const cards = [...container.querySelectorAll<HTMLElement>(".scast")];
    for (const [i, c] of cards.entries()) c.getBoundingClientRect = () => rect(topOf(i) - scrollTop, heightOf(i));
    const onScreen = () => cards.filter((_, i) => {
      const t = topOf(i) - scrollTop;
      return t + heightOf(i) > 0 && t < VIEWPORT;
    }).map((c) => c.dataset.sid!);
    /** The browser's report after each move: every observed card against the seen band. */
    const deliver = () => {
      for (const io of ios) {
        if (!io.opts.rootMargin?.includes("-62%")) continue;
        const band = VIEWPORT * 0.38;
        const entries = [...io.observed].filter((t) => t.isConnected).map((target) => {
          const b = target.getBoundingClientRect();
          return { target, boundingClientRect: b, rootBounds: rect(0, band), isIntersecting: b.bottom > 0 && b.top < band } as unknown as IntersectionObserverEntry;
        });
        if (entries.length) io.cb(entries, {} as IntersectionObserver);
      }
    };
    el.scrollTo = ((opts: ScrollToOptions) => {
      el.scrollTop = opts.top ?? 0;
      el.dispatchEvent(new Event("scroll"));
      deliver();
    }) as typeof el.scrollTo;
    deliver();
    await act(async () => { el.dispatchEvent(new Event("wheel")); el.scrollTo({ top: 120 }); });
    await settle(100);
    const seenBefore = seen.length;
    await act(async () => { ref.current!.scrollTo(`c${TARGET}`); });
    await settle();
    const atRest = onScreen();
    await act(async () => { el.dispatchEvent(new Event("wheel")); el.scrollTo({ top: scrollTop + 60 }); });
    await settle(100);
    const shown = new Set([...atRest, ...onScreen()]);
    await act(async () => { root.unmount(); });
    expect(atRest, "control: the jump went deep").toContain(`c${TARGET}`);
    expect(seen.slice(seenBefore).filter((id) => !shown.has(id))).toEqual([]);
    expect(leaves).toHaveLength(1);
    expect(atRest).toContain(leaves[0]!.newestSeenId);
  });

  it("a card pushed off the line AFTER it arrives is followed, not abandoned", async () => {
    /**
     * The landing has to be a resting state, not an instant. A card's own top keeps moving after
     * the scroller stops, because the cards ABOVE it are still swapping their intrinsic guesses for
     * real heights. Measured on the fixture Reads pile: the landing was declared with the card on
     * screen 405px down, and two frames later it had been pushed to 935px — below the fold, loop
     * already finished, nothing left watching.
     *
     * Here that shove is deterministic: the target's top gains 400px on the second frame after the
     * scroller first arrives. Set `ANCHOR_STABLE_FRAMES` to 1 and this ends 414px off the line.
     */
    const ref = React.createRef<StreamHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        h(StreamShell, {
          ref, ariaLabel: "stream", onCurrentChange: () => {}, onSeen: () => {}, contentKey: 1,
          children: ["a", "b"].map((s) => h("div", { className: "scast", "data-sid": s, key: s })),
        }),
      );
    });
    const el = container.querySelector<HTMLElement>(".stream")!;
    let scrollTop = 0;
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 10_000 });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = Math.min(9400, Math.max(0, v)); },
    });
    el.getBoundingClientRect = () => rect(0, 600);

    let shove = 0;
    let readsAfterFirstScroll = 0;
    const target = container.querySelector<HTMLElement>('.scast[data-sid="b"]')!;
    target.getBoundingClientRect = () => {
      if (scrollTop > 0 && shove === 0 && ++readsAfterFirstScroll >= 2) shove = 400;
      return rect(3000 + shove - scrollTop, 100);
    };
    container.querySelector<HTMLElement>('.scast[data-sid="a"]')!.getBoundingClientRect = () =>
      rect(0 - scrollTop, 100);
    el.scrollTo = ((opts: ScrollToOptions) => { el.scrollTop = opts.top ?? 0; }) as typeof el.scrollTo;

    const landed = vi.fn();
    await act(async () => {
      ref.current!.scrollTo("b", landed);
    });
    await settle();
    const offLine = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    expect(shove, "the shove never happened — the model, not the product").toBe(400);
    expect(offLine, `the card ended ${Math.round(offLine)}px from the line`).toBeLessThanOrEqual(16);
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it("a card that cannot reach the line stops the loop instead of fighting the scroller", async () => {
    // The last card in a pile: the scroller bottoms out first, so its wanted offset is past the
    // maximum for ever. Without the clamp the loop would re-scroll every frame for its whole
    // budget, and — because each correction re-arms the spy's stand-down — the cursor would be
    // frozen for the duration. `stream-jump-cursor.test.tsx` is the other half of this.
    const ref = React.createRef<StreamHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        h(StreamShell, {
          ref, ariaLabel: "stream", onCurrentChange: () => {}, onSeen: () => {}, contentKey: 1,
          children: ["a", "b"].map((s) => h("div", { className: "scast", "data-sid": s, key: s })),
        }),
      );
    });
    const el = container.querySelector<HTMLElement>(".stream")!;
    let scrollTop = 0;
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 3200 });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = Math.min(2600, Math.max(0, v)); },
    });
    el.getBoundingClientRect = () => rect(0, 600);
    // `b` sits past the end of the scroller's reach and far enough away that the landing takes the
    // anchored path rather than the one-shot smooth scroll for a card already near the fold.
    const tops: Record<string, number> = { a: 0, b: 3000 };
    for (const c of container.querySelectorAll<HTMLElement>(".scast")) {
      c.getBoundingClientRect = () => rect(tops[c.dataset.sid!]! - scrollTop, 100);
    }
    const scrolls: number[] = [];
    el.scrollTo = ((opts: ScrollToOptions) => {
      scrolls.push(opts.top ?? 0);
      el.scrollTop = opts.top ?? 0;
    }) as typeof el.scrollTo;

    const landed = vi.fn();
    await act(async () => {
      ref.current!.scrollTo("b", landed);
    });
    await settle();
    // Bottomed out, and it says so once rather than churning. The budget is 90 frames, so an
    // unclamped loop would show up here as a scroll count in the tens.
    expect(scrolls.length).toBeLessThanOrEqual(2);
    expect(scrollTop).toBe(2600);
    expect(landed).toHaveBeenCalledTimes(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   4. ARRIVING FROM OUTSIDE THE PILE LEAVES THE MESSAGE OPEN
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const tags: TagDTO[] = [];

const streamMsg = (i: number): EngineMessage =>
  msg({
    id: `m${i}`, folder: "ohmail/News", subject: `subject of m${i}`,
    snippet: `snippet of message ${i}`,
    from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
  });

const body = (): MessageBody =>
  ({ text: "body", state: "snippet", html: null, loadedRemoteContent: false,
     unsubscribe: "no_header", unsubscribeUrl: null }) as unknown as MessageBody;

describe("a jump from outside the pile leaves the message OPEN, not merely selected", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {},
        removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
        onchange: null, dispatchEvent: () => false }),
    });
    (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
    (HTMLElement.prototype as unknown as { scrollTo?: () => void }).scrollTo ??= () => {};
    /**
     * ONE VIEWPORT OF HEIGHT, so the landing takes its already-laid-out path.
     *
     * jsdom reports every rect and every dimension as zero, which is "the card is at the top of a
     * scroller with no height" — a state no browser is ever in, and one that makes the anchored
     * path's frame loop the only branch reachable here. What this file's group is about is the
     * OPEN, so the stream is given a height and the target then measures as a card already near the
     * fold: the branch a j/k step and an adjacent-row click take. The anchored path has its own
     * group above, driven through stubbed drifting geometry.
     */
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 900 });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    delete (globalThis as Record<string, unknown>).CSS;
    delete (HTMLElement.prototype as unknown as { clientHeight?: number }).clientHeight;
    vi.restoreAllMocks();
  });

  const readsWith = (jumpTo: string | null, closeTo: string | null = null) => {
    const partition: FeedPartition = {
      waterline: null,
      fresh: [],
      seen: Array.from({ length: 8 }, (_, i) => streamMsg(i)),
      newCount: 0,
    };
    return h(ReadsView, {
      settled: true, owed: false,
      partition, tags, now: new Date(ISO), cur: null, onCur: () => {},
      aiChip: null, chipState: null, onChipState: () => {}, markSeen: () => {},
      bodyOf: body, hydrateBody: () => {}, jumpTo, onJumped: () => {},
      closeTo, onClosed: () => {},
    });
  };

  async function mount(node: React.ReactNode): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() => {
      root.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          now: new Date(ISO),
          timeZone: "UTC",
          children: h(KeymapProvider, { children: node }),
        }),
      );
    });
    return host;
  }

  it("the landed card is OPEN — the reader asked for that message, not for its neighbourhood", async () => {
    const host = await mount(readsWith("m5"));
    await settle(120);
    const open = [...host.querySelectorAll<HTMLElement>(".scast.open")].map((c) => c.dataset.sid);
    // `StreamCard` owns its expanded state, so this asserts the one mechanism a human click
    // drives. Drop the `onLanded` callback from `ReadsView`'s pending scroll and this is `[]`.
    expect(open, `open cards: ${open.join(", ") || "(none)"}`).toEqual(["m5"]);
  });

  it("exactly one card opens — a jump is not a licence to unclamp the pile", async () => {
    const host = await mount(readsWith("m5"));
    await settle(120);
    expect(host.querySelectorAll(".scast.open")).toHaveLength(1);
  });

  it("a visit with no jump opens nothing at all", async () => {
    // The regression this could cause: a plain switch into Reads that expands a card nobody
    // asked for, hydrating a body and raising verbs on arrival.
    const host = await mount(readsWith(null));
    await settle(120);
    expect(host.querySelectorAll(".scast.open")).toHaveLength(0);
  });

  /**
   * A CLOSE OF A DIFFERENT CARD MUST NOT CANCEL A JUMP ALREADY IN FLIGHT.
   *
   * The jump's frame stands down when a close was COUNTED while it was pending — but only when
   * the close was for THIS message. Both halves are load-bearing and only one of them is
   * obvious: drop the count and a second Back on the same message goes unseen; drop the id and
   * any close at all kills an unrelated jump, so following a link to one message while walking
   * out of another silently does nothing.
   *
   * Driven at the view rather than through the shell because that is where the interleaving can
   * be built exactly: the shell's route effect sets `closeTo` to the id it last jumped to, so
   * the two differ only on the search-jump path, and this states the contract the prop pair
   * actually has.
   */
  it("a close of ANOTHER card leaves a pending jump alone", async () => {
    const frames: Array<(() => void) | null> = [];
    const realRaf = window.requestAnimationFrame;
    const realCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      frames.push(() => cb(0))) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) => {
      if (handle > 0 && handle <= frames.length) frames[handle - 1] = null;
    }) as typeof window.cancelAnimationFrame;

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const render = async (jumpTo: string | null, closeTo: string | null): Promise<void> => {
      await act(() => {
        root.render(
          h(NextIntlClientProvider, {
            locale: "en", messages, now: new Date(ISO), timeZone: "UTC",
            children: h(KeymapProvider, { children: readsWith(jumpTo, closeTo) }),
          }),
        );
      });
    };
    const drain = async (): Promise<void> => {
      for (let pass = 0; pass < 200 && frames.some(Boolean); pass++) {
        const batch = frames.slice();
        frames.length = 0;
        await act(async () => { for (const f of batch) f?.(); });
      }
    };

    try {
      await render("m5", null);
      expect(frames.some(Boolean), "the jump scheduled a frame").toBe(true);
      // A close arrives for a DIFFERENT card while m5's frame is still pending.
      await render("m5", "m2");
      await drain();

      const open = [...host.querySelectorAll<HTMLElement>(".scast.open")].map((c) => c.dataset.sid);
      expect(open, `open cards: ${open.join(", ") || "(none)"}`).toEqual(["m5"]);
    } finally {
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancel;
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   5. THE OPENED LETTER IS THE CURSOR: five letters sharing one Date, Delete after a later frame
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("a search arrival among letters sharing one Date: Delete files the letter the reader shows", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] { return []; }
    };
    (Element.prototype as unknown as Record<string, () => void>).scrollIntoView = () => {};
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    delete (globalThis as Record<string, unknown>).IntersectionObserver;
    delete (globalThis as Record<string, unknown>).CSS;
    vi.restoreAllMocks();
  });

  const letter = (i: number, folder: "ohmail/News" | "ohmail/Receipts"): EngineMessage =>
    msg({ id: `RC${i}`, folder, subject: `Your receipt RC${i}`, unread: true,
      from: { name: "Copper Store", address: "orders@shop.example.invalid" } });
  const full = (): MessageBody =>
    ({ text: "Thank you.\nTotal: CHF 10.00", state: "full", html: null, loadedRemoteContent: false,
       unsubscribe: "no_header", unsubscribeUrl: null }) as unknown as MessageBody;

  async function arrive(view: "receipts" | "reads", start: string | null, more = 0, { port = 860, at = 3 } = {}) {
    const folder = view === "reads" ? "ohmail/News" : "ohmail/Receipts";
    const pile = Array.from({ length: 5 + more }, (_, i) => letter(i, folder));
    const filed: string[] = [];
    let land: (id: string) => void = () => {};
    let show: (v: boolean) => void = () => {};
    function Harness() {
      const [cur, setCur] = React.useState<string | null>(start);
      const [visible, setVisible] = React.useState(true);
      show = setVisible;
      const [jumpTo, setJump] = React.useState<string | null>(null);
      land = (id) => { setCur(id); setJump(id); }; // the shell's open: cursor + jump + enters, one batch
      useKeyBindings(deleteKeyBindings({
        focused: pile.find((m) => m.id === cur) ?? null, label: "Delete", canDelete: true, run: (m) => filed.push(m.id),
      }), "global");
      const common = { settled: true, owed: false, tags, now: new Date(ISO), cur, onCur: setCur, markSeen: () => {},
        bodyOf: full, hydrateBody: () => {}, jumpTo, onJumped: () => setJump(null), jumpEnters: true };
      return h(Activity, { mode: visible ? "visible" : "hidden" }, view === "reads"
        ? h(ReadsView, { ...common, partition: { waterline: null, fresh: [], seen: pile, newCount: 0 },
            aiChip: null, chipState: null, onChipState: () => {}, closeTo: null, onClosed: () => {} } as never)
        : h(ReceiptsView, { ...common, messages: pile, unreadCount: 5, isUnread: (m: EngineMessage) => m.unread,
            onAction: () => {} } as never));
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() => {
      root.render(h(NextIntlClientProvider, { locale: "en", messages, now: new Date(ISO), timeZone: "UTC",
        children: h(KeymapProvider, { children: h(Harness) }) }));
    });
    await settle(100);
    // Short cards that bottom out one port; an open card is taller, so opening raises the end.
    const el = host.querySelector<HTMLElement>(".stream")!;
    const order = () => [...el.querySelectorAll<HTMLElement>(".scast[data-sid]")].map((c) => c.dataset.sid!);
    const shrunk = new Map<string, number>();
    const height = (sid: string) =>
      (el.querySelector(`.scast.open[data-sid="${sid}"]`) ? 400 : 180) + (shrunk.get(sid) ?? 0);
    const topOf = (sid: string) => {
      let t = 100;
      for (const s of order()) { if (s === sid) return t; t += height(s) + 20; }
      return t;
    };
    const max = () => Math.max(0, topOf("") + 48 - port);
    let scrollTop = 0;
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => port });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => max() + port });
    Object.defineProperty(el, "scrollTop", {
      configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = Math.min(max(), Math.max(0, v)); },
    });
    el.scrollTo = ((o: ScrollToOptions) => { el.scrollTop = o.top ?? 0; el.dispatchEvent(new Event("scroll")); }) as typeof el.scrollTo;
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === el) return rect(0, port);
      if (this.classList.contains("scast") && el.contains(this)) return rect(topOf(this.dataset.sid!) - scrollTop, height(this.dataset.sid!));
      return real.call(this);
    });
    const press = pile[at]!.id; // a neighbour above it, and the pile's last below it
    const state = () => ({
      open: [...host.querySelectorAll<HTMLElement>(".scast.open")].map((c) => c.dataset.sid),
      card: host.querySelector<HTMLElement>(".scast.cur")?.dataset.sid ?? null,
      row: host.querySelector<HTMLElement>(".row.sel")?.dataset.id ?? null,
      filed,
    });
    const del = () => act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });
    // The cards above the pressed one measure in 85px shorter (their viewers mounting), once.
    const measureIn = (by = -85) => {
      for (const sid of order().slice(0, order().indexOf(press))) {
        shrunk.set(sid, by);
        el.querySelector(`.scast[data-sid="${sid}"]`)!.setAttribute("data-measured", "");
      }
    };
    const top = (sid: string) => topOf(sid) - scrollTop;
    return { el, order, press, land: () => act(async () => { land(press); }), state, del, measureIn, top,
      show: (v: boolean) => act(async () => { show(v); }) };
  }

  /** A smooth scroll flies in four frames; `first` runs on its first. Counts the scrolls asked for. */
  const flights = (el: HTMLElement, first: () => void) => {
    const f = { asked: 0, flew: false, frame: 0 };
    el.scrollTo = ((o: ScrollToOptions) => {
      f.asked += 1;
      cancelAnimationFrame(f.frame);
      const to = o.top ?? 0;
      if (o.behavior !== "smooth") { el.scrollTop = to; el.dispatchEvent(new Event("scroll")); return; }
      const from = el.scrollTop;
      let step = 0;
      const fly = () => {
        el.scrollTop = from + ((to - from) * ++step) / 4;
        el.dispatchEvent(new Event("scroll"));
        if (!f.flew) { f.flew = true; first(); }
        if (step < 4) f.frame = requestAnimationFrame(fly);
      };
      f.frame = requestAnimationFrame(fly);
    }) as typeof el.scrollTo;
    return f;
  };

  for (const view of ["receipts", "reads"] as const) {
    it(`${view}: cards above that measure in during the flight leave the pressed letter at the landing, and Delete files it`, async () => {
      const a = await arrive(view, null, 10);
      const f = flights(a.el, a.measureIn);
      await a.land();
      // The stream arms after a paint; the flight waits for it.
      await vi.waitFor(() => expect(f.flew, "the flight never flew").toBe(true), { timeout: 3000 });
      await settle(400);
      expect(a.top(a.press), "the pressed card's head is at the landing, on screen").toBeCloseTo(14, 0);
      await a.del();
      expect(a.state()).toEqual({ open: [a.press], card: a.press, row: a.press, filed: [a.press] });
    });
  }

  for (const [view, by] of [["receipts", -85], ["reads", -85], ["receipts", 85], ["reads", 85]] as const) {
    it(`${view}: cards above that measure in ${by}px after a far landing leave the pressed letter at the landing, and Delete files it`, async () => {
      const a = await arrive(view, null, 20, { port: 300, at: 15 });
      await a.land();
      await settle(400);
      expect(a.top(a.press), "control: the far landing put the card at the landing").toBeCloseTo(14, 0);
      await act(async () => { a.measureIn(by); });
      await settle(400);
      expect(a.top(a.press), "the pressed card's head is at the landing, on screen").toBeCloseTo(14, 0);
      await a.del();
      expect(a.state()).toEqual({ open: [a.press], card: a.press, row: a.press, filed: [a.press] });
    });
  }

  it("a wheel during the flight is the person's: the landing never pulls the pane back", async () => {
    const a = await arrive("receipts", null, 10);
    let asked = 0;
    const f = flights(a.el, () => {
      a.el.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      a.measureIn();
      asked = f.asked;
    });
    await a.land();
    await vi.waitFor(() => expect(f.flew).toBe(true), { timeout: 3000 });
    await settle(400);
    expect(f.asked - asked, "a scroll asked after the wheel").toBe(0);
  });

  for (const view of ["receipts", "reads"] as const) {
    it(`${view}: the opened card, the card cursor, the selected row and Delete stay on the pressed letter`, async () => {
      const a = await arrive(view, null);
      await a.land();
      await settle(200);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000); // the jump's deadline has passed
      await act(async () => { a.el.dispatchEvent(new Event("scroll")); });
      await settle(100);
      await a.del();
      expect(a.state()).toEqual({ open: [a.press], card: a.press, row: a.press, filed: [a.press] });
    });
  }

  for (const view of ["receipts", "reads"] as const) {
    it(`${view}: back in a kept pile, Delete after the first scroll files the letter on the reading line`, async () => {
      const a = await arrive(view, null);
      a.el.scrollTop = 288;
      await act(async () => { a.el.dispatchEvent(new Event("scroll")); });
      await settle(60);
      await a.show(false);
      // A browser announces the visit's reset scroll a frame later, never inside the call.
      a.el.scrollTo = ((o: ScrollToOptions) => {
        a.el.scrollTop = o.top ?? 0;
        setTimeout(() => a.el.dispatchEvent(new Event("scroll")), 0);
      }) as typeof a.el.scrollTo;
      await a.show(true);
      await settle(120);
      expect(a.state().card, "the revisit's cursor follows the top").toBe(a.order()[0]);
      a.el.scrollTop = 230; // the top letter's foot passes the line; the second is on it
      await act(async () => { a.el.dispatchEvent(new Event("scroll")); });
      await settle(60);
      const line = a.order()[1]!;
      await act(async () => { a.el.querySelector<HTMLElement>(`.scast[data-sid="${line}"] .sc-x`)!.click(); });
      await settle(50);
      await a.del();
      expect(a.state()).toEqual({ open: [line], card: line, row: line, filed: [line] });
    });
  }

  it("a press on another card's Expand pill moves the cursor with it, so Delete files the card that shows the bar", async () => {
    const a = await arrive("receipts", "RC2");
    const pill = a.el.querySelector<HTMLElement>(`.scast[data-sid="${a.press}"] .sc-x`);
    expect(pill, "the pressed card's pill").not.toBeNull();
    await act(async () => { pill!.click(); });
    await settle(50);
    await a.del();
    expect(a.state()).toEqual({ open: [a.press], card: a.press, row: a.press, filed: [a.press] });
  });
});
