/** @vitest-environment jsdom */
// First: the new shell's door pins the API base before anything reads it.
import {
  click as clickRow, columnHidden, frame, setViewport, heldAtSave, host as seatHost, idsInGroup, key as press, marked, mountSeated,
  openInAddress, rowEl, seatDown, seatEnv, serverSays, wait as pass, type SeatedRow,
} from "../_ohbox-2-seated.js";
import { headCount, pickedCount, readSlotSays } from "./_finders.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, OhmailEngine, type MirrorRecord } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../../messages/en.json";
import { stubThreadLayout, type ThreadLayout } from "../fixtures/thread-layout.js";

/**
 * AN OPEN SAVES THE READ. The screen never claims a read the account does not hold: once the
 * thread-read rule reads a message in an entered conversation (an open, a click on its row) the
 * `mark_seen` is on its way, not owed to a departure; a j/k preview reads nothing. What waits for
 * the departure is the row's PLACE, so nothing re-sorts under the reader. The reload cases model an
 * IndexedDB outbox: its commit lands in a LATER task, so a write first made inside `pagehide`
 * reaches neither the disk nor the wire before the page is gone. The reader is laid out here
 * (`fixtures/thread-layout.ts`), so an open message's lines are on screen.
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): the first two describes move from today's Ohbox view handed
 * its lists through a modelled hold (`./_today.js`, which leaves with today's shell) to THE NEW SHELL's own door
 * (`../_ohbox-2-seated.ts`: the web's shell over a live engine whose own hold and selector place the rows, a served
 * page, the read wire recorded, the server echoing each write). What the old harness modelled is read where the new
 * shell carries it: a save is the read wire's (`marked`), the hold at each save is the engine's own (`heldAtSave`), a
 * refused save is the server's refusal of the write, a read by another client is the server's delta, and the message
 * on screen is the address's. The verb is found by its name (today's `.abar-read` class leaves). The third describe
 * already ran over the new shell (`_todays-shell.js` was its door's old name) and now names the door itself.
 * Every expectation as it stood.
 */

const DWELL_MS = 2000;
/** Comfortably past the 280 ms slide. */
const AFTER_SLIDE_MS = 400;

interface Row { id: string; unread: boolean; date: string }

/** A row served at its fixture's time: the served page's clock counts minutes, which keeps the rows' order. */
const served = (r: Row): SeatedRow => ({ id: r.id, unread: r.unread, n: Number(r.date.slice(14, 16)) });

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(rows: Row[]): Promise<void> {
  host = await mountSeated(rows.map(served));
}

/** The message on screen: the letter the address names. */
const sel = (): string | null => openInAddress();
const verb = (): string => readSlotSays(seatHost());
const count = (): string | null => headCount(host!);
/** The row presents unread: its dot and weight (`data-unseen`). */
const looksUnread = (id: string): boolean => rowEl(id).dataset.unseen === "1";

async function click(id: string): Promise<void> {
  await clickRow(id);
  await frame();
}
async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await press(k, init);
  await frame();
}
async function wait(ms: number): Promise<void> {
  await pass(ms);
}
/** A frame passes. */
async function draw(): Promise<void> {
  await frame();
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
/** The server refuses every read-state write from here on (the write is still sent, and recorded). */
function serverRefusesReads(): void {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const answer = await base(input as RequestInfo, init);
    if ((init?.method ?? "GET").toUpperCase() === "PATCH" && /\/messages(\?|$)/.test(String(input)))
      return new Response(JSON.stringify({ error: "refused" }), { status: 422, headers: { "content-type": "application/json" } });
    return answer;
  }) as typeof globalThis.fetch;
}

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const A = { id: "a", unread: true, date: "2026-08-02T09:03:00.000Z" };
const B = { id: "b", unread: true, date: "2026-08-02T09:02:00.000Z" };
const C = { id: "c", unread: false, date: "2026-08-02T09:01:00.000Z" };
const glance = (id: string) => ({ ids: [id], unread: false, via: "glance" as const });

