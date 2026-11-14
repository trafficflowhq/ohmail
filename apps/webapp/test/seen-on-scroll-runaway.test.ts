/** @vitest-environment jsdom */
/**
 * SEEN-ON-SCROLL, AGAINST THE REAL VIEWS.
 *
 * The third instance of the read-state runaway family (`OhboxView` was the first two). The
 * family's rule, ruled 2026-08-02: *a fallback may decide what is displayed, never what is
 * written*. Here the fallback is `cur ?? all.find(unread)` in `ReadsView`/`ReceiptsView`, and
 * the writer is `useSeenOnScroll` — whose "the user has scrolled" guard was armed by the DOM
 * `scroll` event, which fires for `scrollIntoView` and `scrollTo` exactly as it does for a
 * wheel. Both views issue those calls; one of them used to be keyed on the fallback.
 *
 * WHY THIS FILE IS NOT LIKE `packages/ui/test/seen-on-scroll.test.tsx`. That file mounts the
 * hook against three inert buttons, so it can only ever assert the hook's own arithmetic. The
 * defect lives in the LOOP between the hook and the view: a commit flips `unread`, the view
 * re-renders, the fallback re-resolves, an effect scrolls, and the scroll re-enters the hook.
 * Nothing short of the real view with a `markSeen` that actually mutates the row can see it —
 * the same blind spot that hid the Ohbox runaway, whose harness recorded `onMarkSeen` calls
 * and never changed a row.
 *
 * So this file emulates the one thing jsdom does not have: layout. `ROW_H`/`VIEW_H` below give
 * each row a height and the scroller a viewport, `scrollIntoView` moves a virtual `scrollTop`
 * with the `block:"nearest"` rule from the spec, a movement dispatches a real `scroll` event,
 * and the IntersectionObserver mock then reports every observed row's geometry the way the
 * browser would. Every assertion is POSITIONAL — the exact ids, in order. A count would pass
 * on a runaway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// See `sync-liveness-shell.test.ts` for why React is published as a global and why this file
// writes `h(...)` rather than JSX.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// jsdom 25 ships no `CSS` object at all; both views build their row selector with CSS.escape.
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
  escape: (s: string) => s.replace(/["\\]/g, (c) => `\\${c}`),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── layout, which jsdom does not have ─────────────────────────────────────────────────── */

const ROW_H = 80;
const VIEW_H = 600;
/** `rootMargin: "0px 0px -67% 0px"` shrinks the root to its top third; that edge is the line. */
const LINE = Math.round(VIEW_H * 0.33);

type IOEntry = Partial<IntersectionObserverEntry>;

class MockIO {
  static byRoot = new Map<Element, Set<MockIO>>();
  cb: (entries: IOEntry[]) => void;
  root: Element | null;
  observed = new Set<Element>();
  constructor(cb: (entries: IOEntry[]) => void, options?: IntersectionObserverInit) {
    this.cb = cb;
    this.root = (options?.root as Element | null) ?? null;
    if (this.root) MockIO.byRoot.set(this.root, (MockIO.byRoot.get(this.root) ?? new Set()).add(this));
  }
  observe(el: Element): void {
    this.observed.add(el);
    // The browser reports a target's state when it is first observed.
    if (this.root) { const e = entryOf(this.root, el); if (e) this.cb([e]); }
  }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
}

const scrollTops = new WeakMap<Element, number>();
/** A runaway has to end the TEST, not the process: cap the emulator's re-entry. */
let delivered = 0;

function rowsOf(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-id],[data-sid]")];
}

function entryOf(root: Element, el: Element): IOEntry | null {
  if (!root.contains(el)) return null;
  const i = rowsOf(root).indexOf(el as HTMLElement);
  if (i < 0) return null;
  const top = i * ROW_H - (scrollTops.get(root) ?? 0);
  return {
    target: el,
    isIntersecting: top + ROW_H > 0 && top < LINE,
    boundingClientRect: { bottom: top + ROW_H } as DOMRectReadOnly,
    rootBounds: { bottom: LINE } as DOMRectReadOnly,
  };
}

