/** @vitest-environment jsdom */
/**
 * Each visit to News or Receipts owns its scroll and read evidence. Drive the registered frame
 * with browser events and inspect the engine writes. Each card is 200px in a 600px reading port.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { hitAt, issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { searchPlace } from "../../../packages/app/src/search/place.js";
import { feedPartition } from "../../../test/support/engine-fixtures.js";

const CARD_H = 200;
const VIEW_H = 600;

class MockIO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/* The list's geometry, for the list-sweep rows only: 80px rows in a 400px port. */
const ROW_H = 80;
const LIST_H = 400;
let listGeometry = false;
const isList = (el: Element): boolean => listGeometry && (el as HTMLElement).classList?.contains("pl-scroll");
const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };

/** An observer that reports every target on (re)observe, as Chromium and WebKit do. */
class DeliveringIO {
  private pending = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback, private opts: IntersectionObserverInit = {}) {}
  observe(t: Element): void { this.pending.add(t); setTimeout(() => this.flush(), 0); }
  unobserve(t: Element): void { this.pending.delete(t); }
  disconnect(): void { this.pending.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  private flush(): void {
    const root = this.opts.root as Element | undefined;
    const targets = [...this.pending].filter((t) => t.isConnected);
    this.pending.clear();
    if (!root || targets.length === 0) return;
    const r = rectFor(root);
    const m = (this.opts.rootMargin ?? "0px").trim().split(/\s+/);
    const cut = (v: string | undefined) => (v?.endsWith("%") ? (parseFloat(v) / 100) * r.height : parseFloat(v ?? "0") || 0);
    const rootBounds = { ...zero, top: r.top - cut(m[0]), bottom: r.bottom + cut(m[2] ?? m[0]) } as DOMRect;
    this.cb(targets.map((target) => {
      const b = rectFor(target);
      const isIntersecting = b.height > 0 && b.bottom > rootBounds.top && b.top < rootBounds.bottom;
      return { target, boundingClientRect: b, rootBounds, isIntersecting, intersectionRatio: isIntersecting ? 0.5 : 0 } as unknown as IntersectionObserverEntry;
    }), this as unknown as IntersectionObserver);
  }
}

const scrollTops = new WeakMap<Element, number>();
const cardsOf = (stream: Element): HTMLElement[] => [...stream.querySelectorAll<HTMLElement>("[data-stream-item]")];

function rectFor(el: Element): DOMRect {
  const node = el as HTMLElement;
  if (isList(node)) return { ...zero, top: 0, bottom: LIST_H, height: LIST_H } as DOMRect;
  const list = listGeometry ? node.closest(".pl-scroll") : null;
  if (list && node.hasAttribute("data-window-top")) {
    const top = -(scrollTops.get(list) ?? 0);
    return { ...zero, top, bottom: top } as DOMRect;
  }
  if (list && node.dataset.index !== undefined && node.dataset.id) {
    const top = Number(node.dataset.index) * ROW_H - (scrollTops.get(list) ?? 0);
    return { ...zero, top, bottom: top + ROW_H, height: ROW_H } as DOMRect;
  }
  if (pileOf(el)) return new DOMRect(0, 0, 600, VIEW_H);
  const stream = node.closest<HTMLElement>("[data-reading-scroll]");
  const card = node.closest<HTMLElement>("[data-stream-item]");
  const id = node.dataset.streamWindowItem ?? card?.dataset.streamItem;
  const pile = stream && pileOf(stream);
  if (pile && id) {
    const index = orderOf(pile).indexOf(id);
    if (index < 0) return zero as DOMRect;
    const top = index * CARD_H - (scrollTops.get(stream) ?? 0);
    if (node === card || node.dataset.streamWindowItem) return new DOMRect(0, top, 600, CARD_H);
    if (node.matches("[data-sender-line]")) return new DOMRect(0, top + 16, 600, 20);
    if (node.matches(".oh-message-clip, .oh-message-body, [data-read-body]")) {
      return new DOMRect(0, top + 70, 600, CARD_H - 100);
    }
  }
  return zero as DOMRect;
}

/** The cards (or list rows) inside the port right now — what a reader can see. */
function onScreen(stream: Element): string[] {
  if (isList(stream)) {
    return [...stream.querySelectorAll<HTMLElement>("[data-id][data-index]")].filter((row) => {
      const r = rectFor(row);
      return r.bottom > 0 && r.top < LIST_H;
    }).map((row) => row.dataset.id!);
  }
  return cardsOf(stream).filter((c) => {
    const r = rectFor(c);
    return r.bottom > 0 && r.top < VIEW_H;
  }).map((c) => c.dataset.streamItem!);
}

