/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OhmailEngine, MemoryMirrorStore, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import {
  ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

/**
 * The mounted Screener opens its newest letter while bodies are snippets, then keeps the reader's
 * place as bodies grow. The layout model reports viewport positions from the mounted articles' own sizes.
 */
/** A collapsed held entry — a snippet line and its chrome. */
const SNIPPET_PX = 100;
/** The same entry once its body has landed. The ratio is what makes the defect visible. */
const FULL_PX = 600;
/** The component's own breathing room above the anchored entry, under the sticky decision bar. */
const ANCHOR_SLACK = 14;

// ── the layout model ────────────────────────────────────────────────────────────────────────

/** The ids `fetchBody` has answered for — the premise check, not the layout input. */
let hydrated = new Set<string>();

/**
 * The text `fetchBody` returns. An entry is tall when its OWN rendered text is the full body rather
 * than the snippet, read off the DOM: the height then follows from what is on screen instead of from
 * a flag the test also controls, so the model cannot claim a growth the component never rendered.
 */
const FULL_BODY_MARK = "the whole of";

function heightOf(el: Element): number {
  const sid = within(el as HTMLElement).queryByRole("heading", { level: 2 })?.textContent?.replace(/^Subject /, "");
  const set = sid === undefined ? undefined : grown.get(sid);
  if (set !== undefined) return set;
  return (el.textContent ?? "").includes(FULL_BODY_MARK) ? FULL_PX : SNIPPET_PX;
}

/** A letter's height set by the test — a picture that loaded, a frame that sized — by message id. */
const grown = new Map<string, number>();

/**
 * THE RESIZE OBSERVER, STUBBED AS LAYOUT DRIVES IT: one callback per `resized` call, carrying every
 * element the test says changed size. An element's first report is not made on `observe` but rides
 * the next callback, as a browser's does after layout, so a frame sized in between is already grown.
 */
const observers = new Set<{ cb: ResizeObserverCallback; els: Set<Element>; first: Set<Element> }>();
const priorResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
class StubResizeObserver {
  private readonly o: { cb: ResizeObserverCallback; els: Set<Element>; first: Set<Element> };
  constructor(cb: ResizeObserverCallback) {
    this.o = { cb, els: new Set(), first: new Set() };
    observers.add(this.o);
  }
  observe(el: Element): void {
    this.o.els.add(el);
    this.o.first.add(el);
  }
  unobserve(el: Element): void { this.o.els.delete(el); this.o.first.delete(el); }
  disconnect(): void { observers.delete(this.o); }
}
async function resized(...els: Element[]): Promise<void> {
  await act(async () => {
    for (const o of observers) {
      const mine = new Set([...o.first, ...[...o.els].filter((parent) => els.some((el) => parent.contains(el)))]);
      o.first.clear();
      if (mine.size > 0) o.cb([...mine].map((target) => ({ target }) as ResizeObserverEntry), null as never);
    }
  });
}
const preview = () => within(host ?? document.body).queryByRole("region", { name: "Reading" });
const scroller = () => preview()?.querySelector<HTMLElement>("[data-reading-scroll]") ?? null;
const letters = () => {
  const panel = preview();
  return panel ? within(panel).queryAllByRole("article") : [];
};
const landed = () => resized(...letters());
const card = (id: string): HTMLElement =>
  within(preview()!).getByRole("heading", { name: `Subject ${id}` }).closest("article")!;

function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) };
}

function layout(this: Element): DOMRect {
  const read = scroller();
  if (this === read) return rect(0, 800);
  if (this.tagName !== "ARTICLE" || !read?.contains(this)) return rect(0, 0);
  let offset = 0;
  for (const letter of letters()) {
    if (letter === this) break;
    offset += heightOf(letter);
  }
  return rect(offset - read.scrollTop, heightOf(this));
}

const offsetOfLast = (): number => letters().slice(0, -1).reduce((offset, letter) => offset + heightOf(letter), 0);
const scrollerTop = (): number => scroller()!.scrollTop;

// ── the world ───────────────────────────────────────────────────────────────────────────────

const NOW = new Date(ISO);
let seq = 0;
let host: HTMLElement | null = null;
let bodyGate: (() => void) | null = null;

function msg(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-04T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-04T09:00:00.000Z",
  };
}