/** What the browser's IntersectionObserver would report at the scroller's current offset. */
function deliver(root: Element): void {
  if (delivered++ > 400) return;
  // Every observer on the root is told, as the browser tells each one.
  for (const io of MockIO.byRoot.get(root) ?? []) {
    const entries: IOEntry[] = [];
    // A row that re-rendered into a different parent is a NEW node; the browser stops
    // reporting the detached one, and so does this.
    for (const el of io.observed) { const e = entryOf(root, el); if (e) entries.push(e); }
    if (entries.length) io.cb(entries);
  }
}

function setScroll(root: Element, next: number): void {
  const max = Math.max(0, rowsOf(root).length * ROW_H - VIEW_H);
  const clamped = Math.min(Math.max(0, next), max);
  if (clamped === (scrollTops.get(root) ?? 0)) return; // no movement ⇒ no `scroll` event
  scrollTops.set(root, clamped);
  root.dispatchEvent(new Event("scroll"));
  deliver(root);
}

/* ── the harness ───────────────────────────────────────────────────────────────────────── */

interface Row { id: string; unread: boolean }

/** A minimal EngineMessage, complete enough for MessageRow, StreamCard and the views. */
function msg(r: Row, folder: string): Record<string, unknown> {
  return {
    id: r.id,
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `S-${r.id}`,
    from: { name: r.id, address: `${r.id}@example.com` },
    to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z",
    folder,
    snippet: "preview",
    unread: r.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let live: Row[] = [];
/** The shell's `receiptsCur` / `readsCur` — NULL until something is deliberately selected. */
let cur: string | null = null;
let jumpTo: string | null = null;
/** Every id the view asked to hydrate — a READ, and therefore never a commit. */
let hydrated: string[] = [];
/** Every id written through the view's `markSeen`, in order. */
let marked: string[] = [];
let entities = new Map<string, { unread: boolean; entity: Record<string, unknown> }>();
let renderTree: (() => React.ReactNode) | null = null;

/**
 * Entity identity is CACHED per row, because the engine hands back the same object until the
 * row itself changes. Rebuilding every render would churn `useMemo` for reasons the product
 * never has, and the test would measure its own noise.
 */
function entityOf(r: Row, folder: string): Record<string, unknown> {
  const hit = entities.get(r.id);
  if (hit && hit.unread === r.unread) return hit.entity;
  const entity = msg(r, folder);
  entities.set(r.id, { unread: r.unread, entity });
  return entity;
}

/** Re-render synchronously; every caller is already inside an `act`, which flushes effects. */
function rerender(): void {
  if (root && renderTree) root.render(renderTree());
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null; renderTree = null;
}

/** `markSeen` as the shell wires it: the engine's optimistic effect flips `unread` on the row. */
function commit(id: string): void {
  marked.push(id);
  const row = live.find((r) => r.id === id);
  if (row) row.unread = false;
  rerender();
}

async function mountReceipts(rows: Row[], opts: { jump?: string } = {}): Promise<void> {
  await unmount();
  const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  live = rows.map((r) => ({ ...r }));
  cur = null;
  jumpTo = opts.jump ?? null;
  entities = new Map();

  renderTree = (): React.ReactNode =>
    h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(KeymapProvider as never, {
        children: h(ReceiptsView as never, {
    settled: true, owed: false,
          // Receipts is a flat list in a fixed order, so a read commit never re-partitions it
          // and the rows keep their DOM identity — which is why this view, not Reads, is where
          // the mechanism is asserted without any confound.
          messages: live.map((r) => entityOf(r, "ohmail/Receipts")),
          tags: [],
          now: new Date("2026-08-02T09:00:00.000Z"),
          cur,
          onCur: (id: string) => { cur = id; rerender(); },
          unreadCount: live.filter((r) => r.unread).length,
          isUnread: (m: { unread: boolean }) => m.unread,
          markSeen: commit,
          /**
           * This suite is about what the seen-on-scroll machinery WRITES, so the
           * bodies are deliberately inert: `bodyOf` reports the mirror's snippet as a snippet
           * (no record, no engine), and `hydrateBody` is recorded rather than performed. What
           * matters here is that hydration adds NO write — `commits` below must stay exactly
           * what the scroll produced, and `hydrated` is asserted empty of any \\Seen effect by
           * being a separate list entirely.
           */
          bodyOf: (m: { body?: string; snippet: string }) => ({
            text: m.body ?? m.snippet,
            state: m.body !== undefined ? "full" : "snippet",
          }),
          hydrateBody: (id: string) => { hydrated.push(id); },
          jumpTo,
          onJumped: () => { jumpTo = null; rerender(); },
        } as never),
      } as never),
    });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { rerender(); });
}