/** Every id that was on screen in the visit being recorded. */
let displayed = new Set<string>();
const note = (stream: Element): void => { for (const id of onScreen(stream)) displayed.add(id); };

function setScroll(stream: HTMLElement, next: number): void {
  const max = isList(stream) ? 100_000 : Math.max(0, stream.scrollHeight - VIEW_H);
  const clamped = Math.min(Math.max(0, next), max);
  if (clamped === (scrollTops.get(stream) ?? 0)) return;
  scrollTops.set(stream, clamped);
  note(stream);
  stream.dispatchEvent(new Event("scroll"));
}

interface Row { id: string; unread: boolean; subject?: string }
type Pile = "reads" | "receipts";

const NOW = new Date("2026-08-02T09:00:00.000Z");
const nameOf = (pile: Pile) => pile === "reads" ? "News" : "Receipts";
const pileOf = (port: Element): Pile | null => {
  if (!port.hasAttribute("data-reading-scroll")) return null;
  const label = port.closest('[role="region"]')?.getAttribute("aria-label");
  if (label === "News stream") return "reads";
  if (label === "Receipts stream") return "receipts";
  return null;
};
const stream = (pile: Pile) =>
  screen.getByRole("region", { name: `${nameOf(pile)} stream` }).querySelector<HTMLElement>("[data-reading-scroll]")!;
const listOf = (pile: Pile) =>
  screen.getByRole("region", { name: nameOf(pile) }).querySelector<HTMLElement>(".pl-scroll")!;
const cursor = (pile: Pile) =>
  screen.queryByRole("region", { name: nameOf(pile) })
    ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.dataset.id;

let frame: ReturnType<typeof mountStreamFrame>;
let previous: Row[];
let primary: Pile;
const orderOf = (pile: Pile): string[] => {
  const { fresh, seen } = feedPartition(frame.mail.engine.read(), pile);
  return [...fresh, ...seen].map(({ id }) => id);
};

function letterOf(pile: Pile, row: Row, index: number): EngineMessage {
  // The mirror keys messages globally, so the other pile needs a distinct copy of the same rows.
  const id = pile === primary ? row.id : `other-${row.id}`;
  const seed = pile === "reads" ? issue : receipt;
  return seed(id, 2, {
    date: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    // The old fixture supplied an ordered array. Preserve that order through the mirror's sort key.
    sortAt: new Date(NOW.getTime() - index * 1000).toISOString(),
    unread: row.unread,
    subject: row.subject ?? `S-${row.id}`,
    snippet: "preview",
  });
}

async function mountPiles(rows: Row[], pile: Pile = "reads", jump?: string): Promise<void> {
  primary = pile;
  previous = rows;
  await act(async () => {
    frame = mountStreamFrame({
      at: "#/ohbox",
      letters: (["reads", "receipts"] as const).flatMap((place) => rows.map((row, i) => letterOf(place, row, i))),
      ...(jump && { hit: { ...hitAt(pile === "reads" ? "news" : "receipts", jump), rail: searchPlace.rail } }),
    });
  });
}

