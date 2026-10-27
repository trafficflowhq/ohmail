/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { HistoryView as HistoryViewRaw } from "../app/views/HistoryView";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import { FIXTURE_NOW, idOf, storeFixture, storeMessage, storeRows, type Fixture } from "./_store-fixture";

/**
 * AN OPEN HISTORY SHOWS MAIL THAT REACHES THE STORE WHILE IT IS OPEN.
 * The real view over a real engine: the arrival reaches the store and the next `/sync`, and after
 * ONE drain it is the first row. Read at the top, it shows on top; read deep, the row under the
 * top edge stays exactly where it stood. The reading column keeps its message either way. jsdom
 * has no layout: the scroller is a column of blocks stacked from heights keyed to each MESSAGE.
 */

const VIEW_PX = 600;
const NOTE_PX = 96;
const slotOf = (id: string): number => 0xffffffff - parseInt(id.slice(-12), 16);
/** Uneven, and the message's own: a row keeps its height when an arrival moves it a slot down. */
const rowPx = (id: string): number => 60 + ((Math.abs(slotOf(id)) * 7) % 4) * 10;

function heightOf(el: Element): number {
  if (!(el instanceof HTMLElement)) return 0;
  if (el.classList.contains("infonote")) return NOTE_PX;
  if (el.classList.contains("history-gone")) return 0;
  if (el.dataset.id !== undefined && el.dataset.index !== undefined) return rowPx(el.dataset.id);
  if (el.classList.contains("history-ghost")) return 80;
  if (el.style.height) return parseFloat(el.style.height);
  return [...el.children].reduce((n, c) => n + heightOf(c), 0);
}

function yIn(scroller: Element, el: Element): number {
  let y = 0;
  for (let node: Element | null = el; node && node !== scroller; node = node.parentElement) {
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) y += heightOf(s);
  }
  return y;
}

const saved: [object, string, PropertyDescriptor | undefined][] = [];
function stub(target: object, key: string, desc: PropertyDescriptor): void {
  saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
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

const HistoryView = (props: React.ComponentProps<typeof HistoryViewRaw>) => (
  <KeymapProvider><WithListGone><HistoryViewRaw {...props} /></WithListGone></KeymapProvider>
);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

interface Mounted {
  host: HTMLElement;
  scroller: HTMLElement;
  unmount: () => Promise<void>;
}

async function mountHistory(engine: OhmailEngine): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={FIXTURE_NOW} timeZone="UTC">
        <HistoryView onMarkSeen={() => {}}
          engine={engine} version={0} settled owed={false} tags={[]} now={FIXTURE_NOW}
          onOpen={() => {}} hydrateBody={() => {}} onAction={() => {}} onAddTag={() => {}} onScreen={() => {}}
          canDelete={() => true} canReplyAll={() => true}
        />
      </NextIntlClientProvider>,
    );
  });
  await settle();
  return {
    host,
    scroller: host.querySelector(".scroller") as HTMLElement,
    unmount: async () => {
      roots = roots.filter((r) => r !== root);
      await act(() => root.unmount());
      host.remove();
    },
  };
}

const rows = (m: Mounted): HTMLElement[] => [...m.host.querySelectorAll<HTMLElement>(".row[data-id]")];
const firstId = (m: Mounted): string | undefined => rows(m)[0]?.dataset.id;
const metaOf = (m: Mounted): string | null => m.host.querySelector(".view-history .meta")?.textContent ?? null;
const reading = (m: Mounted): string => m.host.querySelector(".read-col")?.textContent ?? "";
const selectedId = (m: Mounted): string | undefined =>
  m.host.querySelector<HTMLElement>(".row[data-id].sel")?.dataset.id;
/** The mounted row whose box holds the top edge, and where it stands against it. */
function atTop(m: Mounted): { id: string; top: number } {
  const hit = rows(m).find((n) => {
    const r = n.getBoundingClientRect();
    return r.top <= 0 && r.bottom > 0;
  });
  expect(hit, "a mounted row holds the top edge").toBeDefined();
  return { id: hit!.dataset.id!, top: hit!.getBoundingClientRect().top };
}

async function scrollTo(m: Mounted, px: number): Promise<void> {
  m.scroller.scrollTop = px;
  await act(async () => {
    m.scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
  });
  await settle(3);
}

async function drain(fx: Fixture): Promise<void> {
  await act(async () => { await fx.engine.syncOnce(); });
  await settle();
}

