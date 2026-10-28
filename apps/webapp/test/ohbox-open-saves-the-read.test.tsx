/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, MemoryMirrorStore, OhmailEngine, ohboxView, type EngineMessage, type MirrorRecord, type SyncChange } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * AN OPEN SAVES THE READ. The screen never claims a read the account does not hold: once the
 * thread-read rule reads a message in an entered conversation (an open, a click on its row) the
 * `mark_seen` is on its way, not owed to a departure; a j/k preview reads nothing. What waits for
 * the departure is the row's PLACE, so nothing re-sorts under the reader. The reload cases model an
 * IndexedDB outbox: its commit lands in a LATER task, so a write first made inside `pagehide`
 * reaches neither the disk nor the wire before the page is gone. The reader is laid out here
 * (`fixtures/thread-layout.ts`), so an open message's lines are on screen.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DWELL_MS = 2000;
/** Comfortably past the 280 ms slide. */
const AFTER_SLIDE_MS = 400;

function setViewport(mobile = false): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"), media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; date: string; openReadAt?: string | null }

function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date, folder: "INBOX", snippet: `snip-${m.id}`, body: `the words of ${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: m.date,
    ...(m.openReadAt !== undefined ? { openReadAt: m.openReadAt } : {}),
  };
}

/** The instant the model stamps an open read at — after every fixture row. */
const READ_AT = "2026-08-02T09:10:00.000Z";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** The mirror; a save writes it the way the engine's optimistic overlay does. */
let live: Row[] = [];
let sel: string | null = null;
/** `ok` = the shell's `markSeen` answers true; `refused` = false and the overlay rolled back. */
let answer: "ok" | "refused" = "ok";
const marked: Array<{ ids: string[]; unread: boolean; via?: "glance" }> = [];
/** What the shell held at the moment of each save — the hold must already be there. */
const heldAtSave: Array<string | null> = [];

/**
 * THE SHELL'S HOLD, modelled: the view reports the row it entered (`onHoldRow`) and the shell has
 * the engine hold that row in New (`holdOpenRow`, only while it is unread then), deriving
 * the groups through `ohboxView`'s one rule — `unread || id === held` (pinned on the real
 * selector in `packages/client-engine/test/ohbox-open-row-keeps-its-place.test.ts`).
 */
let held: string | null = null;
const holdArmed = (id: string | null): void => {
  held = id !== null && live.find((r) => r.id === id)?.unread === true ? id : null;
};

/**
 * The groups, through the REAL selector over the modelled rows: `ohboxView(mirror, held)` — the
 * New rule and the place in Earlier, an open read lifting its row. The stamp itself is modelled
 * here (a read of exactly the held row, which was unread; the engine's rule is pinned in
 * `packages/client-engine/test/earlier-takes-the-open-read.test.ts`).
 */
async function groups(): Promise<{ newForYou: EngineMessage[]; previouslySeen: EngineMessage[] }> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(live.map((r): SyncChange => ({
    type: "message", op: "create", id: r.id, seq: ++seq, updatedAt: r.date, entity: msg(r),
  })));
  const v = ohboxView(store, held);
  return { newForYou: v.newForYou, previouslySeen: v.previouslySeen };
}

async function draw(): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const g = await groups();
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:10:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
      owed: false, demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      newForYou: g.newForYou,
      previouslySeen: g.previouslySeen,
      onHoldRow: holdArmed,
      tags: [], now: new Date("2026-08-02T09:10:00.000Z"),
      selectedId: sel,
      onSelect: (id: string) => { sel = id; },
      // The shell's set: the conversation's unread members (here, the one message while unread).
      onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => (live.find((r) => r.id === id)?.unread ? [id] : []),
      onMarkSeen: (ids: string[], unread: boolean, via?: "glance"): Promise<boolean> => {
        heldAtSave.push(held);
        marked.push({ ids, unread, ...(via ? { via } : {}) });
        if (answer === "refused") return Promise.resolve(false);
        const openRead = !unread && held !== null && ids.every((id) => id === held);
        for (const id of ids) {
          const row = live.find((r) => r.id === id);
          if (!row) continue;
          if (unread) row.openReadAt = null;
          else if (openRead && row.unread) row.openReadAt = READ_AT;
          row.unread = unread;
        }
        return Promise.resolve(true);
      },
      bulk: { run: () => true, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => true },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

async function mount(rows: Row[]): Promise<void> {
  live = rows.map((r) => ({ ...r }));
  sel = null;
  held = null;
  await draw();
}

function rowEl(id: string): HTMLElement {
  const el = host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}
const idsInGroup = (label: string): string[] =>
  [...(host!.querySelector(`[role="listbox"][aria-label="${label}"]`)?.querySelectorAll(".row[data-id]") ?? [])]
    .map((r) => (r as HTMLElement).dataset.id!);
const verb = (): string => host!.querySelector(".abar-read-g button.abar-read")?.textContent ?? "";
const count = (): string | null => /(\d+) unread/.exec(host!.textContent ?? "")?.[1] ?? null;
/** The row presents unread: its dot and weight (`data-unseen`). */
const looksUnread = (id: string): boolean => rowEl(id).dataset.unseen === "1";

async function click(id: string): Promise<void> {
  await act(async () => { rowEl(id).click(); });
  await draw();
  await act(async () => { vi.advanceTimersByTime(20); });   // a frame: the rule looks
  await draw();
}
async function key(k: string): Promise<void> {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  await draw();
  await act(async () => { vi.advanceTimersByTime(20); });
  await draw();
}
async function wait(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await draw();
}
/** Another tab, or the phone's app switcher: hidden, with no `pagehide` and maybe no return. */
async function hideTab(): Promise<void> {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await draw();
}
async function closeTab(): Promise<void> {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  await draw();
}

const A = { id: "a", unread: true, date: "2026-08-02T09:03:00.000Z" };
const B = { id: "b", unread: true, date: "2026-08-02T09:02:00.000Z" };
const C = { id: "c", unread: false, date: "2026-08-02T09:01:00.000Z" };
const glance = (id: string) => ({ ids: [id], unread: false, via: "glance" as const });

let layout: ThreadLayout;
beforeEach(() => {
  vi.useFakeTimers();
  layout = stubThreadLayout();
  setViewport(false);
  answer = "ok";
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null; live = []; sel = null;
  marked.length = 0;
  heldAtSave.length = 0;
  Reflect.deleteProperty(document, "visibilityState");
  layout.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the Ohbox saves a read when it shows one", () => {
  it("an open saves the read once its top was on screen for the dwell, and nobody has to open a second message", async () => {
    await mount([A, B, C]);
    await click("a");                        // a click enters: the message on screen is read…
    expect(marked, "the write waits for the dwell").toEqual([]);
    await layout.passDwell();                // …once its top was on screen for the dwell
    await draw();
    expect(marked, "the read the row shows was never sent").toEqual([glance("a")]);
    await click("a");                        // …a second click opens again and writes nothing more
    expect(marked).toEqual([glance("a")]);
    expect(looksUnread("a")).toBe(false);
    expect(verb()).toContain("Mark unread");
    expect(count(), "the count still counts the message the row shows as read").toBe("1");
  });

  it("a j preview left within the rest saves nothing; a click on the row then reads it", async () => {
    await mount([A, B, C]);
    await key("j");
    await wait(1000);
    expect(marked).toEqual([]);
    expect(looksUnread("a")).toBe(true);
    await click("a");
    await layout.passDwell();
    await draw();
    expect(marked).toEqual([glance("a")]);
    expect(looksUnread("a")).toBe(false);
    expect(count()).toBe("1");
    expect(sel, "still the message on screen").toBe("a");
  });

  it("a j preview rested on saves the read and the row shows it", async () => {
    await mount([A, B, C]);
    await key("j");
    await wait(DWELL_MS * 5);
    await draw();
    expect(marked).toEqual([glance("a")]);
    expect(looksUnread("a")).toBe(false);
    expect(count()).toBe("1");
  });

  it("walking past a row is not a read, and the row never claimed one", async () => {
    await mount([A, B, C]);
    await key("j");
    await wait(800);
    expect(looksUnread("a"), "a preview is not a reading").toBe(true);
    await key("j");
    await wait(800);
    expect(marked).toEqual([]);
    expect(looksUnread("a")).toBe(true);
    expect(count()).toBe("2");
  });

  it("hiding the tab finds the read already saved, and closing it writes nothing twice", async () => {
    await mount([A, B, C]);
    await click("a");
    await layout.passDwell();
    await draw();
    await hideTab();
    expect(marked, "a hidden tab the system discards loses the read").toEqual([glance("a")]);
    await closeTab();
    expect(marked).toEqual([glance("a")]);
  });

  it("a refused save takes the read look back: row, verb and count agree on unread", async () => {
    answer = "refused";
    await mount([A, B, C]);
    await click("a");
    await layout.passDwell();
    await wait(0);
    expect(marked).toEqual([glance("a")]);
    expect(looksUnread("a"), "the row claims a read the account refused").toBe(true);
    expect(verb()).toContain("Mark read");
    expect(count()).toBe("2");
  });
});

describe("the order after a read is the order before it", () => {
  it("the hold reaches the shell BEFORE the read is saved, on every open", async () => {
    // The desktop measured the other order: the save's paint rendered first, with nothing held,
    // and the row slid out of New while it was being read. The hold must precede the save.
    await mount([A, B, C]);
    await click("a");
    await wait(DWELL_MS + 100);
    await click("b");
    await layout.passDwell();
    await draw();
    expect(marked).toEqual([glance("a"), glance("b")]);
    expect(heldAtSave, "a save went out before its row was held").toEqual(["a", "b"]);
  });

  it("the open row keeps its slot while read, then files at the top of Earlier when left", async () => {
    // `a` arrived BEFORE `c`: at arrival it would file below it, so the top is the open read's.
    const OLD_A = { ...A, date: "2026-08-02T09:00:00.000Z" };
    await mount([OLD_A, B, C]);
    expect(idsInGroup("New")).toEqual(["b", "a"]);
    await click("a");
    await click("a");
    await layout.passDwell();
    await wait(AFTER_SLIDE_MS);
    expect(idsInGroup("New"), "the saved read moved the row under the reader").toEqual(["b", "a"]);
    expect(idsInGroup("Earlier")).toEqual(["c"]);
    await key("j");                          // the departure (a preview of b) releases the place
    await wait(AFTER_SLIDE_MS);
    expect(idsInGroup("New")).toEqual(["b"]);
    expect(idsInGroup("Earlier"), "read here, it takes the top of Earlier").toEqual(["a", "c"]);
    expect(marked, "leaving writes nothing more").toEqual([glance("a")]);
  });

  it("CONTROL: a row read by a sync change, not here, stays below a newer row at its arrival", async () => {
    const D = { id: "d", unread: false, date: "2026-08-02T09:05:00.000Z" };
    await mount([B, D, { ...C, unread: true }]);
    expect(idsInGroup("Earlier")).toEqual(["d"]);
    // Read in another client: the drain flips the flag and stamps nothing.
    live.find((r) => r.id === "c")!.unread = false;
    await draw();
    await wait(AFTER_SLIDE_MS);
    expect(idsInGroup("Earlier"), "arrival order: the sync read placed nothing").toEqual(["d", "c"]);
  });
});

/* ── the whole shell over an engine whose outbox commits a task later, like IndexedDB ────── */

/** What reached the disk, in order. `transact` resolves on a later timer tick, never in the task. */
class LaterTaskDisk extends MemoryMirrorStore {
  readonly disk: string[] = [];
  protected override async transact(...args: unknown[]): Promise<void> {
    const [puts = [], deletes = []] = args as [MirrorRecord[]?, string[]?];
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    for (const p of puts) this.disk.push(`put ${p.type}`);
    for (const d of deletes) this.disk.push(`delete ${d}`);
  }
}

let wire: Array<{ kind: string; ids: string[]; unread?: boolean; via?: string }> = [];

async function mountShell(engine: OhmailEngine): Promise<void> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  window.location.hash = "#/ohbox";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(AppShell as never, { demo: false, engine } as never) }),
      }),
    }));
  });
  for (let i = 0; i < 12; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

function spyWire(): void {
  wire = [];
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (this: FixturesAdapter, m, opts) {
    const r = m as { kind: string; messageIds?: string[]; unread?: boolean; via?: string };
    wire.push({ kind: r.kind, ids: r.messageIds ?? [], unread: r.unread, via: r.via });
    return real.call(this, m, opts);
  });
}

const firstUnreadRow = (): HTMLElement => {
  const row = host!.querySelector<HTMLElement>('.row[data-unseen="1"][data-id]');
  if (!row) throw new Error("the fixture Ohbox shows no unread row");
  return row;
};

describe("through the whole shell: the read survives a reload", () => {
  it("an open puts the read on disk and on the wire while the message is still open", async () => {
    spyWire();
    const store = new LaterTaskDisk();
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, storePolicy: { mode: "full" } });
    await mountShell(engine);
    const row = firstUnreadRow();
    const id = row.dataset.id!;
    const before = Number(count());
    await act(async () => { row.click(); });
    await act(async () => { firstRow(id).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });   // the reader looks: the dwell starts
    await layout.passDwell();                                            // its top on screen for the dwell: read
    expect(wire.filter((w) => w.kind === "mark_seen" && w.ids.includes(id)), "the read never left the tab")
      .toEqual([{ kind: "mark_seen", ids: [id], unread: false, via: "glance" }]);
    expect(store.disk.some((d) => d.startsWith("put ")), "the outbox row never reached the disk").toBe(true);
    expect(firstRow(id).dataset.unseen).toBeUndefined();
    expect(Number(count()), "the header count and the row disagree").toBe(before - 1);
  });

  it("CAUSE — a write first made inside pagehide reaches neither disk nor wire before the page goes", async () => {
    spyWire();
    const store = new LaterTaskDisk();
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, storePolicy: { mode: "full" } });
    await mountShell(engine);
    const id = firstUnreadRow().dataset.id!;
    const diskBefore = store.disk.length;
    // The pagehide task: the handler and its microtasks run, and no later task does.
    await act(async () => {
      void engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false, via: "glance" });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(wire.filter((w) => w.ids.includes(id))).toEqual([]);
    expect(store.disk.length).toBe(diskBefore);
  });
});

function firstRow(id: string): HTMLElement {
  const el = host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}