/** Apply the next copy while the old place is still on screen, then use the frame's own navigation. */
async function visit(active: Pile | null, rows: Row[], fromSearch = false): Promise<void> {
  await act(async () => {
    if (previous !== rows) {
      for (const pile of ["reads", "receipts"] as const) {
        const next = rows.map((row, index) => letterOf(pile, row, index));
        const oldIds = previous.map((row, index) => letterOf(pile, row, index).id);
        for (const id of oldIds) {
          if (!next.some((row) => row.id === id)) frame.mail.patch(id, { folder: "INBOX" });
        }
        for (const letter of next) {
          if (oldIds.includes(letter.id)) frame.mail.patch(letter.id, letter);
          else frame.mail.add(letter);
        }
      }
      previous = rows;
    }
  });
  if (!active) return;
  const rail = within(screen.getByRole("navigation", { name: "Places" }));
  if (fromSearch) {
    await act(async () => { fireEvent.click(rail.getByRole("button", { name: /^Search\b/ })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open the hit" })); });
  } else if (!screen.queryByRole("region", { name: `${nameOf(active)} stream` })) {
    await act(async () => { fireEvent.click(rail.getByRole("button", { name: new RegExp(`^${nameOf(active)}\\b`) })); });
  }
  const port = stream(active);
  await act(async () => {
    fireEvent.scroll(port);
    vi.advanceTimersByTime(40);
  });
  note(port);
  if (listGeometry) note(listOf(active));
}

function leaves(pile: Pile): Array<{ upToId: string; messageIds: string[] }> {
  return frame.mail.mutations.flatMap((mutation) =>
    mutation.kind === "feed_mark_seen" && (mutation.view ?? "reads") === pile && mutation.upToId
      ? [{ upToId: mutation.upToId, messageIds: mutation.messageIds ?? [] }]
      : []);
}

function marked(pile: Pile): string[] {
  return frame.mail.mutations.flatMap((mutation) => {
    if (mutation.kind === "feed_mark_seen" && (mutation.view ?? "reads") === pile && !mutation.upToId) {
      return mutation.messageIds ?? [];
    }
    if (mutation.kind === "mark_seen" && !mutation.unread) {
      return mutation.messageIds.filter((id) => orderOf(pile).includes(id));
    }
    return [];
  });
}

async function wheelList(pile: Pile, to: number): Promise<void> {
  const el = listOf(pile);
  await act(async () => {
    fireEvent.wheel(el, { deltaY: to - (scrollTops.get(el) ?? 0) });
    setScroll(el, to);
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { vi.advanceTimersByTime(40); });
  note(el);
}

async function wheel(pile: Pile, to: number): Promise<void> {
  const el = stream(pile);
  const max = Math.max(0, orderOf(pile).length * CARD_H - VIEW_H);
  const end = Math.min(Math.max(0, to), max);
  let at = scrollTops.get(el) ?? 0;
  await act(async () => { fireEvent.wheel(el, { deltaY: end - at }); });
  while (at !== end) {
    const next = end > at ? Math.min(end, at + CARD_H / 2) : Math.max(end, at - CARD_H / 2);
    await act(async () => { setScroll(el, next); });
    at = next;
    await act(async () => { vi.advanceTimersByTime(20); });
  }
  await act(async () => { vi.advanceTimersByTime(40); });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IntersectionObserver", MockIO);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(20 * 220);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { getBoundingClientRect } = HTMLElement.prototype;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return isList(this) || this.closest(".pl-scroll, [data-reading-scroll]") ? rectFor(this) : getBoundingClientRect.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return pileOf(this) ? VIEW_H : isList(this) ? LIST_H : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    const pile = pileOf(this);
    return pile ? orderOf(pile).length * CARD_H : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
    return scrollTops.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value) {
    if (pileOf(this) || isList(this)) setScroll(this, value);
  });
  Element.prototype.scrollIntoView ??= () => {};
  HTMLElement.prototype.scrollTo ??= () => {};
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options, y?: number) {
    this.scrollTop = (typeof options === "number" ? y : (options as ScrollToOptions)?.top) ?? 0;
  });
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  listGeometry = false;
  displayed = new Set();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TEN: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, unread: true }));

