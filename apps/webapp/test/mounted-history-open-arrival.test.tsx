/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { FIXTURE_NOW, idOf, storeFixture, storeMessage, storeRows, type Fixture } from "./_store-fixture";
import {
  ISO, act, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { readingColumn, seatedList } from "./ohbox/_finders";

/**
 * AN OPEN HISTORY SHOWS MAIL THAT REACHES THE STORE WHILE IT IS OPEN.
 * The real view over a real engine: the arrival reaches the store and the next `/sync`, and after
 * ONE drain it is the first row. Read at the top, it shows on top; read deep, the row under the
 * top edge stays exactly where it stood. The reading column keeps its message either way. jsdom
 * has no layout: the scroller is a column of blocks stacked from heights keyed to each MESSAGE.
 */

const VIEW_PX = 600;
const SCROLLER = ".pl-scroll";
const ROW = '[role="option"][data-id]';
const slotOf = (id: string): number => 0xffffffff - parseInt(id.slice(-12), 16);
/** Uneven, and the message's own: a row keeps its height when an arrival moves it a slot down. */
const rowPx = (id: string): number => 60 + ((Math.abs(slotOf(id)) * 7) % 4) * 10;

function heightOf(el: Element): number {
  if (!(el instanceof HTMLElement)) return 0;
  if (el.matches(ROW)) return rowPx(el.dataset.id!);
  if (el.getAttribute("aria-hidden") === "true" && el.hasAttribute("data-index")) return 80;
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
    get(this: Element) { return this.matches(SCROLLER) ? VIEW_PX : 0; },
  });
  stub(Element.prototype, "scrollTop", {
    get(this: Element) { return scrollTop.get!.call(this) as number; },
    set(this: Element, v: number) {
      const max = this.matches(SCROLLER)
        ? Math.max(0, [...this.children].reduce((n, c) => n + heightOf(c), 0) - VIEW_PX)
        : Number.POSITIVE_INFINITY;
      scrollTop.set!.call(this, Math.max(0, Math.min(max, v)));
    },
  });
  stub(Element.prototype, "getBoundingClientRect", {
    value(this: Element): DOMRect {
      const scroller = this.closest(SCROLLER);
      if (!scroller) return rect.call(this);
      const top = this === scroller ? 0 : yIn(scroller, this) - scroller.scrollTop;
      const height = this === scroller ? VIEW_PX : heightOf(this);
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    },
  });
}

const settle = (rounds = 6) => tick(rounds * 10);

interface Mounted {
  host: HTMLElement;
  scroller: HTMLElement;
}

async function mountHistory(engine: OhmailEngine): Promise<Mounted> {
  const host = await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
  await goTo("history");
  await settle();
  return { host, scroller: seatedList(host)!.querySelector<HTMLElement>(SCROLLER)! };
}

const rows = (m: Mounted): HTMLElement[] => [...m.host.querySelectorAll<HTMLElement>(ROW)];
const firstId = (m: Mounted): string | undefined => rows(m)[0]?.dataset.id;
const metaOf = (m: Mounted): string | null =>
  seatedList(m.host)?.querySelector(".oh-listhead-count")?.textContent ?? null;
const reading = (m: Mounted): string => readingColumn(m.host)?.textContent ?? "";

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
    installShellEnv();
    installLayout();
  });

  afterEach(async () => {
    await teardownShellEnv();
    for (const [target, key, desc] of saved.splice(0).reverse()) {
      if (desc) Object.defineProperty(target, key, desc);
      else delete (target as Record<string, unknown>)[key];
    }
  });

  it("read at the top: after one drain the new message is the first row; the column keeps its message", async () => {
    const all = storeRows(200);
    const total = all.length;
    const fx = await storeFixture(all, { mirror: all.slice(0, 40) });
    const m = await mountHistory(fx.engine);
    expect.soft(metaOf(m)).toBe(`${total} messages`);
    expect(firstId(m)).toBe(idOf(0));
    expect(reading(m)).toContain("subject of 0");

    fx.arrive(NEW());
    await drain(fx);
    expect(firstId(m), "the open list, after one drain").toBe(idOf(-1));
    expect.soft(metaOf(m)).toBe(`${total + 1} messages`);
    expect(rows(m)[1]?.dataset.id).toBe(idOf(0));
    expect(reading(m), "the reading column does not follow slot 0 to the new message").toContain("subject of 0");
    expect(reading(m)).not.toContain("the new one");

    // THE REOPEN CONTROL: a new visit reads the store's present — the list the open one now shows.
    await goTo("ohbox");
    await goTo("history");
    await settle();
    expect(firstId(m)).toBe(idOf(-1));
    expect(metaOf(m)).toBe(`${total + 1} messages`);
  });

  it("read deep: the row under the top edge stays where it stood, and the new row is above it", async () => {
    const all = storeRows(400);
    const total = all.length;
    const fx = await storeFixture(all, { mirror: all.slice(0, 40) });
    const m = await mountHistory(fx.engine);
    await scrollTo(m, 150 * 70);
    for (let i = 0; i < 30 && slotOf(atTop(m).id) <= 100; i++) await settle(1);
    const before = atTop(m);
    expect.soft(slotOf(before.id)).toBeGreaterThan(100);
    const scrolled = m.scroller.scrollTop;

    fx.arrive(NEW());
    await drain(fx);
    expect.soft(metaOf(m)).toBe(`${total + 1} messages`);
    const after = atTop(m);
    expect.soft(after.id, "the same message under the top edge").toBe(before.id);
    expect.soft(Math.abs(after.top - before.top), "at the same place against it").toBeLessThan(0.5);
    expect.soft(m.scroller.scrollTop).toBeGreaterThan(scrolled);

    await scrollTo(m, 0);
    for (let i = 0; i < 30 && firstId(m) !== idOf(-1); i++) await settle(1);
    expect(firstId(m), "the arrival is on top of the list").toBe(idOf(-1));
  });

});