/**
 * A DERIVED (warm-account) world: messages in the mirror, no `screener_sender` fixture rows, and
 * bodies that arrive only when `fetchBody` is allowed to resolve. That gate is what lets the test
 * observe the two moments — anchored on snippets, then bodies land — separately.
 */
async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  const open = new Promise<void>((resolve) => { bodyGate = resolve; });
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (id: string) => {
        await open;
        hydrated.add(id);
        return {
          text: `${FULL_BODY_MARK} ${id}`, html: null, loadedRemoteContent: false,
          unsubscribe: "no_header" as const, unsubscribeUrl: null,
        };
      },
    },
  });
}

async function mount(engine: OhmailEngine): Promise<void> {
  window.location.hash = "#/screener";
  host = await mountShell([mailbox({
    id: "mb", organizerRole: "organizer", organizeConsentedAt: ISO, lastSyncAt: ISO,
  })], { engine, suggestWire: "none", junkWire: "none" });
  await tick(50);
  const list = within(host).getByRole("listbox", { name: "Screener" });
  await act(async () => { within(list).getByRole("option").click(); });
  await tick(0);
  await landed();
}

async function flush(): Promise<void> {
  await tick(0);
  await landed();
}

beforeEach(() => {
  installShellEnv();
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(layout);
  window.localStorage.clear();
  hydrated = new Set();
  bodyGate = null;
  grown.clear();
});

afterEach(async () => {
  bodyGate?.();
  await teardownShellEnv();
  host = null;
  observers.clear();
  vi.unstubAllGlobals();
});

/** One sender, three held messages — the ordinary multi-message shape at the gate. */
const THREE = () => [
  msg("oldest", "stranger@example.test", 8),
  msg("middle", "stranger@example.test", 10),
  msg("newest", "stranger@example.test", 12),
];

describe("the Screener opens on the sender's LATEST held message", () => {
  it("renders the held mail oldest→newest, so the anchor is load-bearing", async () => {
    // The premise. If `held` were newest-first the anchor would be unnecessary and every assertion
    // below would be about nothing.
    await mount(await engineWith(THREE()));
    const subjects = letters().map((letter) => within(letter).getByRole("heading", { level: 2 }).textContent ?? "");
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toContain("oldest");
    expect(subjects[2]).toContain("newest");
  });

  it("anchors the last entry while the bodies are still snippets", async () => {
    // The behaviour that already worked: on selection, with every entry at its collapsed height, the
    // scroller is put on the last one.
    await mount(await engineWith(THREE()));
    expect(offsetOfLast()).toBe(SNIPPET_PX * 2);
    expect(scrollerTop()).toBe(SNIPPET_PX * 2 - ANCHOR_SLACK);
  });

  it("STAYS on the last entry once the bodies land — the warm-account case", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A raw pixel anchor computed over collapsed entries is
    // wrong the moment they grow, and on a live account they always grow: every held body starts as
    // a snippet and arrives through `hydrateBody`. Nothing about this is visible on the demo world,
    // where bodies are present from the first render.
    await mount(await engineWith(THREE()));
    const beforeOffset = offsetOfLast();

    // Let the bodies arrive.
    bodyGate?.();
    await flush();

    // PREMISE FIRST: the entries really did grow. Without this the assertion below could pass
    // against a layout that never changed.
    const afterOffset = offsetOfLast();
    expect(hydrated.size, "no body was hydrated — the test never reached its own subject").toBe(3);
    expect(
      afterOffset,
      "the entries did not grow, so this test asserts invariance against an input that never varied",
    ).toBeGreaterThan(beforeOffset);

    expect(
      scrollerTop(),
      "the reader was left where the COLLAPSED entries put them, which is inside the oldest "
        + "message — the consent decision is taken on the least current thing the sender sent",
    ).toBe(afterOffset - ANCHOR_SLACK);
  });

  it("a single held message needs no anchoring and gets none", async () => {
    // The one-message case must not scroll at all: the entry is the whole content.
    await mount(await engineWith([msg("only", "solo@example.test", 9)]));
    expect(scrollerTop()).toBe(0);
    bodyGate?.();
    await flush();
    expect(scrollerTop()).toBe(0);
  });
});

/**
 * THE COLUMN HOLDS ITS READER WHILE LETTERS CHANGE SIZE AND OLDER ONES ARRIVE (`held-window.ts`).
 * A picture loading or a frame sizing is not a body landing, so only the resize observer sees it;
 * and older letters mount above the reader as they scroll up, which must not move what they read.
 */