for (const pile of ["reads", "receipts"] as const) {
  const other: Pile = pile === "reads" ? "receipts" : "reads";
  describe(`${pile}: a revisit is its own visit`, () => {
    it("a revisit commits only what that visit put on screen, anchored inside it", async () => {
      await mountPiles(TEN, pile);
      await visit(pile, TEN);
      await wheel(pile, 1400); // the whole pile, then away
      await visit(other, TEN);
      expect(leaves(pile), "control: the first visit commits").toHaveLength(1);
      expect(leaves(pile)[0]!.upToId, "control: anchored at the top").toBe("r0");
      for (const id of leaves(pile)[0]!.messageIds) expect(displayed.has(id), `control: ${id} was on screen`).toBe(true);
      // Meanwhile: the first visit's mail is read, a new letter arrives on top, r1 is marked
      // unread on another device.
      const later: Row[] = [{ id: "n0", unread: true }, ...TEN.map((r) => ({ ...r, unread: r.id === "r1" }))];
      await visit(other, later);
      displayed = new Set();
      await visit(pile, later);
      await wheel(pile, 1600);
      await visit(other, later);
      const second = leaves(pile)[1]!;
      expect(second, "the revisit committed nothing").toBeDefined();
      expect(displayed.has(second.upToId), `the line was anchored on ${second.upToId}, which this visit never showed`).toBe(true);
      for (const id of second.messageIds) {
        expect(displayed.has(id), `${id} was written \\Seen by a visit that never showed it`).toBe(true);
      }
      expect(second.upToId, "the revisit lands where a fresh mount lands: the top").toBe("n0");
    });

    it("a revisit nobody scrolled commits nothing", async () => {
      await mountPiles(TEN, pile);
      await visit(pile, TEN);
      await wheel(pile, 800);
      await visit(other, TEN);
      expect(leaves(pile)).toHaveLength(1);
      await visit(pile, TEN);
      await act(async () => { vi.advanceTimersByTime(2500); });
      await visit(other, TEN);
      expect(leaves(pile), "a visit with no hand on the scroller wrote the waterline").toHaveLength(1);
    });

    it("a revisit lands at the top, where a fresh mount lands", async () => {
      await mountPiles(TEN, pile);
      await visit(pile, TEN);
      await wheel(pile, 800);
      expect(scrollTops.get(stream(pile))).toBe(800);
      await visit(other, TEN);
      await visit(pile, TEN);
      expect(scrollTops.get(stream(pile)) ?? 0, "the revisit opened where the last visit left off").toBe(0);
    });

    it("the first j of a revisit steps from the letter the stream opens on, not the last visit's", async () => {
      const press = async () => {
        await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })); });
        await act(async () => { vi.advanceTimersByTime(100); });
      };
      await mountPiles(TEN, pile, "r6");
      await visit(pile, TEN);
      for (let i = 0; i < 3; i += 1) await press();
      expect(cursor(pile), "control: j steps the cursor").toBe("r3");
      await visit(other, TEN);
      const later: Row[] = [...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, unread: true })), ...TEN];
      await visit(other, later);
      await visit(pile, later);
      expect(onScreen(stream(pile))[0], "control: the revisit opens on the newest letter").toBe("n0");
      await press();
      expect(cursor(pile), "j continued from the last visit's cursor, past the new letters").toBe("n1");
      await visit(other, later);
      const curMoves: string[] = [];
      const watch = new MutationObserver((records) => {
        for (const record of records) {
          if (record.oldValue !== "true" || !(record.target instanceof HTMLElement)) continue;
          const id = record.target.dataset.id;
          if (id && id !== curMoves.at(-1)) curMoves.push(id);
        }
        const id = cursor(pile);
        if (id && id !== curMoves.at(-1)) curMoves.push(id);
      });
      watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"], attributeOldValue: true });
      try {
        await visit(pile, later, true);
      } finally {
        watch.disconnect();
      }
      expect(curMoves, "a revisit that arrives on a jump moved the cursor elsewhere first").toEqual(["r6"]);
    });

    it("pagehide commits the pile on screen once, and nothing for a hidden one", async () => {
      await mountPiles(TEN, pile);
      await visit(other, TEN);
      await wheel(other, 400);
      await visit(pile, TEN); // `other` is hidden now, with a visit behind it
      const before = leaves(other).length;
      await wheel(pile, 400);
      await act(async () => { window.dispatchEvent(new Event("pagehide")); });
      expect(leaves(pile), "the pile on screen did not commit on pagehide").toHaveLength(1);
      expect(leaves(other), "a hidden pile committed on pagehide").toHaveLength(before);
    });

    it("a mirror change while hidden is on screen at the reveal, the old row gone", async () => {
      await mountPiles(TEN, pile);
      await visit(pile, TEN);
      await visit(other, TEN);
      const changed = TEN.map((r) => (r.id === "r2" ? { ...r, subject: "A new subject" } : r)).filter((r) => r.id !== "r4");
      await visit(other, changed);
      await visit(pile, changed);
      const view = screen.getByRole("region", { name: `${nameOf(pile)} stream` });
      expect(view.textContent).toContain("A new subject");
      expect(view.textContent, "the reveal drew a row the mirror no longer holds").not.toContain("S-r4");
      expect(view.textContent).not.toContain("S-r2");
    });
  });
}