const NEW = () => storeMessage(-1, new Date(FIXTURE_NOW.getTime() + 60_000).toISOString(), { subject: "the new one" });

describe("an open History shows mail that reaches the store while it is open", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({
        matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    installLayout();
  });

  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    for (const [target, key, desc] of saved.splice(0).reverse()) {
      if (desc) Object.defineProperty(target, key, desc);
      else delete (target as Record<string, unknown>)[key];
    }
    vi.restoreAllMocks();
  });

  it("read at the top: after one drain the new message is the first row; the column keeps its message", async () => {
    const all = storeRows(200);
    const fx = await storeFixture(all, { mirror: all.slice(0, 40) });
    const m = await mountHistory(fx.engine);
    expect(metaOf(m)).toBe("200" + " messages");
    expect(firstId(m)).toBe(idOf(0));
    expect(reading(m)).toContain("subject of 0");

    fx.arrive(NEW());
    await drain(fx);
    expect(firstId(m), "the open list, after one drain").toBe(idOf(-1));
    expect(metaOf(m)).toBe("201" + " messages");
    expect(rows(m)[1]?.dataset.id).toBe(idOf(0));
    expect(reading(m), "the reading column does not follow slot 0 to the new message").toContain("subject of 0");
    expect(reading(m)).not.toContain("the new one");

    // THE REOPEN CONTROL: a new visit reads the store's present — the list the open one now shows.
    await m.unmount();
    const again = await mountHistory(fx.engine);
    expect(firstId(again)).toBe(idOf(-1));
    expect(metaOf(again)).toBe("201" + " messages");
  });

  it("read deep: the row under the top edge stays where it stood, and the new row is above it", async () => {
    const all = storeRows(400);
    const fx = await storeFixture(all, { mirror: all.slice(0, 40) });
    const m = await mountHistory(fx.engine);
    await scrollTo(m, NOTE_PX + 150 * 70);
    for (let i = 0; i < 30 && m.host.querySelector(".history-ghost"); i++) await scrollTo(m, m.scroller.scrollTop);
    const before = atTop(m);
    expect(slotOf(before.id)).toBeGreaterThan(100);
    const scrolled = m.scroller.scrollTop;

    fx.arrive(NEW());
    await drain(fx);
    expect(metaOf(m)).toBe("401" + " messages");
    const after = atTop(m);
    expect(after.id, "the same message under the top edge").toBe(before.id);
    expect(Math.abs(after.top - before.top), "at the same place against it").toBeLessThan(0.5);
    expect(m.scroller.scrollTop).toBeGreaterThan(scrolled);

    await scrollTo(m, 0);
    for (let i = 0; i < 30 && firstId(m) !== idOf(-1); i++) await settle(1);
    expect(firstId(m), "the arrival is on top of the list").toBe(idOf(-1));
  });

  it("a row picked below keeps its pick and its reading column when mail arrives above it", async () => {
    const all = storeRows(200);
    const fx = await storeFixture(all, { mirror: all.slice(0, 40) });
    const m = await mountHistory(fx.engine);
    const fifth = rows(m).find((n) => n.dataset.id === idOf(5))!;
    await act(async () => { fifth.click(); });
    await settle(2);
    expect(reading(m)).toContain("subject of 5");

    fx.arrive(NEW());
    await drain(fx);
    expect(firstId(m)).toBe(idOf(-1));
    expect(reading(m)).toContain("subject of 5");
    expect(selectedId(m)).toBe(idOf(5));
    // The cursor's slot moved with its row: ↓ reads the next message, not the one it had become.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle(2);
    expect(selectedId(m)).toBe(idOf(6));
  });

  it("the column showing slot 0 keeps its message through two arrivals, and ↓ reads the one below it", async () => {
    const all = storeRows(120);
    const fx = await storeFixture(all, { mirror: all.slice(0, 40) });
    const m = await mountHistory(fx.engine);
    fx.arrive(NEW());
    await drain(fx);
    fx.arrive(storeMessage(-2, new Date(FIXTURE_NOW.getTime() + 120_000).toISOString(), { subject: "newer still" }));
    await drain(fx);
    expect(rows(m).slice(0, 3).map((n) => n.dataset.id)).toEqual([idOf(-2), idOf(-1), idOf(0)]);
    expect(reading(m)).toContain("subject of 0");
    expect(selectedId(m)).toBe(idOf(0));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle(2);
    expect(selectedId(m)).toBe(idOf(1));
  });
});
