/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, ResurfacedThreadRow } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { OhboxView } from "../app/views/OhboxView";
import { KeymapProvider } from "../app/shell/keymap";
import { ESTIMATED_ROW_PX, useListWindow, WINDOW_TOP } from "@ohmail/app-logic/lists/list-window";

/**
 * THE WINDOW COUNTS FROM THE FIRST ROW, NOT FROM THE SCROLLER'S TOP. A note, a banner or a pinned
 * group above the rows shifted which rows mounted by its own height, and the anchor held the row
 * that far below the top edge. jsdom has no layout, so the scroller here is a column of blocks
 * stacked from the heights the window measures: a chrome block of `chromePx`, the marked top
 * spacer, the rows at uneven heights, the bottom spacer.
 */

const VIEW_PX = 600;
const COUNT = 1000;
const OVERSCAN = 8;
let chromePx = 1000;
const grown = new Map<number, number>();
/**
 * Rows at uneven heights — or every item at the window's estimate, where a case isolates the
 * origin: a reveal prices the rows it has not drawn at the estimate, and nothing else may differ.
 */
let even = false;
const rowPx = (i: number): number => grown.get(i) ?? (even ? ESTIMATED_ROW_PX : 60 + ((i * 7) % 4) * 10);

function heightOf(el: Element): number {
  if (!(el instanceof HTMLElement)) return 0;
  if (el.classList.contains("chrome")) return chromePx;
  if (el.classList.contains("grouplabel")) return ESTIMATED_ROW_PX;
  if (el.dataset.index !== undefined) return rowPx(Number(el.dataset.index));
  if (el.classList.contains("row")) return ESTIMATED_ROW_PX;
  if (el.style.height) return parseFloat(el.style.height);
  return [...el.children].reduce((n, c) => n + heightOf(c), 0);
}

/** Where `el` starts in its scroller's content: every box before it, stacked. */
function yIn(scroller: Element, el: Element): number {
  let y = 0;
  for (let node: Element | null = el; node && node !== scroller; node = node.parentElement) {
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) y += heightOf(s);
  }
  return y;
}

const saved: [object, string, PropertyDescriptor][] = [];
function stub(target: object, key: string, desc: PropertyDescriptor): void {
  saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)!]);
  Object.defineProperty(target, key, { configurable: true, ...desc });
}

function installLayout(): void {
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  const rect = Element.prototype.getBoundingClientRect;
  stub(HTMLElement.prototype, "offsetHeight", { get(this: HTMLElement) { return heightOf(this); } });
  stub(Element.prototype, "clientHeight", {
    get(this: Element) { return this.classList.contains("scroller") ? VIEW_PX : 0; },
  });
  stub(Element.prototype, "scrollTop", {
    get(this: Element) { return scrollTop.get!.call(this) as number; },
    set(this: Element, v: number) {
      const max = this.classList.contains("scroller")
        ? Math.max(0, [...this.children].reduce((n, c) => n + heightOf(c), 0) - VIEW_PX)
        : Number.POSITIVE_INFINITY;
      scrollTop.set!.call(this, Math.max(0, Math.min(max, v)));
    },
  });
  stub(Element.prototype, "getBoundingClientRect", {
    value(this: Element): DOMRect {
      const scroller = this.closest(".scroller");
      if (!scroller) return rect.call(this);
      const top = this === scroller ? 0 : yIn(scroller, this) - scroller.scrollTop;
      const height = this === scroller ? VIEW_PX : heightOf(this);
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    },
  });
}

/** The list under test: chrome above, then the window exactly as the views render it. */
function List({ bump }: { bump: number }): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count: COUNT });
  return (
    <div ref={scrollerRef} className="scroller" data-bump={bump} data-origin={win.offsetOf(0)} data-off300={win.offsetOf(300)}>
      <div className="chrome" />
      <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
      {Array.from({ length: win.end - win.start }, (_, k) => (
        <div key={win.start + k} className="row" data-index={win.start + k} />
      ))}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
    </div>
  );
}

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let bump = 0;

async function mount(): Promise<{ root: Root; scroller: HTMLElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => root.render(<List bump={bump} />));
  return { root, scroller: host.querySelector(".scroller") as HTMLElement };
}

