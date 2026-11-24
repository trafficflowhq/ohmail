/** @vitest-environment jsdom */
import type { EngineMessage, Folder, MessageBodyWire } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { within } from "@testing-library/react";
import {
  act, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type SyncChange,
} from "@ohmail/client-engine";
import DOMPurify from "dompurify";
import messages from "../messages/en.json";
import { HELD_BODY_STALL_MS } from "@ohmail/app-logic/screener";

/**
 * THE HELD PREVIEW DRAWS ITS BODY THROUGH THE READER'S DOOR.
 *
 * Mounted in the shell's shape: the queue keyed on the DERIVED stamp, which a body write does not
 * move, the engine provided, the chrome's `bodyOf` the door. The earlier held tests keyed the queue
 * on a version every notify moved — a state the shell never has — and read green over a preview
 * that never drew a body it had read. With no other row write, only the door can draw it.
 */

const NOW = new Date("2026-09-25T08:00:00.000Z");
let seq = 0;
let host: HTMLElement | null = null;

function held(id: string, hour: number, unread = true, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: "A Stranger", address: "stranger@example.test" },
    to: [], cc: [], date: `2026-09-25T${String(hour).padStart(2, "0")}:00:00.000Z`, folder,
    snippet: `one line of ${id}`, unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

const answer = (id: string): MessageBodyWire => ({
  text: `the whole of ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
});

/** The batch-capable adapter's extras: what the preview asked for, by request. */
interface Wire {
  /** Each `fetchBodies` request's ids. */
  batches: string[][];
  /** Each attachment list read's message id. */
  lists: string[];
  /** Every message a `move` mutation named. */
  moved: string[];
}

async function engineWith(
  seed: EngineMessage[],
  fetchBody: (id: string) => Promise<MessageBodyWire>,
  opts: { batch?: boolean; html?: boolean } = {},
) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(seed.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  const asked: string[] = [];
  const wire: Wire = { batches: [], lists: [], moved: [] };
  const full = (id: string): MessageBodyWire =>
    opts.html ? { ...answer(id), html: `<p>the whole of ${id}</p>` } : answer(id);
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async (m: { kind: string; messageId?: string }) => {
        if (m.kind === "move" && m.messageId) wire.moved.push(m.messageId);
        return { changes: [], seq: null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: (id: string) => { asked.push(id); return fetchBody(id); },
      ...(opts.batch
        ? {
          fetchBodies: async (ids: string[]) => { wire.batches.push([...ids]); return ids.map((id) => ({ ...full(id), messageId: id })); },
          listAttachments: async (id: string) => { wire.lists.push(id); return []; },
          fetchAttachment: async () => new Blob([]),
        }
        : {}),
    } as never,
  });
  return { engine, asked, wire };
}

const sectionNames = { waiting: /^Waiting/, screened: /^Screened out/, spam: /^Spam/ };
const phoneSender = () => within(host!).queryByRole("region", { name: "A Stranger" });
const openReading = () => within(host!).queryByRole("dialog", { name: messages.frame.landmark.reading })
  ?? within(host!).queryByRole("region", { name: messages.frame.landmark.reading })
  ?? phoneSender();
const region = () => openReading() ?? within(host!).getByRole("region", { name: messages.frame.landmark.reading });
const readingColumn = () => region().querySelector<HTMLElement>("[data-reading-scroll]")!;
const switchTo = (segment: keyof typeof sectionNames) => {
  const sections = within(host!).getByRole("group", { name: messages.screener.segAria });
  within(sections).getByRole("button", { name: sectionNames[segment] }).click();
};
async function mount(
  engine: OhmailEngine, segment: keyof typeof sectionNames = "waiting", as: "view" | "warmup" = "view",
): Promise<void> {
  window.location.hash = as === "warmup" ? "#/ohbox" : `#/screener/${segment}`;
  await engine.start();
  host = await mountShell([mailbox({ id: "mb", lastSyncAt: NOW.toISOString() })], { engine, junkWire: "none" });
  await tick(500);
}

const articles = (): HTMLElement[] => {
  const reading = openReading();
  return reading ? within(reading).queryAllByRole("article") : [];
};
const bodyText = (el: HTMLElement): string => el.textContent ?? "";
const note = (el: HTMLElement) => within(el).queryByRole("status");
const noteOf = (el: HTMLElement): string => note(el)?.textContent ?? "";
const retry = (el: HTMLElement) => within(el).getByRole("button", { name: messages.screener.retry });

beforeEach(() => {
  installShellEnv();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  // Restore the primer's frame stubs while the fake clock still owns the original callbacks.
  vi.unstubAllGlobals();
  await teardownShellEnv();
  host = null;
});

describe("a held body that was read is drawn, with nothing else moving", () => {
  it("the landed body reaches the preview, and no stall face follows it", async () => {
    const { engine, asked } = await engineWith([held("h1", 6), held("h2", 7)], async (id) => answer(id));
    await mount(engine);
    await act(async () => { await vi.advanceTimersByTimeAsync(HELD_BODY_STALL_MS + 1_000); });
    expect(asked.sort(), "premise: the selection read both held bodies").toEqual(["h1", "h2"]);
    const [a, b] = articles();
    expect(bodyText(a!)).toContain("the whole of h1");
    expect(bodyText(b!)).toContain("the whole of h2");
    expect(noteOf(a!) + noteOf(b!)).not.toContain(messages.screener.place.bodyFailed);
  });
});

describe("Retry is a new attempt, and the preview shows that attempt", () => {
  it("after a failed read, Retry asks again, reads as loading, then draws the text", async () => {
    let release!: () => void;
    const late = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const { engine, asked } = await engineWith([held("h1", 6)], async (id) => {
      calls += 1;
      if (calls === 1) throw new Error("the mail engine answered 500");
      await late;
      return answer(id);
    });
    await mount(engine);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const [only] = articles();
    expect(noteOf(only!), "premise: the first read failed").toBe(messages.screener.place.bodyFailed + messages.screener.retry);
    await act(async () => { retry(only!).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(asked, "Retry made no new attempt").toEqual(["h1", "h1"]);
    expect(noteOf(articles()[0]!)).toContain("Loading the full message");
    release();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(bodyText(articles()[0]!)).toContain("the whole of h1");
    expect(note(articles()[0]!)).toBeNull();
  });

  it("a Retry that fails too says so, with its own Retry", async () => {
    const { engine, asked } = await engineWith([held("h1", 6)], async () => {
      throw new Error("the mail engine answered 500");
    });
    await mount(engine);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { retry(articles()[0]!).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(asked).toEqual(["h1", "h1"]);
    expect(noteOf(articles()[0]!)).toBe(messages.screener.place.bodyFailed + messages.screener.retry);
    expect(within(articles()[0]!).queryByRole("button", { name: messages.screener.retry }), "the second failure lost its control").not.toBeNull();
  });
});

describe("the waiting row says whether its held mail was read", () => {
  const rowDesc = (): string =>
    within(host!).getByRole("option", { name: /^A Stranger:/ }).getAttribute("aria-description") ?? "";

  it("unread held mail is spoken Unread; read held mail is spoken Read", async () => {
    const { engine } = await engineWith([held("h1", 6)], async (id) => answer(id));
    await mount(engine);
    expect(rowDesc()).toMatch(/\bUnread\b/);
    await teardownShellEnv();
    installShellEnv();
    vi.setSystemTime(NOW);
    const { engine: readEngine } = await engineWith([held("r1", 6, false)], async (id) => answer(id));
    await mount(readEngine);
    expect(rowDesc()).toMatch(/\bRead\b/);
    expect(rowDesc()).not.toMatch(/\bUnread\b/);
  });
});

/**
 * A TAB CLICK MOUNTS THE NEWEST LETTERS, NOT THE WHOLE BAG (`held-window.ts`). Entering Screened out
 * or Spam selects the newest sender, and every one of their letters used to mount in the click's own
 * commit: a sanitize pass, a frame, a body request and an attachment list read per letter.
 */
const FOLDER = { screened: "ohmail/Screened", spam: "ohmail/Quarantine" } as const;
const ids = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `m${String(from + i).padStart(2, "0")}`);
/** One sender's bag, oldest first: m01 … m<n>, an hour apart the day before. */
const bag = (folder: Folder, n = 12): EngineMessage[] =>
  ids(1, n).map((id, i) => ({ ...held(id, 0, true, folder), date: new Date(Date.parse("2026-09-24T00:00:00.000Z") + i * 3_600_000).toISOString() }));
const subjects = (): string[] => articles().map((a) => a.querySelector("h2")?.textContent ?? "");
async function settle(): Promise<void> {
  await tick(80);
}
/**
 * The read column, laid out: 800px tall, every letter 600px, `scrollTop` a real offset. With
 * `heightOf`, letters take that height and `scrollTop` clamps to the content, as a browser's does.
 */
function modelColumn(heightOf?: (card: Element) => number): { scrollTo: (top: number) => Promise<void> } {
  const read = readingColumn();
  const letterPx = heightOf ?? (() => 600);
  const content = () => [...read.querySelectorAll<Element>("article")].reduce((sum, c) => sum + letterPx(c), 0);
  let top = 0;
  Object.defineProperty(read, "scrollTop", { configurable: true, get: () => top, set: (v: number) => {
    top = Math.max(0, heightOf ? Math.min(v, content() - 800) : v);
  } });
  Object.defineProperty(read, "clientHeight", { configurable: true, get: () => 800 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect(this: Element) {
    const cards = [...read.querySelectorAll<Element>("article")];
    const i = cards.indexOf(this);
    const y = this === read ? 0 : i >= 0 ? cards.slice(0, i).reduce((sum, c) => sum + letterPx(c), 0) - top : 0;
    const height = this === read ? 800 : i >= 0 ? letterPx(this) : 0;
    return { top: y, bottom: y + height, height, left: 0, right: 0, width: 0, x: 0, y, toJSON: () => ({}) } as DOMRect;
  });
  return {
    scrollTo: async (t: number) => {
      top = t;
      await act(async () => { read.dispatchEvent(new Event("scroll")); });
      await settle();
    },
  };
}

/**
 * The phone's read column: drawn (800px, letters `letterPx` each, `scrollTop` clamped to the
 * content) only as the open sheet, all zeros while hidden. Its resize observer reports as layout
 * does: each observed element whose height moved since its last report, on `layout()`.
 */
function modelSheet(letterPx: number): () => Promise<void> {
  const tops = new WeakMap<Element, number>();
  const isColumn = (el: Element) => el.hasAttribute("data-reading-scroll");
  const drawn = (el: Element) => el.closest('[role="region"][aria-label="A Stranger"]') !== null;
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function height(this: Element) {
    return isColumn(this) && drawn(this) ? 800 : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function get(this: Element) { return tops.get(this) ?? 0; });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function set(this: Element, v: number) {
    const max = isColumn(this) && drawn(this) ? Math.max(0, this.querySelectorAll("article").length * letterPx - 800) : 0;
    tops.set(this, Math.min(max, Math.max(0, v)));
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect(this: Element) {
    const read = this.closest("[data-reading-scroll]");
    const on = read !== null && drawn(read);
    const i = read ? [...read.querySelectorAll<Element>("article")].indexOf(this) : -1;
    const y = on && i >= 0 ? i * letterPx - (tops.get(read!) ?? 0) : 0;
    const height = !on ? 0 : this === read ? 800 : i >= 0 ? letterPx : 0;
    return { top: y, bottom: y + height, height, left: 0, right: 0, width: 0, x: 0, y, toJSON: () => ({}) } as DOMRect;
  });
  const observers = new Set<{ cb: ResizeObserverCallback; seen: Map<Element, number> }>();
  vi.stubGlobal("ResizeObserver", class {
    private readonly o: { cb: ResizeObserverCallback; seen: Map<Element, number> };
    constructor(cb: ResizeObserverCallback) { this.o = { cb, seen: new Map() }; observers.add(this.o); }
    observe(el: Element): void { this.o.seen.set(el, 0); }
    unobserve(el: Element): void { this.o.seen.delete(el); }
    disconnect(): void { observers.delete(this.o); }
  });
  return async () => {
    await act(async () => {
      for (const col of document.querySelectorAll("[data-reading-scroll]")) if (!drawn(col)) tops.delete(col); // hidden, it loses its offset
      for (const o of observers) {
        const moved = [...o.seen].filter(([el, was]) => el.isConnected && el.getBoundingClientRect().height !== was);
        for (const [el] of moved) o.seen.set(el, el.getBoundingClientRect().height);
        if (moved.length > 0) o.cb(moved.map(([target]) => ({ target }) as ResizeObserverEntry), null as never);
      }
    });
  };
}

describe("a sender's held letters open on the newest three", () => {
  it.each(["screened", "spam"] as const)("%s: twelve letters mount the newest three, and only those are asked for", async (segment) => {
    const { engine, wire } = await engineWith(bag(FOLDER[segment]), async (id) => answer(id), { batch: true });
    await mount(engine, segment);
    await settle();
    expect(subjects()).toEqual(ids(10, 12).map((id) => `Subject ${id}`));
    expect(wire.batches.flat().sort(), "bodies asked for letters nobody can see").toEqual(ids(10, 12));
    expect([...wire.lists].sort(), "attachment lists read for letters nobody can see").toEqual(ids(10, 12));
    const countSurface = segment === "screened" ? region() : within(host!).getByRole("listbox", { name: messages.screener.title });
    expect(within(countSurface).getByText("12 held", { exact: true })).toBeTruthy();
    expect(articles().map((article) => article.getAttribute("aria-setsize"))).toEqual(["12", "12", "12"]);
  });

  it("reaching the top of the column mounts three older letters and asks for their bodies, until all twelve are on screen", async () => {
    const { engine, wire } = await engineWith(bag(FOLDER.screened), async (id) => answer(id), { batch: true });
    await mount(engine, "screened");
    await settle();
    expect(articles(), "premise: the column opens on three").toHaveLength(3);
    const column = modelColumn();
    for (const [step, want] of [ids(7, 9), ids(4, 6), ids(1, 3)].entries()) {
      await column.scrollTo(0);
      expect(articles()).toHaveLength(6 + step * 3);
      expect([...wire.batches.at(-1)!].sort(), "one request for the letters the step mounted").toEqual(want);
    }
    expect(subjects()).toEqual(ids(1, 12).map((id) => `Subject ${id}`));
    expect(wire.batches).toHaveLength(4);
    expect(host!.textContent).not.toMatch(/\d+ more\b/i);
    const [first] = articles();
    expect([first!.getAttribute("aria-posinset"), first!.getAttribute("aria-setsize")]).toEqual(["1", "12"]);
    expect(within(region()).getByRole("feed").getAttribute("role")).toBe("feed");
  });

  it("switching away from Screened out and back sanitizes nothing again", async () => {
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    const { engine } = await engineWith(bag(FOLDER.screened, 3), async (id) => answer(id), { batch: true, html: true });
    await mount(engine, "screened");
    await settle();
    const passes = sanitize.mock.calls.length;
    expect(passes, "premise: the letters' html was sanitized once").toBeGreaterThan(0);
    await act(async () => { switchTo("spam"); });
    await settle();
    await act(async () => { switchTo("screened"); });
    await settle();
    expect(articles(), "premise: the same letters are back").toHaveLength(3);
    expect(sanitize.mock.calls.length - passes, "a revisit sanitized the letters again").toBe(0);
  });

  /* The tab's commit carries the rows and the letters' heads; the bodies (a sanitize pass and a
     frame each) follow once that frame has painted. jsdom paints nothing, so the column gets a box,
     and frames run only when `frames` says. */
  let queued = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const boxColumn = () => {
    const rects = Element.prototype.getClientRects;
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function boxes(this: Element) {
      return this.hasAttribute("data-reading-scroll") ? [{ top: 0, bottom: 800, height: 800 }] as unknown as DOMRectList : rects.call(this);
    });
    queued = new Map();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { queued.set(++frameId, cb); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { queued.delete(id); });
  };
  const frames = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const due = [...queued.values()];
      queued = new Map();
      await act(async () => {
        for (const cb of due) cb(performance.now());
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  };
  it.each(["screened", "spam"] as const)("%s: a tab click draws the rows before any letter's body", async (segment) => {
    const { engine } = await engineWith(bag(FOLDER[segment], 3), async (id) => answer(id), { batch: true, html: true });
    await engine.hydrateBodies(ids(1, 3));
    await mount(engine, "waiting");
    await settle();
    boxColumn();
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    await act(async () => { switchTo(segment); });
    expect(within(host!).getAllByRole("option", { name: /^A Stranger:/ }), "the rows missed the click's commit").toHaveLength(1);
    expect(subjects(), "the letters' heads missed the click's commit").toEqual(ids(1, 3).map((id) => `Subject ${id}`));
    expect(sanitize, "a letter was sanitized before the rows painted").not.toHaveBeenCalled();
    await frames(3);
    expect(sanitize, "the bodies never followed").toHaveBeenCalled();
    for (const [i, a] of articles().entries()) expect(bodyText(a)).toContain(`the whole of ${ids(1, 3)[i]}`);
  });

  it.each(["screened", "spam"] as const)("%s: a tab click reads no letter's file list before its body is drawn", async (segment) => {
    const { engine, wire } = await engineWith(bag(FOLDER[segment], 3), async (id) => answer(id), { batch: true, html: true });
    await engine.hydrateBodies(ids(1, 3));
    await mount(engine, "waiting");
    await settle();
    boxColumn();
    await act(async () => { switchTo(segment); });
    expect(wire.lists, "a file list was read in the click's own commit").toEqual([]);
    await frames(3);
    expect([...wire.lists].sort(), "the file lists never followed the bodies").toEqual(ids(1, 3));
  });

  it("once the queue settles, the segments not on screen are drawn hidden for one frame, and nothing is asked for them", async () => {
    const spam = bag(FOLDER.spam, 2).map((m, i) => ({ ...m, id: `q${i + 1}`, subject: `Spam q${i + 1}`, from: { name: "A Spammer", address: "spam@example.test" } }));
    const { engine, wire } = await engineWith([...bag(FOLDER.screened, 3), ...spam], async (id) => answer(id), { batch: true });
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function boxes(this: Element) {
      return ((this === document.body || this.matches("[data-reading-scroll]")) ? [{ top: 0, bottom: 800, height: 800 }] : []) as unknown as DOMRectList;
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { queued.set(++frameId, cb); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { queued.delete(id); });
    await mount(engine, "waiting");
    await settle();
    const prime = () => host!.querySelector<HTMLElement>(".sc-primer");
    expect(prime(), "primed before the Screener painted").toBeNull();
    await frames(1);
    const p = prime();
    expect(p, "the other segments were never drawn ahead of their click").not.toBeNull();
    expect([p!.hasAttribute("inert"), p!.getAttribute("aria-hidden")]).toEqual([true, "true"]);
    expect(p!.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect([...p!.querySelectorAll("article h2")].map((x) => x.textContent)).toEqual(
      ["Subject m01", "Subject m02", "Subject m03", "Spam q1", "Spam q2"]);
    expect(p!.querySelector(".mb")?.childElementCount ?? 0, "a primed letter drew its body").toBe(0);
    const list = within(host!).queryByRole("listbox", { name: messages.screener.title });
    expect(list ? within(list).queryAllByRole("option") : [], "a primed row joined the list").toHaveLength(0);
    await frames(1);
    expect(prime(), "the primed segments outlived their frame").toBeNull();
    expect([wire.batches, wire.lists], "something was asked for a primed letter").toEqual([[], []]);
  });

  /* THE SHELL'S WARM-UP, for the Screener's first open: the page has a box, frames run when told,
     and the quiet the warm-up waits for is timed. */
  const warmWorld = async () => {
    const spam = bag(FOLDER.spam, 2).map((m, i) => ({ ...m, id: `q${i + 1}`, subject: `Spam q${i + 1}`, from: { name: "A Spammer", address: "spam@example.test" } }));
    return engineWith([held("w1", 6), ...bag(FOLDER.screened, 3), ...spam], async (id) => answer(id), { batch: true });
  };
  const warmPage = () => {
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function boxes(this: Element) {
      return (this === document.body ? [{ top: 0, bottom: 900, height: 900 }] : []) as unknown as DOMRectList;
    });
    queued = new Map();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { queued.set(++frameId, cb); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { queued.delete(id); });
  };
  /** Mounted on a page with a box; the queue settles on real timers, then the quiet is timed. */
  const mountWarm = async (engine: OhmailEngine) => {
    warmPage();
    await mount(engine, "waiting", "warmup");
    await settle();
  };
  const paint = async () => {
    const due = [...queued.values()];
    queued = new Map();
    await act(async () => {
      for (const cb of due) cb(performance.now());
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const primed = () => host!.querySelector<HTMLElement>(".sc-primer");
  /** What the primer on screen draws: its segment, and which half (the list's row or the letters' heads). */
  const piece = () => {
    const p = primed();
    if (!p) return null;
    const row = p.querySelector('[role="option"]')?.getAttribute("data-id") ?? null;
    const heads = [...p.querySelectorAll("article h2")].map((x) => x.textContent);
    return { row, heads };
  };

  it("before the Screener is first shown, the shell draws each segment's halves hidden, a frame each, once the page is quiet", async () => {
    const quiet = 400;
    const { engine, wire, asked } = await warmWorld();
    await mountWarm(engine);
    await paint();
    await tick(quiet - 1);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); });
    await tick(quiet - 1);
    expect(primed(), "primed while the page was in use").toBeNull();
    const drawn: Array<ReturnType<typeof piece>> = [];
    for (let i = 0; i < 6; i++) {
      await tick(quiet);
      drawn.push(piece());
      const p = primed();
      expect(p, `piece ${i + 1} was never drawn`).not.toBeNull();
      expect([p!.hasAttribute("inert"), p!.getAttribute("aria-hidden")]).toEqual([true, "true"]);
      expect(within(p!).queryAllByRole("option")).toEqual([]);
      expect(within(p!).queryAllByRole("article")).toEqual([]);
      expect(p!.querySelector(".mb")?.childElementCount ?? 0, "a primed letter drew its body").toBe(0);
      await paint();
      expect(primed(), `piece ${i + 1} outlived its frame`).toBeNull();
      await paint();
    }
    expect(drawn.map((d) => [d!.row !== null, d!.heads.length > 0]), "each segment's list, then its letters").toEqual([
      [true, false], [false, true], [true, false], [false, true], [true, false], [false, true],
    ]);
    expect(drawn[3]!.heads).toEqual(["Subject m01", "Subject m02", "Subject m03"]);
    expect(drawn[5]!.heads).toEqual(["Spam q1", "Spam q2"]);
    for (let i = 0; i < 3; i++) { await tick(quiet); await paint(); }
    expect(primed(), "the warm-up ran twice").toBeNull();
    expect([asked, wire.batches, wire.lists], "something was asked for a primed letter").toEqual([[], [], []]);
  });

  it("a Screener already on screen is never primed by the shell", async () => {
    const quiet = 400;
    const { engine } = await warmWorld();
    await mountWarm(engine);
    let drawn = 0;
    const watch = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element && n.matches(".sc-primer")) drawn += 1;
    });
    watch.observe(host!, { childList: true, subtree: true });
    await goTo("screener");
    await goTo("ohbox");
    for (let i = 0; i < 8; i++) { await paint(); await tick(quiet); }
    watch.disconnect();
    expect(drawn, "a primer was drawn after the Screener had been on screen").toBe(0);
  });

  it("the letters drawn without their bodies mount no older ones", async () => {
    const { engine } = await engineWith(bag(FOLDER.screened), async (id) => answer(id), { batch: true, html: true });
    await engine.hydrateBodies(ids(10, 12));
    await mount(engine, "waiting");
    await settle();
    boxColumn();
    await act(async () => { switchTo("screened"); });
    modelColumn((card) => (card.querySelector(".mb")?.childElementCount ? 600 : 60));
    await frames(4);
    expect(articles()[0]!.querySelector(".mb")!.childElementCount, "premise: the bodies are drawn").toBeGreaterThan(0);
    expect(subjects(), "three short heads read as a column with room").toEqual(ids(10, 12).map((id) => `Subject ${id}`));
  });

  /** A phone: the auto-selected sender's letters mount behind the closed sheet; `tap` opens it. */
  async function onPhone(letterPx: number) {
    vi.stubGlobal("innerWidth", 390);
    const layout = modelSheet(letterPx);
    const { engine } = await engineWith(bag(FOLDER.screened), async (id) => answer(id), { batch: true });
    await mount(engine, "screened");
    await settle();
    await layout();
    const press = async (control: HTMLElement) => {
      await act(async () => { control.click(); });
      await settle();
      await layout();
      await settle();
    };
    return {
      tap: () => press(within(host!).getByRole("option", { name: /^A Stranger:/ })),
      back: () => press(within(region()).getByRole("button", { name: messages.screener.title })),
      scrollTo: async (top: number) => {
        const read = readingColumn();
        read.scrollTop = top;
        await act(async () => { read.dispatchEvent(new Event("scroll")); });
        await settle();
        await layout();
      },
    };
  }

  it("on a phone, opening the auto-selected sender's sheet mounts older letters when the newest three fit", async () => {
    const phone = await onPhone(150);
    await phone.tap();
    expect(phoneSender(), "premise: the sheet is open").toBeTruthy();
    expect(articles().length, "older letters stayed unreachable in a sheet that cannot scroll").toBeGreaterThan(3);
    for (let i = 0; i < 4 && articles().length < 12; i++) await phone.scrollTo(0);
    expect(subjects()).toEqual(ids(1, 12).map((id) => `Subject ${id}`));
  });

  it("on a phone, closing and reopening the sheet leaves the column where the browser puts it", async () => {
    const phone = await onPhone(600);
    await phone.tap();
    expect(subjects()[0]).toBe("Subject m10");
    await phone.scrollTo(700);
    // The lookahead prepends three letters before the sheet is closed.
    expect(subjects()[0]).toBe("Subject m07");
    await phone.back();
    expect(phoneSender(), "premise: the sheet closed").toBeNull();
    await phone.tap();
    // Another three cards joined during reopening. Holding the old first card moves the pixel offset by their height.
    expect(subjects()[0]).toBe("Subject m04");
    expect(readingColumn().scrollTop).toBe(3 * 600);
    const atTop = articles().find((a) => a.getBoundingClientRect().top === 0);
    expect(atTop?.querySelector("h2")?.textContent, "the letters reappearing were taken for growth above the reader").toBe("Subject m07");
  });
});

/**
 * THE ONE DOOR, CENSUSED. The reader and the held preview draw through `useDrawnBody`, the shell
 * hands the chrome ONE `bodyOf`, and no view draws a body another way — the shape that let the
 * preview draw the queue's copy while the reader drew the record.
 */
describe("the held preview and the reader call one door", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  it("MessagePane, MessageCard and HeldMail each draw through useDrawnBody, and only it", () => {
    for (const rel of ["../../../packages/app/src/reader/Letter.tsx", "../../../packages/app/src/reader/entry.tsx", "../../../packages/app/src/screener/held/HeldLetter.tsx"]) {
      const src = read(rel);
      expect(src, `${rel} does not draw through the one door`).toMatch(/useLetterBody\s*\(/);
      expect(src, `${rel} draws a body past the door`).not.toMatch(/(?:^|[^\w.])bodyOf\s*\(|\.bodyOf\s*\(/m);
    }
    const view = read("../../../packages/app/src/screener/held/HeldLetter.tsx");
    const heldMail = view.slice(view.indexOf("function HeldLetterContent("));
    expect(heldMail, "HeldMail lost its door").toMatch(/useLetterBody\s*\(\s*asMessage\(letter\)/);
  });
  it("the shell hands the chrome the one function every drawn body reads", async () => {
    const letter = held("shared-letter", 6);
    const { engine, asked, wire } = await engineWith(
      [{ ...letter, accountId: "acct_live_1" }], async (id) => answer(id), { batch: true },
    );
    window.location.hash = "#/screener";
    const mounted = within(await mountShell([mailbox({ id: "mb", lastSyncAt: NOW.toISOString() })], { engine }));
    const waiting = mounted.getByRole("listbox", { name: "Screener" });
    await act(async () => { within(waiting).getByRole("option", { name: /A Stranger: Subject shared-letter/ }).click(); });
    await tick(300);
    const reading = () => within(mounted.getByRole("region", { name: "Reading" }));
    expect(reading().getByText("the whole of shared-letter")).toBeTruthy();
    expect([...wire.batches.flat(), ...asked]).toEqual(["shared-letter"]);

    await goTo("history/m/shared-letter");
    await tick(300);
    expect(reading().getByRole("region", { name: "Open message" })).toBeTruthy();
    expect(reading().getByText("the whole of shared-letter")).toBeTruthy();
    expect([...wire.batches.flat(), ...asked]).toEqual(["shared-letter"]);
  });
});