let layout: ThreadLayout;
/** Is the new shell's door up (the first two describes), rather than the whole shell over an engine of the case's? */
let seated = true;
/** The first two describes: the new shell's door over a served page. */
function seatedEnv(): void {
  seatEnv();
  seated = true;
  layout = stubThreadLayout({ columnHidden });
  host = null;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  if (!seated) host?.remove();
  root = null; host = null;
  Reflect.deleteProperty(document, "visibilityState");
  layout.restore();
  if (seated) await seatDown();
  else { vi.restoreAllMocks(); vi.useRealTimers(); }
});

describe("the Ohbox saves a read when it shows one", () => {
  beforeEach(seatedEnv);

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
    expect(sel(), "still the message on screen").toBe("a");
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
    await mount([A, B, C]);
    serverRefusesReads();
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
  beforeEach(seatedEnv);

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

  const T = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, unread: true, date: `2026-08-02T09:0${9 - n}:00.000Z` }));
  const pickedNow = (): string[] => [...host!.querySelectorAll<HTMLElement>("[role=option][data-picked][data-id]")].map((r) => r.dataset.id!).sort();
  const barCount = (): string | null => pickedCount(host!);
  async function readFirstThen(id: string): Promise<void> {
    await mount([...T, C]);
    await click(id);
    await layout.passDwell();
    await wait(AFTER_SLIDE_MS);
    expect(idsInGroup("New")).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  }
  async function shiftClick(id: string): Promise<void> {
    await act(async () => { rowEl(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })); });
    await draw();
  }

  it("Shift+J from a read row keeps it in New while the pick lives; Escape ends the pick and files it", async () => {
    await readFirstThen("t1");
    await key("J", { shiftKey: true });
    await wait(AFTER_SLIDE_MS);
    expect(idsInGroup("New"), "a key press re-sorted the list under the selection").toEqual(["t1", "t2", "t3", "t4", "t5"]);
    await key("J", { shiftKey: true });
    expect(pickedNow(), "the range spanned rows nobody stepped over").toEqual(["t1", "t2", "t3"]);
    await key("Escape");
    await wait(AFTER_SLIDE_MS);
    expect(pickedNow()).toEqual([]);
    expect(idsInGroup("Earlier"), "the read row files once the pick ends").toEqual(["t1", "c"]);
  });

  it("Shift+J then Shift+click on the next row picks the three rows between, never the ones below", async () => {
    await readFirstThen("t1");
    await key("J", { shiftKey: true });
    await wait(AFTER_SLIDE_MS);
    await shiftClick("t3");
    expect(pickedNow()).toEqual(["t1", "t2", "t3"]);
    expect(barCount()).toBe("3");
  });

  it("Shift+J then Shift+K from a read row picks only the rows stepped over", async () => {
    await readFirstThen("t3");
    await key("J", { shiftKey: true });
    await wait(AFTER_SLIDE_MS);
    await key("K", { shiftKey: true });
    expect(pickedNow(), "a row above the gesture was picked").toEqual(["t3", "t4"]);
    expect(sel()).toBe("t3");
  });

  it("CONTROL: a row read by a sync change, not here, stays below a newer row at its arrival", async () => {
    const D = { id: "d", unread: false, date: "2026-08-02T09:05:00.000Z" };
    await mount([B, D, { ...C, unread: true }]);
    expect(idsInGroup("Earlier")).toEqual(["d"]);
    // Read in another client: the drain flips the flag and stamps nothing.
    await serverSays({ id: "c", gone: false, over: { unread: false } });
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
  const { MailShell: AppShell } = await import("../_mail-shell.js");
  seated = false;
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
  const row = host!.querySelector<HTMLElement>('[role=option][data-unseen="1"][data-id]');
  if (!row) throw new Error("the fixture Ohbox shows no unread row");
  return row;
};

describe("through the whole shell: the read survives a reload", () => {
  /* The whole shell over an engine of the case's own (the fixtures' mail, an outbox that commits a task later), in the
     environment it always ran in. */
  beforeEach(() => {
    seated = false;
    /* A fresh browser, as it always had: the seated cases above leave what a live account's tab keeps. */
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = "";
    vi.useFakeTimers();
    (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
      escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
    };
    layout = stubThreadLayout();
    setViewport(false);
  });

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
  const el = host!.querySelector<HTMLElement>(`[role=option][data-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}