describe("the read column holds its letter while the letters around it change", () => {
  it("an older letter that grows keeps the newest at the anchor while the reader has not scrolled", async () => {
    await mount(await engineWith(THREE()));
    bodyGate?.();
    await flush();
    await landed();
    expect(scrollerTop(), "premise: anchored on the newest").toBe(FULL_PX * 2 - ANCHOR_SLACK);
    grown.set("oldest", FULL_PX + 300);
    await resized(card("oldest"));
    expect(scrollerTop()).toBe(FULL_PX * 2 + 300 - ANCHOR_SLACK);
  });

  it("once the reader scrolls, growth wholly above the port moves the column by that growth, and nothing else does", async () => {
    await mount(await engineWith(THREE()));
    bodyGate?.();
    await flush();
    await landed();
    const read = scroller()!;
    read.scrollTop = 700; // the reader's own scroll: the oldest letter (0–600) is above the port
    grown.set("oldest", 900);
    await resized(card("oldest"));
    expect(scrollerTop(), "the letter being read was pushed down by the growth above it").toBe(1000);
    grown.set("middle", 700); // the letter at the port top, read in place: no correction
    await resized(card("middle"));
    expect(scrollerTop()).toBe(1000);
  });

  it("older letters mounted above the reader leave the letter they read in place, while their bodies land", async () => {
    const six = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id, i) => msg(id, "stranger@example.test", 6 + i));
    await mount(await engineWith(six));
    bodyGate?.();
    await flush();
    await landed();
    const read = scroller()!;
    Object.defineProperty(read, "clientHeight", { configurable: true, get: () => 800 });
    expect(letters(), "premise: the newest three are mounted").toHaveLength(3);
    const topOf = (el: Element) => el.getBoundingClientRect().top;
    read.scrollTop = 100; // the reader scrolls up, into the first mounted letter
    const before = topOf(card("c4"));
    await act(async () => { read.dispatchEvent(new Event("scroll")); });
    await tick(60);
    await flush();
    expect(letters(), "nothing older was mounted").toHaveLength(6);
    expect(card("c1").getBoundingClientRect().height, "premise: grown before its first report").toBe(FULL_PX);
    await resized(card("c1"), card("c2"), card("c3"));
    expect(topOf(card("c4")), "the letter being read moved").toBe(before);
  });

  it("the keep, hold and step arithmetic", async () => {
    const { heldKeepTop, heldHoldShift, heldWantsMore, heldAnchored } = await import("@ohmail/app-logic/lists/held-window");
    // Keep: a card 300px further down after the prepend moves the column 300px with it.
    expect(heldKeepTop(100, -100, 200)).toBe(400);
    expect(heldKeepTop(0, 0, 0)).toBe(0);
    // Hold: only growth that was wholly above the port top counts, each card's own and the ones above it.
    expect(heldHoldShift(0, [{ bottom: 200, delta: 500 }])).toBe(500);
    expect(heldHoldShift(0, [{ bottom: 200, delta: 500 }, { bottom: 800, delta: 500 }, { bottom: 1400, delta: 500 }])).toBe(1500);
    expect(heldHoldShift(0, [{ bottom: 600, delta: 100 }]), "a card straddling the port top").toBe(0);
    expect(heldHoldShift(100, [{ bottom: 50, delta: -40 }]), "a card that shrank above the port").toBe(-40);
    // Step: near the slice top, and either scrolled or unable to scroll higher; never before layout.
    expect(heldWantsMore({ sliceTop: -100, port: 800, scrollTop: 100, scrolled: true })).toBe(true);
    expect(heldWantsMore({ sliceTop: -900, port: 800, scrollTop: 900, scrolled: true })).toBe(false);
    expect(heldWantsMore({ sliceTop: -186, port: 800, scrollTop: 186, scrolled: false }), "the anchor's own offset").toBe(false);
    expect(heldWantsMore({ sliceTop: 0, port: 800, scrollTop: 0, scrolled: false }), "a column with room to spare").toBe(true);
    expect(heldWantsMore({ sliceTop: 0, port: 0, scrollTop: 0, scrolled: true })).toBe(false);
    expect([heldAnchored(186, 187.5), heldAnchored(186, 200), heldAnchored(null, 0)]).toEqual([true, false, false]);
  });
});