describe("what a visit leaves behind", () => {
  it("an earlier card's lingering bar does not outlive the visit", async () => {
    await mountPiles(TEN);
    await visit("reads", TEN);
    const open = async (id: string) => {
      const card = cardsOf(stream("reads")).find((element) => element.dataset.streamItem === id)!;
      await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Expand" })); });
    };
    const expectBarOn = (id: string) => {
      const region = within(screen.getByRole("region", { name: "News stream" }));
      const toolbar = region.getByRole("toolbar", { name: "Actions" });
      const cards = cardsOf(stream("reads"));
      expect(cards.filter((card) => card.hasAttribute("data-held"))
        .map((card) => card.dataset.streamItem)).toEqual([id]);
      for (const card of cards.filter((card) => card.dataset.streamItem !== id)) {
        expect(card.contains(toolbar)).toBe(false);
      }
      return within(toolbar);
    };

    await open("r0");
    const first = expectBarOn("r0");
    await act(async () => { fireEvent.click(first.getByRole("button", { name: "Later" })); });

    await open("r1");
    expectBarOn("r1");

    await visit("receipts", TEN);
    await visit("reads", TEN);
    const earlier = cardsOf(stream("reads")).find((card) => card.dataset.streamItem === "r0")!;
    expect(within(earlier).queryByRole("toolbar", { name: "Actions" })).toBeNull();
    await open("r1");
    const latest = expectBarOn("r1");
    await act(async () => { fireEvent.click(latest.getByRole("button", { name: "More" })); });
    const more = within(screen.getByRole("menu", { name: "More" }));
    await act(async () => { fireEvent.click(more.getByRole("menuitem", { name: "Move" })); });
    const move = within(screen.getByRole("menu", { name: "Move" }));
    await act(async () => { fireEvent.click(move.getByRole("menuitem", { name: "Ohbox" })); });
    expect(frame.mail.mutations.filter((mutation) => mutation.kind === "triage_set" || mutation.kind === "move"))
      .toEqual([
        { kind: "triage_set", messageId: "r0", state: "reply_later" },
        expect.objectContaining({ kind: "move", messageId: "r1", folder: "INBOX" }),
      ]);
  });

  it("2, 3, 2, 3, 2 ends on News, armed, with nothing committed", async () => {
    await mountPiles(TEN);
    await visit(null, TEN);
    for (const p of ["reads", "receipts", "reads", "receipts", "reads"] as const) await visit(p, TEN);
    const reads = screen.queryByRole("region", { name: "News stream" });
    const receipts = screen.queryByRole("region", { name: "Receipts stream" });
    expect(reads, "News is not the pile on screen").not.toBeNull();
    expect(receipts).toBeNull();
    expect(cardsOf(reads!).length, "News never armed its stream").toBeGreaterThan(0);
    expect({ reads: leaves("reads"), receipts: leaves("receipts") }, "a pile passed through committed something").toEqual({ reads: [], receipts: [] });
  });
});

/* THE LIST READS NOTHING. It once had a sweep of its own: the list kept its offset through
   `display:none`, and a revisit that opened it where the last visit left it marked mail that
   arrived (or was marked unread) meanwhile and was never on screen. The list now marks no row
   (only the stream reads), and a revisit's list still opens at the top, as a fresh mount's does. */
const TWENTY: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, unread: true }));

for (const pile of ["reads", "receipts"] as const) {
  const other: Pile = pile === "reads" ? "receipts" : "reads";
  describe(`${pile}: the list's sweep on a revisit`, () => {
    for (const [name, meanwhile] of [
      ["mail that arrived while hidden", (rows: Row[]) => [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, unread: true })),
        ...rows,
      ]],
      ["a row marked unread elsewhere", (rows: Row[]) =>
        rows.map((r) => ({ ...r, unread: r.id === "r5" ? true : r.unread }))],
    ] as const) {
      it(`the list marks nothing, and a revisit's list opens at the top: ${name}`, async () => {
        listGeometry = true;
        vi.stubGlobal("IntersectionObserver", DeliveringIO);
        await mountPiles(TWENTY, pile);
        await visit(pile, TWENTY);
        await wheelList(pile, 800);
        expect(scrollTops.get(listOf(pile)), "control: the wheel moved the list").toBe(800);
        expect(marked(pile), "the first visit's list wheel marked rows").toEqual([]);
        await visit(other, TWENTY);
        const later = meanwhile(TWENTY);
        await visit(other, later);
        await visit(pile, later);
        const atReveal = scrollTops.get(listOf(pile)) ?? 0;
        await wheelList(pile, atReveal + 40);
        expect(marked(pile), "the revisit's list wheel marked rows").toEqual([]);
        expect(atReveal, "the revisit's list opened where the last visit left it").toBe(0);
      });
    }
  });
}
