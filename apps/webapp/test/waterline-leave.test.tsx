/** @vitest-environment jsdom */
/**
 * THE LEAVE-COMMIT (R10-5) — the waterline's reliability floor, against the real views.
 *
 * The old model marked `\Seen` only through per-card observer hits: a card that exited
 * through the TOP of the stream marked itself, the card the scroll settled on dwelled, and
 * the LAST SCREENFUL — which never exits through the top — structurally never marked. The
 * fix is not a better observer; it is that LEAVING the view commits the waterline to the
 * top of what was on screen, in ONE anchored `feed_mark_seen`, bounded by what the visit
 * actually displayed.
 *
 * "Leaving" is DEFINED here as component unmount — which, because both views are
 * conditionally rendered on the route, is exactly "route-change away from the view".
 * Tab-hide is deliberately not leaving (it fires on every cmd-tab), and closing the tab
 * commits nothing (conservative: a line that failed to advance shows old mail as new,
 * never the reverse).
 *
 * jsdom has no layout, so this file gives the stream real geometry: every `.scast` card is
 * CARD_H tall, the `.stream` viewport VIEW_H, and `getBoundingClientRect` answers from the
 * emulated scroll offset — which is what `StreamShell.measure()` reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
  escape: (s: string) => s.replace(/["\\]/g, (c) => `\\${c}`),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── geometry the views believe ─────────────────────────────────────────────────────────── */

const CARD_H = 200;
const VIEW_H = 600; // three cards per screen

class MockIO {
  cb: unknown;
  constructor(cb: unknown) { this.cb = cb; }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const scrollTops = new WeakMap<Element, number>();

function streamCards(stream: Element): HTMLElement[] {
  return [...stream.querySelectorAll<HTMLElement>(".scast[data-sid]")];
}

/** `.stream` is the viewport; each `.scast` sits at its index times CARD_H, minus the offset. */
function rectFor(el: Element): DOMRect {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  if ((el as HTMLElement).classList?.contains("stream")) {
    return { ...zero, top: 0, bottom: VIEW_H, height: VIEW_H } as DOMRect;
  }
  if ((el as HTMLElement).classList?.contains("scast")) {
    const stream = el.closest(".stream");
    if (!stream) return zero as DOMRect;
    const i = streamCards(stream).indexOf(el as HTMLElement);
    if (i < 0) return zero as DOMRect;
    const top = i * CARD_H - (scrollTops.get(stream) ?? 0);
    return { ...zero, top, bottom: top + CARD_H, height: CARD_H } as DOMRect;
  }
  return zero as DOMRect;
}

function setStreamScroll(stream: Element, next: number): void {
  const max = Math.max(0, streamCards(stream).length * CARD_H - VIEW_H);
  scrollTops.set(stream, Math.min(Math.max(0, next), max));
  stream.dispatchEvent(new Event("scroll"));
}

/* ── the harness ───────────────────────────────────────────────────────────────────────── */

interface Row { id: string; unread: boolean }

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
/** Every commit the view handed up on its way out — the thing under test. */
let commits: Array<{ upToId: string; messageIds: string[] }> = [];
let marked: string[] = [];

const NOW = new Date("2026-08-02T09:00:00.000Z");

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
}

function wrap(children: React.ReactNode, KeymapProvider: unknown): React.ReactNode {
  return h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(KeymapProvider as never, { children } as never),
  });
}

async function mountReads(rows: Row[], opts: { jump?: string } = {}): Promise<void> {
  await unmount();
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const node = h(ReadsView as never, {
    settled: true, owed: false,
    partition: { waterline: null, fresh: rows.map((r) => msg(r, "ohmail/News")), seen: [] },
    tags: [], now: NOW, cur: null, onCur: () => {},
    aiChip: null, chipState: null, onChipState: () => {},
    markSeen: (id: string) => { marked.push(id); },
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    hydrateBody: () => {},
    jumpTo: opts.jump ?? null, onJumped: () => {},
  } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(wrap(node, KeymapProvider)); });
}

async function mountReceipts(
  rows: Row[],
  opts: { jump?: string; waterline?: { newestSeenId: string; at?: string }; freshCount?: number } = {},
): Promise<void> {
  await unmount();
  const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const node = h(ReceiptsView as never, {
    settled: true, owed: false,
    messages: rows.map((r) => msg(r, "ohmail/Receipts")),
    waterline: opts.waterline ?? null,
    freshCount: opts.freshCount,
    tags: [], now: NOW, cur: null, onCur: () => {},
    unreadCount: rows.filter((r) => r.unread).length,
    isUnread: (m: { unread: boolean }) => m.unread,
    markSeen: (id: string) => { marked.push(id); },
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    hydrateBody: () => {},
    jumpTo: opts.jump ?? null, onJumped: () => {},
  } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(wrap(node, KeymapProvider)); });
}

const streamEl = (): Element => host!.querySelector(".stream")!;

/** A real user scroll of the STREAM: the input a human produces, then the movement. */
async function wheelStream(to: number): Promise<void> {
  const el = streamEl();
  await act(async () => {
    el.dispatchEvent(new Event("wheel", { bubbles: true }));
    setStreamScroll(el, to);
  });
  // The measure runs inside the scroll handler's rAF; let it land (but stay under the 2s dwell).
  await act(async () => { vi.advanceTimersByTime(40); });
}

let originalGetRect: unknown;
let originalScrollTo: unknown;
let originalScrollIntoView: unknown;

/* The stream opens one screen of cards (`stream-window.ts`), sized by the window's height where
   nothing lays out; this emulator's port is 600px of 200px cards, so it is handed a screen tall
   enough to open with the whole pile, as the browser's lookahead would mount it. */
let innerHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 20 * 220 });
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", MockIO);
  commits = [];
  marked = [];
  originalGetRect = Element.prototype.getBoundingClientRect;
  originalScrollTo = (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  originalScrollIntoView = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return rectFor(this);
  };
  (Element.prototype as unknown as { scrollTo: (o: { top?: number }) => void }).scrollTo =
    function scrollTo(this: Element, o: { top?: number }) {
      if ((this as HTMLElement).classList?.contains("stream")) setStreamScroll(this, o?.top ?? 0);
    };
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    function scrollIntoView() { /* the list pane's follow — no geometry to keep here */ };
});

afterEach(async () => {
  await unmount();
  if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
  else delete (window as unknown as { innerHeight?: number }).innerHeight;
  Element.prototype.getBoundingClientRect = originalGetRect as typeof Element.prototype.getBoundingClientRect;
  (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = originalScrollTo;
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TEN: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, unread: true }));

/* ── the guards ────────────────────────────────────────────────────────────────────────── */

describe("leaving commits the waterline — once, anchored, bounded", () => {
  it("THE STRUCTURAL MISS, CLOSED: leave at the bottom ⇒ one commit, anchored at the top, covering the last screenful", async () => {
    // Scroll to the very bottom and leave. The last screenful (r7–r9) never exits through
    // the top, so the observer model alone never marks it — the commit must. The anchor is
    // r0, the newest card the visit displayed, which puts the line above everything.
    // Break `StreamShell`'s unmount cleanup (or the view's range arithmetic) and this is red.
    await mountReads(TEN);
    await wheelStream(1400); // max: 10 cards × 200 − 600
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"] },
    ]);
  });

  it("BOUNDED by what was displayed — never the pile", async () => {
    // A partial read: 400px in, the final screen shows r2–r4. The commit covers r0–r4 (the
    // contiguous run the visit displayed) and NOT r5–r9, which never entered the viewport.
    // Widen the slice in the view's leave handler to the whole pile and this goes red.
    await mountReads(TEN);
    await wheelStream(400);
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4"] },
    ]);
  });

  it("only UNREAD ids ride the commit — the anchor still stands for the range", async () => {
    // r1 and r3 are already read (\Seen on the server); flipping them again is a request
    // the wire does not need. The anchor is unchanged: the line is about what was SEEN,
    // not about what this commit had to flip.
    const rows = TEN.map((r, i) => ({ ...r, unread: i !== 1 && i !== 3 }));
    await mountReads(rows);
    await wheelStream(400);
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r2", "r4"] },
    ]);
  });

  it("PROGRAMMATIC NAVIGATION WRITES NOTHING — the userHasDriven gate holds at the exit too", async () => {
    // A jump from Search scrolls the stream to r5 and the reader leaves without ever
    // touching the scroller. `\Seen` writes to the user's real IMAP server and the line is
    // the pile's only newness signal: a visit nobody drove may move neither. Delete the
    // `drove` check in the view's leave handler (or report `true` from `StreamShell`) and
    // this goes red with a commit nobody earned.
    await mountReads(TEN, { jump: "r5" });
    await act(async () => { vi.advanceTimersByTime(40); });
    await unmount();
    expect(commits).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("Receipts commits through ITS OWN seam, same shape", async () => {
    // The engine-side guard proves view independence (a receipts commit cannot move Reads'
    // line); this proves the Receipts VIEW actually produces the commit — anchored and
    // bounded exactly as Reads' — so the pair `AppShell` binds (`commitFeedSeen("receipts")`)
    // has something real arriving at it.
    await mountReceipts(TEN);
    await wheelStream(400);
    await unmount();
    expect(commits).toEqual([
      { upToId: "r0", messageIds: ["r0", "r1", "r2", "r3", "r4"] },
    ]);
  });
});

describe("the streams are dotless; the sweep's attribute survives", () => {
  it("Reads renders NO unread dot anywhere — rows and cards keep data-unseen for the observer", async () => {
    await mountReads(TEN);
    expect(host!.querySelectorAll(".dot-unread")).toHaveLength(0);
    // The eventual \Seen sweep still has its hook: every unread row and card is observable.
    expect(host!.querySelectorAll(".row[data-unseen]").length).toBeGreaterThan(0);
    expect(host!.querySelectorAll(".scast[data-unseen]").length).toBeGreaterThan(0);
  });

  it("Receipts renders NO unread dot either, and draws ITS OWN waterline at the junction", async () => {
    await mountReceipts(TEN, { waterline: { newestSeenId: "r5", at: "2026-08-01T18:40:00.000Z" }, freshCount: 5 });
    expect(host!.querySelectorAll(".dot-unread")).toHaveLength(0);
    expect(host!.querySelectorAll(".row[data-unseen]").length).toBeGreaterThan(0);
    // One line in the list, one in the stream — the single newness signal, now in Receipts too.
    expect(host!.querySelectorAll(".waterline").length).toBe(2);
  });

  it("the Ohbox's row contract is untouched: without `dotless` the dot renders", async () => {
    // The shared row component still dots — dropping the dot is the STREAMS' choice, made
    // at their call sites, not a change to what every other list renders.
    const { MessageRow } = await import("@ohmail/ui");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(MessageRow as never, { id: "x", from: "A", subject: "s", unread: true } as never));
    });
    expect(host!.querySelectorAll(".dot-unread")).toHaveLength(1);
    expect(host!.querySelector(".row[data-unseen]")).not.toBeNull();
  });
});