const listEl = (): Element => host!.querySelector(".view .scroller")!;
const listTop = (): number => scrollTops.get(listEl()) ?? 0;
const settle = async (): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(50); });
};

let originalScrollIntoView: unknown;
let originalScrollTo: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  MockIO.byRoot = new Map();
  vi.stubGlobal("IntersectionObserver", MockIO);
  marked = [];
  hydrated = [];
  delivered = 0;
  cur = null;
  originalScrollIntoView = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  originalScrollTo = (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;

  /** `block: "nearest"` — the minimum movement that brings the element fully into view. */
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    function scrollIntoView(this: Element) {
      const sc = this.closest(".scroller, .stream");
      if (!sc) return;
      const i = rowsOf(sc).indexOf(this as HTMLElement);
      if (i < 0) return;
      const top = scrollTops.get(sc) ?? 0;
      const rowTop = i * ROW_H;
      if (rowTop < top) setScroll(sc, rowTop);
      else if (rowTop + ROW_H > top + VIEW_H) setScroll(sc, rowTop + ROW_H - VIEW_H);
    };
  (Element.prototype as unknown as { scrollTo: (o: { top?: number }) => void }).scrollTo =
    function scrollTo(this: Element, o: { top?: number }) { setScroll(this, o?.top ?? 0); };
});

afterEach(async () => {
  await unmount();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = originalScrollIntoView;
  (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = originalScrollTo;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TWENTY: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, unread: true }));

/* ── the guards ────────────────────────────────────────────────────────────────────────── */

describe("Receipts: a scroll nobody made must not write \\Seen", () => {
  it("an untouched view marks NOTHING, and does not scroll itself either", async () => {
    // Two guards in one, because they are the two halves of the family's rule. Nothing is
    // written (`useSeenOnScroll`), and the fallback does not move the viewport either
    // (`ReceiptsView`'s effect keyed on `cur`) — an implicit selection decides what is
    // displayed and nothing else. Key that effect back on `current` and the second
    // assertion goes red: the list scrolls to a row nobody chose while the reading stream
    // beside it stays at the top.
    const rows = TWENTY.map((r, i) => ({ ...r, unread: i >= 12 }));
    await mountReceipts(rows);
    await settle();
    expect(marked).toEqual([]);
    expect(listTop()).toBe(0);
    /**
     * AND THE THIRD HALF, added by that change: the view now FETCHES on the same implicit
     * fallback it must not write on. The fallback picks the first unread row, hydration asks
     * for that one body — a read — and `marked` above stays empty.
     *
     * Both assertions matter together. `hydrated` being non-empty is what stops the empty
     * `marked` from passing because hydration silently did nothing; `marked` being empty is
     * what proves a body fetch did not acquire a `\Seen` write on the way. Red by routing
     * hydration through `markSeen`, or by letting the Ohbox's dwell machinery near this view.
     */
    expect(hydrated).toEqual(["r12"]);
  });
});