/** A commit with nothing changed but the model: what a row or a note growing looks like to React. */
async function rerender(root: Root): Promise<void> {
  bump += 1;
  await act(() => root.render(<List bump={bump} />));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function scrollTo(scroller: HTMLElement, px: number): Promise<void> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** Where row `i` stands against the scroller's top edge, or null when it is not mounted. */
const topOf = (scroller: HTMLElement, i: number): number | null => {
  const n = scroller.querySelector(`[data-index="${i}"]`);
  return n ? Math.round(n.getBoundingClientRect().top) : null;
};
const mounted = (scroller: HTMLElement): HTMLElement[] => [...scroller.querySelectorAll<HTMLElement>("[data-index]")];
/** The mounted row whose box holds the scroller's top edge. */
function rowAtTop(scroller: HTMLElement): number {
  const hit = mounted(scroller).find((n) => {
    const r = n.getBoundingClientRect();
    return r.top <= 0 && r.bottom > 0;
  });
  expect(hit, "a mounted row holds the top edge — no blank band above the rows").toBeDefined();
  return Number(hit!.dataset.index);
}
/** A scroll position well inside the rows: the chrome, then a few hundred rows. */
const DEEP = (): number => chromePx + 300 * 75 + 10;

describe("the window counts its rows from where the first one starts", () => {
  beforeEach(() => {
    chromePx = 1000;
    even = false;
    grown.clear();
    installLayout();
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    for (const [target, key, desc] of saved.splice(0).reverse()) Object.defineProperty(target, key, desc);
  });

  it("the attribute the views render is the one the window reads", () => {
    expect(WINDOW_TOP).toBe("data-window-top");
  });

  it("a deep scroll mounts the rows on screen, the overscan above the one at the top edge", async () => {
    const { scroller } = await mount();
    expect(Number(scroller.dataset.origin), "offsetOf(0) is where slot 0 starts in the scroller").toBe(chromePx);
    await scrollTo(scroller, DEEP());
    const top = rowAtTop(scroller);
    const rows = mounted(scroller);
    expect(Number(rows[0]!.dataset.index), "the first mounted slot is the overscan above the row at the top edge").toBe(top - OVERSCAN);
    const last = rows[rows.length - 1]!.getBoundingClientRect();
    expect(last.bottom, "the mounted rows reach past the bottom edge").toBeGreaterThanOrEqual(VIEW_PX);
  });

  it("scrolling to offsetOf(i) puts row i at the top edge", async () => {
    const { scroller } = await mount();
    for (let k = 0; k < 2; k++) await scrollTo(scroller, Number(scroller.dataset.off300));
    const at = topOf(scroller, 300);
    expect(at, "row 300 is mounted").not.toBeNull();
    expect(Math.abs(at!), `row 300 stands ${at}px from the top edge`).toBeLessThanOrEqual(1);
  });

  it("a row growing under the top edge leaves that row where it stands", async () => {
    const { root, scroller } = await mount();
    await scrollTo(scroller, DEEP());
    const r = rowAtTop(scroller);
    const before = topOf(scroller, r);
    grown.set(r, rowPx(r) + 40);
    await rerender(root);
    expect(topOf(scroller, r), `row ${r}, under the top edge, held its place`).toBe(before);
  });

  it("the chrome above growing while the top edge is inside the rows moves nothing on screen", async () => {
    const { root, scroller } = await mount();
    await scrollTo(scroller, DEEP());
    const r = rowAtTop(scroller);
    const before = [r, r + 1, r + 2].map((i) => topOf(scroller, i));
    chromePx += 50;
    await rerender(root);
    expect([r, r + 1, r + 2].map((i) => topOf(scroller, i))).toEqual(before);
    expect(Number(scroller.dataset.origin)).toBe(chromePx);
  });

  it("at the top the chrome is read, not held: a growing note pushes the rows down", async () => {
    chromePx = 200;
    const { root, scroller } = await mount();
    expect(topOf(scroller, 0)).toBe(200);
    chromePx = 250;
    await rerender(root);
    expect(scroller.scrollTop).toBe(0);
    expect(topOf(scroller, 0)).toBe(250);
  });
});

/**
 * THE PATH BESIDE IT: every view that scrolls to a slot scrolls to `offsetOf`, which now counts
 * from slot 0's place. The Ohbox's reveal of a deep selection under a pinned Resurfaced group
 * put the row a group's height below where it meant to — off the screen past a tall group.
 */
const ISO = "2026-08-04T09:00:00.000Z";
const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: null,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;
const pinned = (m: EngineMessage): ResurfacedThreadRow => ({
  key: m.id, threadId: null, members: [m], pinned: [m], openTarget: m, count: 1, countFromThread: false,
  resurfacedAt: null, newSince: [], badge: false, pulledForward: false,
});
const none = () => {};

describe("a jump to a slot lands on it under whatever stands above the rows", () => {
  beforeEach(() => {
    even = true;
    grown.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: none, removeEventListener: none, addListener: none, removeListener: none, onchange: null, dispatchEvent: () => false }),
    });
    installLayout();
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    for (const [target, key, desc] of saved.splice(0).reverse()) Object.defineProperty(target, key, desc);
  });

  it("the Ohbox reveals a deep selection on screen below 30 pinned Resurfaced rows", async () => {
    const earlier = Array.from({ length: 600 }, (_, i) => message(i));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() => root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>
          <OhboxView owed={false} demo={false} newForYou={[]} previouslySeen={earlier}
            resurfacedRows={Array.from({ length: 30 }, (_, i) => pinned(message(1000 + i)))}
            tags={[]} now={new Date(ISO)} selectedId="m500" onSelect={none} onEnterReader={none}
            onMarkSeen={none} readerId={null} readSetFor={(id: string) => [id]} doorbellInitials={[]} doorbellCount={0} settled
            onDoorbell={none} onAction={none} onAddTag={none}
            bulk={{ run: () => true, tag: none, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => true }}
            older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: none }}
          />
        </KeymapProvider>
      </NextIntlClientProvider>,
    ));
    for (let k = 0; k < 3; k++) {
      await act(async () => {
        host.querySelector(".scroller")!.dispatchEvent(new Event("scroll"));
        await new Promise((r) => setTimeout(r, 30));
      });
    }
    const scroller = host.querySelector(".scroller") as HTMLElement;
    expect(scroller.scrollTop, "the reveal scrolled past the pinned group").toBeGreaterThan(30 * ESTIMATED_ROW_PX);
    const row = host.querySelector<HTMLElement>('[data-id="m500"]');
    expect(row, "the selected row is mounted").not.toBeNull();
    const r = row!.getBoundingClientRect();
    expect(r.top, "the selected row stands on screen").toBeGreaterThanOrEqual(0);
    expect(r.bottom, "the selected row stands on screen").toBeLessThanOrEqual(VIEW_PX);
  });
});

