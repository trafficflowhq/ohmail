/** @vitest-environment jsdom */
// First: the new shell's door pins the API base before anything reads it (`engine-config.ts` reads it once).
import { ISO, answerSyncWith, installShellEnv, teardownShellEnv } from "../fixtures/live-walk-shell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../../messages/en.json";

/**
 * READ-STATE IN THE OHBOX. Two judgements pull against each other: an open (Enter, a click on a
 * row, a mobile tap) ENTERS the conversation, and a j/k sweep past a row is a preview that
 * establishes NOTHING until the cursor rests on it — get that wrong and a keyboard user empties
 * their own Ohbox by scrolling through it. In an entered conversation a message turns read once its
 * first and last line have been on screen (the thread-read rule), and that read is SAVED at once.
 * What still waits for the way out (a cursor move, unmount, the sheet closing where it was the
 * reading, Back) is the row's PLACE, so nothing re-sorts under the reader. The reading column has
 * a laid-out geometry here (`fixtures/thread-layout.ts`): a message's lines are on screen.
 */
import { stubThreadLayout, type ThreadLayout } from "../fixtures/thread-layout.js";
import { mountThread, msg as served, patches } from "../fixtures/thread-read-shell.js";
import { blankSays, headCount, ohboxRows, openLetter, pickedCount, readingColumn } from "./_finders.js";

/**
 * RE-POINTED (share ohbox-1, the switch's older tests): every case is moved from today's Ohbox view (`./_today.js`,
 * which leaves with today's shell, and the inert and live harnesses over it) to THE NEW SHELL's own door, `mountSeated` below: the
 * web's shell over a live engine (`fixtures/thread-read-shell.ts`'s `mountThread`: a served page of mail from a
 * consented sender, each letter its own conversation, the read wire recorded), the reader laid out
 * (`fixtures/thread-layout.ts`). What the cases count is the same three seams the old harness handed the view:
 * `marked` (every read-state write, now as the wire carries it: ids, direction, `glance` where nobody pressed a read
 * verb), `entered` (the shell's `onEnterReader`, which the new seat's open state supplies: counted where the seat
 * hands it to the list, below) and `readerFor` (the letter over the list where one column stands: the address's).
 * The old inert harness started with the first row selected; the new shell starts with nothing open, so a case of
 * `mountSeated(rows, { first: true })` makes that selection as a person does, with one `j` (a preview: nothing is
 * read by it). Every expectation is as it stood, but GUARD (a)'s words (RULING-JOIN J-3, said there); one case retired
 * (its premise void, said where it stood).
 */
vi.mock("../../../../packages/app-logic/src/ohbox/live-open.js", async (original) => {
  const m = await original<typeof import("../../../../packages/app-logic/src/ohbox/live-open.js")>();
  /* One counted twin a callback: the seat's `onEnterReader` is stable, so is its twin. */
  const twins = new WeakMap<object, (id: string) => void>();
  return {
    ...m,
    useOpenAndCursor: (...args: Parameters<typeof m.useOpenAndCursor>) => {
      const open = m.useOpenAndCursor(...args);
      let twin = twins.get(open.onEnterReader);
      if (twin === undefined) {
        const inner = open.onEnterReader;
        twin = (id: string) => { entered++; inner(id); };
        twins.set(open.onEnterReader, twin);
      }
      return { ...open, onEnterReader: twin };
    },
  };
});

/* THE KEYBOARD REGISTRY's LIVE TABLE (what the `?` sheet is generated from): the new frame mounts its own provider
   (`Frame.tsx`: `useKeymapStore()`), so its store is taken where it is made, and read after each step. */
let keymapStore: { snapshot: () => Array<{ chord: string; label: string; disabled?: boolean }> } | null = null;
vi.mock("../../../../packages/app-logic/src/keys/keymap.js", async (original) => {
  const m = await original<typeof import("../../../../packages/app-logic/src/keys/keymap.js")>();
  return {
    ...m,
    useKeymapStore: () => {
      const store = m.useKeymapStore();
      keymapStore = store;
      return store;
    },
  };
});
const readRegistry = (): void => {
  if (keymapStore === null) return;
  registry = keymapStore.snapshot().map((b) => ({ chord: b.chord, label: b.label, disabled: b.disabled === true }));
};

// See `sync-liveness-shell.test.ts` for why React is published as a global and why this file
// writes `h(...)` rather than JSX.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

// jsdom ships no `CSS.escape`, and the shell harness below mounts code that reaches for it.
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** j's old dwell: a preview left within it reads nothing (the 1.3 s rest and the 0.7 s dwell take longer). */
const DWELL_MS = 2000;

interface Msg {
  id: string; subject: string; unread: boolean;
}

/**
 * THE RULE'S SAVE, as the view dispatches it: `via: "glance"`, because nobody pressed a read verb.
 * The label lets the engine hold a resurfaced row's pin back from an involuntary read, while the
 * deliberate verbs (the read pill, `u`, the bulk bar) answer pins by omitting it.
 */
const glance = (id: string) => ({ ids: [id], unread: false, via: "glance" as const });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every `mark_seen` the view dispatched, in order. */
let marked: Array<{ ids: string[]; unread: boolean; via?: "glance" }> = [];
let entered = 0;
/**
 * Which letter stands over the list where one column stands (the address's), or null: read after each step (`frame`).
 * Closing it is one of the four departures, and at a width with no reading column it is the only one a phone reader
 * ever performs; at a split width the letter stands in the reading column and nothing stands over the list.
 */
let readerFor: string | null = null;
/** The keyboard registry's live binding table, read from the frame's store after each step (`readRegistry`). */
let registry: Array<{ chord: string; label: string; disabled: boolean }> = [];
/** Is the reading column hidden? Under 700 wide one column stands. */
const columnHidden = (): boolean => window.matchMedia("(max-width: 699.98px)").matches;

/** jsdom has no matchMedia; the view asks it whether it is in the split pane. */
function setViewport(mobile: boolean): void {
  // The new frame reads the window's width for its columns; today's views asked the media query alone.
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: mobile ? 390 : 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query,
      onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

/** Is a shell currently up? Cleared before the unmount. */
let mounted = false;

/** Tear the current view down — its keydown listener goes with it. */
async function unmount(): Promise<void> {
  mounted = false;
  if (seated) {
    /* The new shell's root is the door's own: taken down by `teardownShellEnv`, or here when a case leaves. */
    seated = false;
    await teardownShellEnv();
    installShellEnv();
    host = null;
    return;
  }
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/* ── the SHELL harness: the whole client, on the demo engine ───────────────────────────────
   A view-level harness is blind to exactly one thing: the shell keeps its OWN resolved selection,
   and that is what decides which body is fetched, which attachments are held and what the
   message verbs act on. A view-level guard cannot see it, so a half-deletion — this view's
   fallback removed, the shell's left standing — would look green and still open mail nobody
   asked for. `demo: true` because the fixture engine has an Ohbox with unread mail in it and
   no network at all. */
async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../_todays-shell.js");
  window.location.hash = "#/ohbox";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell as never, { demo: true } as never) }),
        }),
      }),
    );
  });
  // The demo engine bootstraps in an effect; the mirror is not readable until it has settled.
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

/** Is the new shell's door up (rather than the demo shell of GUARD (b))? */
let seated = false;

/**
 * THE NEW SHELL, the rows served as a live account's page (newest first in the order given; each its own conversation,
 * from a sender the account admitted), the read wire recorded into `marked` in the old seam's shape. `first`: the
 * first row selected, as the old inert harness handed it, by one `j`.
 */
async function mountSeated(rows: Msg[], opts: { first?: boolean } = {}): Promise<void> {
  await unmount();
  seated = true;
  const page = rows.map((r, i) => served(r.id, 50 - i, { threadId: `t-${r.id}`, subject: r.subject, unread: r.unread }));
  host = (await mountThread(page)) as HTMLDivElement; // the door's own container, a div
  /* THE SERVER ECHOES WHAT IT WAS TOLD, as a real one's sync does: the drain after a read-state write carries the rows
     it changed (the door's own server serves the page once and nothing after it, so the engine's acknowledged write
     would lapse back to the served flag with no echo). And what another device or a move changes, said by the case. */
  const rowsById = new Map(page.map((c) => [c.id, c.entity as Record<string, unknown>]));
  let echoed = 0;
  let seq = 1000;
  owed = [];
  answerSyncWith(() => {
    const changes = { creates: [] as unknown[], updates: [] as unknown[], moves: [] as unknown[], deletes: [] as unknown[] };
    for (const p of patches.slice(echoed)) for (const id of p.ids) {
      const row = rowsById.get(id);
      if (row === undefined) continue;
      row.unread = p.unread;
      changes.updates.push({ type: "message", op: "update", id, seq: ++seq, updatedAt: ISO, entity: { ...row } });
    }
    echoed = patches.length;
    for (const o of owed.splice(0)) {
      if (o.arrives !== undefined) {
        /* New mail: the letter and its own conversation, created. */
        const tid = `t-${o.id}`;
        const m = served(o.id, o.arrives.n, { threadId: tid, subject: o.arrives.subject, unread: o.arrives.unread });
        rowsById.set(o.id, m.entity as Record<string, unknown>);
        changes.creates.push(m, {
          type: "thread", op: "create", id: tid, seq: ++seq, updatedAt: ISO,
          entity: { id: tid, accountId: "acct_live_1", rootMessageIdHeader: null, subject: o.arrives.subject, messageIds: [o.id],
            lastMessageAt: ISO, participants: [], updatedAt: ISO },
        });
      } else if (o.gone) {
        rowsById.delete(o.id);
        changes.deletes.push({ type: "message", op: "delete", id: o.id, seq: ++seq, updatedAt: ISO, entity: null });
      } else {
        const row = rowsById.get(o.id)!;
        Object.assign(row, o.over);
        changes.updates.push({ type: "message", op: "update", id: o.id, seq: ++seq, updatedAt: ISO, entity: { ...row } });
      }
    }
    return new Response(JSON.stringify({ changes, cursor: `echo-${seq}`, hasMore: false, serverTime: ISO }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const wire = patches;
  const put = wire.push.bind(wire);
  wire.push = (...sent) => {
    for (const p of sent) marked.push({ ids: p.ids, unread: p.unread, ...(p.via === "glance" ? { via: "glance" as const } : {}) });
    return put(...sent);
  };
  mounted = true;
  readRegistry();
  if (opts.first) await key("j");
}

/** What the server says on its next drain beyond the echo: a row changed elsewhere, or gone from the Ohbox. */
let owed: Owed[] = [];
type Owed = { id: string; gone: boolean; over?: Record<string, unknown>; arrives?: { n: number; subject: string; unread: boolean } };

/**
 * THE SERVER SAYS IT NOW: a delta from elsewhere (`owed`) served on the drain the engine runs at once, as a stream's
 * push or the network's return buys one (here the browser's `online`: the scheduler drains on it), rather than at the
 * next 8 s poll, which would land after the rest it races.
 */
const serverSays = async (change: Owed): Promise<void> => {
  owed.push(change);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(25); });
};

/** The rows that are drawn unread, in the list's order. */
const unreadIds = (): string[] =>
  ohboxRows(host!).filter((r) => r.hasAttribute("data-unread")).map((r) => r.dataset.id!);

/** The letter the address names (`#/ohbox/m/<id>`), or null. */
const openInAddress = (): string | null => /^#\/ohbox\/m\/([^/?]+)/.exec(window.location.hash)?.[1] ?? null;

/**
 * Sit still for `n` whole dwell periods, flushing React between each.
 *
 * One long `advanceTimersByTime` is NOT equivalent: a cascade re-arms from inside a commit,
 * and the commit only lands when the floating `rerender()` promise resolves at the end of an
 * `act`. Advancing in whole-period steps gives a runaway the same room it has in a browser.
 */
const idle = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(DWELL_MS); });
  }
};

/** Past the 280 ms slide to "Earlier" and short of a dwell, so no other row is armed. */
const slide = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
};

/** A frame passes: the rule looks at what is on screen. */
const frame = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  // The new shell: the letter over the list where one column stands is the address's.
  if (seated) {
    readerFor = columnHidden() ? openInAddress() : null;
    readRegistry();
  }
};

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
  await frame();
};

const rowEl = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`[role=option][data-id="${id}"]`)!;

const click = async (id: string, init: MouseEventInit = {}): Promise<void> => {
  await act(async () => {
    rowEl(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await frame();
};

const text = (): string => host!.textContent ?? "";

/**
 * THE SELECTION'S COUNT, read off the pill's leading capsule — `null` when nothing is picked.
 *
 * These assertions used to be `text()).toContain("N selected")` over the whole pane, which
 * worked while the count was one string in a wash strip above the rows. The capsule renders
 * "× N selected esc" as separate nodes so the WORD can fold out at narrow widths while the
 * number stays (`bar-density.ts`), and a `textContent` scan would therefore read "×3selected".
 * Reading the live region is both exact and the thing that is actually announced.
 */
const pickCount = (): string | null =>
  pickedCount(host!);

/** Is this message's row in the group with this label ("New", "Earlier")? */
const inGroup = (label: string, id: string): boolean =>
  host!.querySelector(`[role="listbox"][aria-label="${label}"] [role=option][data-id="${id}"]`) != null;

/* ── the four departures, as a test can perform them ─────────────────────────────────────────
   #1 (the cursor moves) is `key("j")` / `click(other)` and needs no helper. */

/** #3 — the shell dismisses the reader sheet. */
const closeReader = async (): Promise<void> => {
  // The new shell: the letter over the list is closed as a person closes it, by Escape.
  await key("Escape");
};

/** #4 — the tab is closed, navigated away from, or frozen into the back/forward cache. */
const pagehide = async (): Promise<void> => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
};

let layout: ThreadLayout;
beforeEach(() => {
  installShellEnv();
  window.location.hash = "#/ohbox";
  seated = false;
  layout = stubThreadLayout({ columnHidden });
  marked = [];
  entered = 0;
  readerFor = null;
  registry = [];
  setViewport(false);
});

afterEach(async () => {
  await unmount();
  layout.restore();
  await teardownShellEnv();
  // The shell guard spies on the engine's own body fetch; a spy left installed would silence
  // it for every file that runs after this one in the same worker.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("opening a message enters it: what is on screen is read and SAVED; leaving releases its place", () => {
  it("↵ opens the reader and saves the read once its top was on screen for the dwell; leaving writes nothing more", async () => {
    // THE GUARD. Drop the `markSeenRef` call from `readByRule` in `OhboxView.tsx` and this
    // goes red: the message is read on screen while nothing is sent.
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await key("Enter");
    expect(marked, "the write waits for the dwell").toEqual([]);
    await layout.passDwell();
    expect(marked).toEqual([glance("a")]);
    expect(entered).toBe(1);
    await key("j");
    expect(marked).toEqual([glance("a")]);
  });

  it("a click on a row is an open: it enters, and what is on screen is saved read", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await click("b");                       // a click enters: "b" is on screen
    await layout.passDwell();
    expect(marked).toEqual([glance("b")]);
    await click("b");                       // a second click opens again and writes nothing more
    expect(marked).toEqual([glance("b")]);
    await click("a");                       // leaving "b" for "a" reads "a", nothing for "b"
    await layout.passDwell();
    expect(marked).toEqual([glance("b"), glance("a")]);
  });

  it("on MOBILE a single tap is the open: the sheet is raised; the hidden column reads nothing", async () => {
    // The sheet is the shell's (`conversation-read-slot` drives it); the column here is
    // `display:none`, so nothing in it is on screen.
    setViewport(true);
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await click("b");
    expect(entered).toBe(1);
    expect(readerFor).toBe("b");
    expect(marked).toEqual([]);
    await closeReader();
    expect(marked).toEqual([]);
  });

  it("opening an ALREADY-read message arms nothing, so no departure writes anything", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: false }], { first: true });
    await key("Enter");
    expect(marked).toEqual([]);
    expect(entered).toBe(1);
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("the message being read keeps its PLACE, and its ink and the count agree with the save", async () => {
    // The row is saved read at the open and the list re-partitions, but the held place keeps it
    // in "New" under the reader (the seat's hold of the open row: without it the row is gone after the 280 ms
    // slide); leaving files it under "Earlier". The count follows the save.
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    await key("j");                         // cursor to "a" (nothing is open until something is)
    await key("Enter");                     // …and opens it
    await idle(20);
    expect(unreadIds()).toEqual(["b"]);
    expect(inGroup("New", "a"), "the saved read moved the row under the reader").toBe(true);
    expect(rowEl("a").hasAttribute("data-unread")).toBe(false);
    expect(headCount(host!)).toBe("1");

    await key("j");                         // …and leaving is what moves it
    await slide();
    expect(inGroup("Earlier", "a")).toBe(true);
    expect(marked).toEqual([glance("a")]);
  });
});

describe("a preview passed reads nothing — j/k is navigating; one rested on reads", () => {
  it("a j/k sweep past several rows commits NOTHING", async () => {
    // THE GUARD that matters most here. Make `selectByUser` enter the conversation and this goes
    // red: every row the sweep touched is marked read, i.e. a keyboard user empties their own
    // Ohbox by scrolling through it.
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
      { id: "d", subject: "D", unread: true },
    ], { first: true });
    for (const _ of [1, 2, 3]) {
      await key("j");
      await act(async () => { vi.advanceTimersByTime(DWELL_MS - 100); });
    }
    expect(marked).toEqual([]);
  });

  it("a preview left within the rest saves nothing, with the message on screen; ↵ reads it", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await key("j");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(marked).toEqual([]);
    await key("Enter");
    await layout.passDwell();
    expect(marked).toEqual([glance("b")]);
  });

  it("a preview rested on forty seconds saves it once", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await key("j");
    await idle(20);
    expect(marked).toEqual([glance("b")]);
  });

  it("resting on a row and then MOVING ON commits nothing", async () => {
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ], { first: true });
    await key("j");
    await act(async () => { vi.advanceTimersByTime(DWELL_MS - 100); });
    await key("j");
    expect(marked).toEqual([]);
  });

  it("passing through a row saves nothing, then or on the way out", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await key("j");
    await act(async () => { vi.advanceTimersByTime(DWELL_MS - 100); });
    await key("k");
    expect(marked).toEqual([]);
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("a selection on MOBILE shows nothing and reads nothing", async () => {
    setViewport(true);
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await key("j");
    await act(async () => { vi.advanceTimersByTime(DWELL_MS * 3); });
    // Nothing was armed, so nothing is saved — and every departure agrees.
    expect(marked).toEqual([]);
    await key("k");
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("an already-read selection writes nothing", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: false }], { first: true });
    await act(async () => { vi.advanceTimersByTime(DWELL_MS * 3); });
    expect(marked).toEqual([]);
  });
});

/**
 * ═══ THE FOUR DEPARTURES ═══ The read is saved while the message is open; a departure releases the
 * held PLACE and writes nothing. Four, and no more: the window blurring, the list re-partitioning or a delta
 * landing is not leaving, and a fifth trigger would slide rows away while they are being read.
 */
describe("the four departures", () => {
  it("#1 — the cursor moving to a different message releases the place and writes nothing", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("j");
    await key("Enter");
    await layout.passDwell();
    expect(marked).toEqual([glance("a")]);
    await key("j");
    await slide();
    expect(inGroup("Earlier", "a")).toBe(true);
    expect(marked).toEqual([glance("a")]);
  });

  it("#1 does NOT fire when the cursor lands on the same message again", async () => {
    // Re-selecting the row you are on is not leaving it: its place stays held and nothing is
    // written a second time.
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("j");
    await key("Enter");
    await click("a");
    await idle(1);
    expect(inGroup("New", "a")).toBe(true);
    expect(marked).toEqual([glance("a")]);
  });

  it("#2 — the view unmounting, which is how leaving the Ohbox looks from here", async () => {
    // Clicking Reads in the rail unmounts this view; the read was saved at the open, so walking
    // away by the rail loses nothing and writes nothing more.
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("Enter");
    await layout.passDwell();
    expect(marked).toEqual([glance("a")]);
    await unmount();
    expect(marked).toEqual([glance("a")]);
  });

  it("#3 — the reader sheet closing, AT A MOBILE WIDTH, writes nothing", async () => {
    setViewport(true);
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("Enter");
    expect(readerFor).toBe("a");
    await closeReader();
    expect(marked, "the sheet is the reading there; closing it is leaving, not reading").toEqual([]);
  });

  /* "#3 does NOT fire at a SPLIT width" RETIRED (share ohbox-1): its premise, a sheet that duplicates a column that stays
     up, is void in the new frame: at a split width a row opened stands in the frame's column alone and no sheet is ever
     raised (`frame/seated-ohbox.test.tsx`, "one reader of one letter"). The place it guarded, the row being read kept in
     "New" while it is on screen, is the PLACE case of the first describe above. */

  it("#4 — pagehide owes nothing: the read went out at the open", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("Enter");
    await layout.passDwell();
    expect(marked).toEqual([glance("a")]);
    await pagehide();
    expect(marked).toEqual([glance("a")]);
  });

  it("a read is written ONCE, however many departures arrive", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("Enter");
    await layout.passDwell();
    await closeReader();                    // the new shell: the open letter closed, as a person closes it (Escape)
    await pagehide();
    await unmount();
    expect(marked).toEqual([glance("a")]);
  });

  it("a message filed out of the Ohbox while previewed is not written", async () => {
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    await key("j");                         // the dwell starts on "a"
    await act(async () => { vi.advanceTimersByTime(DWELL_MS / 2); });
    await serverSays({ id: "a", gone: true });   // …and a move/file takes it out of the Ohbox
    await idle(2);
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("a message already read by another device while previewed is not re-written", async () => {
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    await key("j");                         // the dwell starts on "a"
    await act(async () => { vi.advanceTimersByTime(DWELL_MS / 2); });
    await serverSays({ id: "a", gone: false, over: { unread: false } });   // a delta from elsewhere
    await idle(2);
    await pagehide();
    expect(marked).toEqual([]);
  });
});

/**
 * THE RUNAWAY — the one that reached a real mailbox.
 *
 * Reported verbatim: "read emails are marked read now on open which is good, but then
 * triggering the view to load the latest mail, auto-reading it, triggering an infinite loop on
 * auto-reading emails, basically going through the whole ohbox". Since that change read-state is not
 * local — `mark_seen` upserts `flag_state.desired_seen` and the worker reconciles `\Seen` onto
 * the user's own IMAP server — so this was a loop silently marking a real mailbox read at one
 * message per two seconds, against the invariant that the IMAP mailbox is the master.
 *
 * The chain: the Ohbox list is grouped BY `unread` (`ohboxView`), so a read commit is itself a
 * re-partition; the selection is an implicit fallback to `allOhbox[0]`; the dwell was keyed on
 * that resolved selection. Commit → the row leaves "New for you" → the fallback lands on the
 * next unread message → the dwell effect sees a selection nobody chose → commit → repeat.
 *
 * Every assertion below is positional and counts mutations, because "it stopped" and "it went
 * one further than it should have" have to be distinguishable.
 */
describe("THE RUNAWAY: a read commit must never cause another read commit", () => {
  const FIVE: Msg[] = [
    { id: "a", subject: "A", unread: true },
    { id: "b", subject: "B", unread: true },
    { id: "c", subject: "C", unread: true },
    { id: "d", subject: "D", unread: true },
    { id: "e", subject: "E", unread: true },
  ];

  it("an untouched Ohbox marks NOTHING, however long it is left alone", async () => {
    // Nobody has selected anything, so nothing may be committed — the fallback decides what
    // is DISPLAYED and never what is written. Key the dwell on `selected` again and this
    // reports all five ids, which is the bug as it was watched happening.
    await mountSeated(FIVE);
    await idle(20);
    expect(marked).toEqual([]);
    expect(unreadIds()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("opening ONE message commits exactly one; the other four stay unread", async () => {
    await mountSeated(FIVE);
    // TWO clicks, and the count is the point. The first selects — nothing in a fresh Ohbox is
    // selected any more — and the second is the open. This used to be one click on the strength
    // of the top row already being `selected` through the implicit fallback, which is precisely
    // the path that had no `onSelect` on it.
    await click("a");
    await click("a");
    await idle(20);
    await pagehide();                       // the tab going adds nothing
    expect(marked).toEqual([glance("a")]);
    expect(unreadIds()).toEqual(["b", "c", "d", "e"]);
  });

  it("↵ AFTER PUTTING THE CURSOR SOMEWHERE commits exactly one", async () => {
    // Was "↵ on the implicit selection". There is no implicit selection to press ↵ on: the key
    // is declared `disabled` while nothing is selected, so `j` is what makes it a real act.
    await mountSeated(FIVE);
    await key("j");
    await key("Enter");
    await idle(20);
    await pagehide();
    expect(marked).toEqual([glance("a")]);
    expect(unreadIds()).toEqual(["b", "c", "d", "e"]);
    expect(entered).toBe(1);
  });

  it("an open PINS the selection, so the reader does not walk to the next unread message", async () => {
    // The other half of the report. The reader sheet renders `selectedOhbox`, so while the
    // selection stayed implicit the sheet re-pointed at the next unread message the instant
    // the open marked this one read — "triggering the view to load the latest mail".
    await mountSeated(FIVE);
    await click("a");                       // selects
    await click("a");                       // …and opens
    expect(openInAddress()).toBe("a");
    await idle(20);
    expect(openInAddress()).toBe("a");
  });

  it("an open saves that one, and stops there", async () => {
    // The save re-partitions the list, and the next unread row is not entered by it — only a
    // person's open enters.
    await mountSeated(FIVE);
    await key("j");
    await key("Enter");
    await idle(20);
    expect(marked).toEqual([glance("a")]);
    await pagehide();
    expect(marked).toEqual([glance("a")]);
    expect(unreadIds()).toEqual(["b", "c", "d", "e"]);
  });

  it("a walk down the list writes ONE message per open and never gets ahead of the cursor", async () => {
    // The runaway's shape under the rule: each open reads exactly its own message, and a read
    // cannot enter anything, because entering needs a person's act and a re-partition is not one.
    // Positional, so "it stopped" and "it went one further" stay distinguishable.
    await mountSeated(FIVE);
    await key("j"); await key("Enter"); await idle(1);
    expect(marked).toEqual([glance("a")]);
    await key("j"); await key("Enter"); await idle(1);
    expect(marked).toEqual([glance("a"), glance("b")]);
    await idle(20);
    expect(marked).toHaveLength(2);
  });

  it("a j/k sweep over a list that re-partitions still commits nothing", async () => {
    await mountSeated(FIVE);
    for (const _ of [1, 2, 3, 4]) {
      await key("j");
      await act(async () => { vi.advanceTimersByTime(DWELL_MS - 100); });
    }
    expect(marked).toEqual([]);
    expect(unreadIds()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a click that MOVES the cursor enters, unlike j: that one is read, and only that one", async () => {
    // A click is an open: a mouse never previews, or a mouse would never read.
    await mountSeated(FIVE);
    await click("c");
    await idle(20);
    await pagehide();
    expect(marked).toEqual([glance("c")]);
    expect(unreadIds()).toEqual(["a", "b", "d", "e"]);
  });

  it("a message read by another route while previewed is not written a second time", async () => {
    await mountSeated(FIVE);
    await key("j");                                   // a preview of "a"
    await act(async () => { vi.advanceTimersByTime(DWELL_MS / 2); });
    await key("x");                                   // pick it…
    await key("u", { shiftKey: true });               // …and ⇧U marks the picked set read
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    await idle(20);
    await pagehide();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
  });

  it("⇧I still writes immediately — an explicit direction is not deferred", async () => {
    // Mark-on-leave is about the HEURISTIC. A key that says "this is read" is an answer, not an
    // inference, and deferring it would leave the reader pressing a control that appears to do
    // nothing until they walk away.
    await mountSeated(FIVE);
    await key("j");                                   // …on a message, which now takes a cursor
    await key("i", { shiftKey: true });
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(unreadIds()).toEqual(["b", "c", "d", "e"]);
  });

  it("entering an ALREADY-READ row writes nothing", async () => {
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: false },
    ]);
    // Straight onto the read row with a click, rather than `j` twice: the first `j` would land
    // on "a", which IS unread, and this is about what happens on the row that is not.
    await click("b");
    await idle(20);
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("mail arriving while a message is open neither moves the target nor reads the arrival", async () => {
    await mountSeated(FIVE);
    await key("j");
    await key("Enter");                               // "a" is entered and read
    await serverSays({ id: "z", gone: false, arrives: { n: 59, subject: "Z", unread: true } });   // new mail lands on top
    await idle(20);
    await pagehide();
    expect(marked).toEqual([glance("a")]);
    expect(unreadIds()).toEqual(["z", "b", "c", "d", "e"]);
  });

  it("`u` is not undone by the rule: the opened message stays unread for the visit", async () => {
    // Drop the `keepUnread` in `markUnread` and this goes red — the explicit `u` is reverted by
    // the rule in the next frame, while the user watches.
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    await key("j");
    await key("Enter");                               // "a" is read on screen
    await key("u");                                   // "a" is asked for unread…
    await key("u");                                   // …and again, idempotently
    marked = [];
    await idle(20);
    await pagehide();
    expect(marked).toEqual([]);
    expect(unreadIds()).toEqual(["a", "b"]);
  });

  it("`u` SURVIVES LEAVING — a completed dwell, then u, then the way out", async () => {
    // A different question from the one above: there the dwell had not saved yet, here it HAS,
    // and `u` puts the message back. Nothing on the way out may write it read again — put a
    // write into `leaveRead` and this goes red on the very next keypress.
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    // TWO j's: the first takes the cursor from nothing to "a", the second moves it to "b" —
    // and it has to be "b" rather than "a", because `k` from the top row is `disabled` and a
    // departure that never happens would make this test pass by doing nothing at all.
    await key("j");                                   // cursor to "a"
    await key("j");                                   // …cursor to "b", "a" armed nothing yet
    await idle(1);                                    // the dwell completes: "b" is saved
    await key("u");                                   // …and the reader says no
    marked = [];
    await key("k");                                   // the departure
    await pagehide();
    expect(marked).toEqual([]);
    expect(unreadIds()).toEqual(["a", "b"]);
  });

  it("`u` on the cursor row leaves ANOTHER message's saved read alone", async () => {
    // The pin is about the message it was pressed on. A read saved elsewhere is a reading that
    // really happened, and undoing it unconditionally would silently drop it.
    await mountSeated(FIVE);
    await key("j");                                   // cursor to "a"
    await key("Enter");                               // …which saves it
    await key("j");                                   // …leaves "a", cursor to "b"
    marked = [];
    await key("u");                                   // "b" was never armed; "a" stays read
    expect(marked).toEqual([{ ids: ["b"], unread: true }]);
  });
});

/**
 * ═══ NOTHING IS OPEN UNTIL SOMEBODY OPENS IT ═══════════════════════════════════════════════
 *
 * The runaway above was fixed by keying the dwell on a cursor the user had actually moved, and
 * the implicit fallback was left in place on the grounds that "a fallback may decide what is
 * DISPLAYED; it may never drive seen-machinery". That line held for the machinery and not for
 * the product: `?? all[0]` still meant that arriving in the Ohbox opened the newest unread
 * message, fetched its body, and put it in the reading column with nobody having asked. The
 * message was then one keypress away from a departure that commits it, and on a device left
 * open at the Ohbox the 2 s dwell has no cursor to arm from — but a reader who glances at the
 * column, presses `j` and walks away has read a message the product chose for them.
 *
 * Two guards, because ONE DELETION IS NOT ENOUGH AND EITHER HALF ALONE COMPILES AND LOOKS
 * IDENTICAL. `OhboxView`'s `?? all[0]` decides what this view renders; `AppShell`'s
 * `?? allOhbox[0]` decides what the SHELL thinks is open — the body it hydrates, the
 * attachments it holds, the message `s`/`e`/`r` act on. Delete one and the surface still
 * auto-opens through the other. So one guard stands at each.
 */
describe("NOTHING IS OPEN UNTIL SOMEBODY OPENS IT", () => {
  const THREE: Msg[] = [
    { id: "a", subject: "A", unread: true },
    { id: "b", subject: "B", unread: true },
    { id: "c", subject: "C", unread: true },
  ];

  /**
   * The reading column's contents, as two questions: is a message in it, and is the rest state? Over the new frame:
   * the open letter's region in the frame's reading section, and the column standing with none in it.
   */
  const column = (): { pane: Element | null; rest: Element | null; text: string } => {
    const col = readingColumn(host!);
    const pane = openLetter(host!);
    return {
      pane,
      rest: col !== null && pane === null ? col : null,
      text: blankSays(host!) ?? "",
    };
  };

  it("GUARD (a) — a fresh Ohbox rests; the newest unread message is NOT in the column", async () => {
    // Fails against the shipped code with `.msg` present: the view's own `?? all[0]` had already
    // resolved "the selection" to the first unread row, so `MessagePane` rendered it.
    await mountSeated(THREE);
    const { pane, rest, text } = column();
    expect(pane, "the Ohbox opened a message nobody asked for").toBeNull();
    expect(rest, "the column is blank rather than resting").not.toBeNull();
    /* RULING-JOIN J-3 (PARITY L19, declared): the resting column says the studio's blank, how many wait, where today's
       said "Nothing open."; the column still rests, which is the claim. */
    expect(text).toContain("3 unread");
    // …and the list is untouched: every row is still new, and still says so.
    expect(unreadIds()).toEqual(["a", "b", "c"]);
    expect(marked).toEqual([]);
  });

  it("…and the FIRST j is what opens one — the resting state is a state, not a wall", async () => {
    await mountSeated(THREE);
    await key("j");
    expect(column().pane, "the first j opened nothing").not.toBeNull();
    expect(openInAddress()).toBe("a");
  });

  /* THE EMPTY OHBOX IS ASSERTED ELSEWHERE, and deliberately so rather than by omission. The
     Screener's show-once rule says an empty list gets ONE empty state — the list's — and no
     resting panel beside it repeating the same absence. Neither harness in this file can mount
     that case: with no rows `OhboxView` renders `SyncState`, which calls `useMailState()` and
     throws without the provider these harnesses exist to do without. The guard therefore lives
     in `signup-copy-and-empty-ohbox.test.ts`, which mounts the real shell on a mailbox that has
     never synced — the exact state — and asserts the reading column is untouched there. */

  it("the ? sheet does not advertise ↵ while there is nothing to open", async () => {
    // The sheet is generated from the registry, so a binding with no `disabled` is a binding
    // the documentation promises. ↵ on an untouched Ohbox has always done nothing — `run` is
    // guarded — but until the fallback was deleted there was always a message and the question
    // could not arise. Drop `disabled: selected == null` from the Enter binding and this goes
    // red on the first assertion: a key sheet naming "open the message" beside a resting column.
    await mountSeated(THREE);
    const enter = () => registry.find((b) => b.chord === "Enter")!;
    expect(enter(), "the Enter binding is no longer declared here").toBeTruthy();
    expect(enter().disabled, "↵ is offered with nothing to open").toBe(true);
    /**
     * `k` IS OFFERED HERE, AND IT USED NOT TO BE.
     *
     * This line read `.toBe(true)` under a comment about "the top of the list, which is where
     * the first `j` lands" — but it is asserted BEFORE that `j`, so what it actually pinned was
     * `k` on a list with NO cursor. That state is the way IN, not the top of anything: `j`
     * enters at the first row and `k` enters at the last, which is what makes the two a pair
     * rather than one live key beside one dead one. The claim the comment was making is made
     * below, after the cursor exists and the top of the list is a place the reader can be.
     *
     * Unlike ↵, `k` has something to do here, so the sheet advertising it is correct.
     */
    expect(
      registry.find((b) => b.chord === "k")!.disabled,
      "`k` is offered as dead on a list nobody has entered — it is the way in from the bottom",
    ).toBe(false);

    await key("j");
    expect(enter().disabled, "↵ stayed dead after a row was picked").toBe(false);
    // …and NOW `k` is inert: the cursor is on the first row and there is nothing above it.
    expect(
      registry.find((b) => b.chord === "k")!.disabled,
      "`k` is advertised at the top of the list, where it has nowhere to go",
    ).toBe(true);
  });

  it("RISK 3 — on a NARROW viewport the first j arms nothing, because it displays nothing", async () => {
    // The dwell asks `matchMedia` and returns early under 700px, so `j`-from-nothing there moves
    // a cursor whose only rendering is the row highlight. Asserted rather than assumed: if the
    // media check were ever dropped, this is a phone marking mail read on a keypress that shows
    // the reader nothing at all.
    setViewport(true);
    await mountSeated(THREE);
    await key("j");
    await idle(20);
    await pagehide();
    expect(marked).toEqual([]);
    expect(unreadIds()).toEqual(["a", "b", "c"]);
  });

  it("GUARD (b) — the SHELL asks for no body until the first selection, and one after it", async () => {
    // The half a view-level test cannot see. `AppShell`'s own `?? allOhbox[0]` fed
    // `useEffect(() => { if (selectedOhbox) hydrateBody(selectedOhbox.id); })`, so landing on the
    // Ohbox fetched a message body — a request to the user's server for mail nobody opened.
    // Delete only `OhboxView`'s fallback and this stays red, which is the point of having it.
    const asked: string[] = [];
    vi.spyOn(OhmailEngine.prototype, "hydrateBody").mockImplementation(async (id: string) => {
      asked.push(id);
    });
    /* "Asks for one" is one request ON THE WIRE (the switch's point 65): the engine joins a second ask for a body
       already in flight into it and never fetches a ready one again, so the wire carries one request per letter
       asked, however many parts ask for it (the Ohbox's press and the reader's open both do). */
    const onTheWire = (): string[] => [...new Set(asked)];
    await mountShell();
    expect(onTheWire(), "the shell hydrated a body for a message nobody opened").toEqual([]);
    await key("j");
    expect(onTheWire()).toHaveLength(1);
  });
});

describe("two directions, not one toggle", () => {
  /**
   * ── `u` WAS A TOGGLE AND IS NOW A DIRECTION, ON THE OWNER'S CALL ──────────────────────
   *
   * The precedent is Gmail (⇧I read, ⇧U unread) rather than Apple Mail's single ⌘⇧U flip,
   * and the reason is what a toggle does to a SET: it turns a mixed selection into a
   * different mixed selection, so one press has an outcome nobody can predict without
   * counting first and two presses are not a no-op. A direction gives the same state from any
   * state. The bulk vocabulary has always had `read` and `unread` as separate members; the
   * single-message keys were the odd ones out.
   *
   * `⇧U` is NOT free here — it is the bulk "mark what I picked" verb, shipped and asserted
   * below — so the pair is Gmail's ⇧I verbatim plus `u`, the key this product has always used
   * for unread and the better mnemonic of the two.
   *
   * The old assertion is not weakened. It proved `u` reaches `mark_seen` with the right
   * direction; these prove the same thing for both keys, and add the idempotence a toggle
   * could not have.
   */
  it("u marks unread whatever the message already was", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: false }], { first: true });
    await key("u");
    expect(marked).toEqual([{ ids: ["a"], unread: true }]);

    // IDEMPOTENT — the property a toggle does not have. Pressing it again asks for the same
    // state rather than undoing it.
    marked = [];
    await mountSeated([{ id: "z", subject: "Z", unread: true }], { first: true });
    await key("u");
    expect(marked).toEqual([{ ids: ["z"], unread: true }]);
  });

  it("shift+i marks read whatever the message already was", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("i", { shiftKey: true });
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);

    marked = [];
    await mountSeated([{ id: "z", subject: "Z", unread: false }], { first: true });
    await key("i", { shiftKey: true });
    expect(marked).toEqual([{ ids: ["z"], unread: false }]);
  });

  it("bare i is not shift+i — an unshifted letter must not run the shifted verb", async () => {
    // `chordMatches` holds plain letters to this rule so a shifted binding is reachable at
    // all. Asserted here because `i` is unbound, so a leak would look like nothing happening.
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("i");
    expect(marked).toEqual([]);
  });

  it("a modifier key is not `u` — ⌘U belongs to the browser", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("u", { metaKey: true });
    expect(marked).toEqual([]);
  });
});

describe("multi-select", () => {
  it("x picks at the cursor, the bar counts, and its action marks the whole selection", async () => {
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ], { first: true });
    await key("x");
    expect(pickCount()).toBe("1");
    await key("j");
    await key("x");
    expect(pickCount()).toBe("2");
    expect(rowEl("a").hasAttribute("data-picked")).toBe(true);

    // Marking the selection dispatches ONE mutation with both ids — one request, one
    // transaction, one intent.
    // BY NAME since that change, and the name is shorter since the bar became the message pill:
    // the read pair is "Read | Unread" with the pill's own dots, so the label is "Read". The
    // claim below — one mutation carrying both ids — is unchanged.
    await act(async () => {
      [...host!.querySelectorAll<HTMLButtonElement>('[aria-label="Selection"] button')]
        .find((b) => (b.textContent ?? "").trim().startsWith("Read") || b.getAttribute("aria-label") === "Read")!
        .click();
    });
    expect(marked).toEqual([{ ids: ["a", "b"], unread: false }]);
    expect(pickCount()).toBeNull();
  });

  it("x on an already-picked row unpicks it", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("x");
    expect(pickCount()).toBe("1");
    await key("x");
    expect(pickCount()).toBeNull();
  });

  it("shift-click extends a range from the anchor and does NOT move the cursor", async () => {
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
      { id: "d", subject: "D", unread: true },
    ], { first: true });
    await key("x");                       // anchor at "a"
    await click("c", { shiftKey: true });
    expect(pickCount()).toBe("3");
    for (const id of ["a", "b", "c"]) expect(rowEl(id).hasAttribute("data-picked")).toBe(true);
    expect(rowEl("d").hasAttribute("data-picked")).toBe(false);
    // The capture-phase handler stopped the row's own click, so the reader never opened.
    expect(entered).toBe(0);
    expect(marked).toEqual([]);
  });

  it("Esc clears the selection", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await key("x");
    expect(pickCount()).toBe("1");
    await key("Escape");
    expect(pickCount()).toBeNull();
  });

  it("the selection does not survive the view unmounting — it is not a document", async () => {
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("x");
    expect(pickCount()).toBe("1");
    await unmount();

    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    expect(pickCount()).toBeNull();
  });

  it("a picked row is aria-selected, inside a multi-selectable listbox", async () => {
    // THE GUARD for the first half. Measured live with many unread rows
    // present: picking rows set `aria-selected` on ZERO of them — the pick was a class name
    // and nothing else, so it existed for sighted mouse users and for nobody else. Delete
    // the `picked` prop pass-through in `OhboxView`, or the role and `aria-selected` in
    // `MessageRow`, and every assertion here goes red.
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ], { first: true });
    /* BEFORE THE PICK the list states its CURSOR, which it did not when this case was written:
       an empty pick set is not a selection, so `OhboxView.pickState` hands the row back to the
       cursor and a screen reader is told which row it is on. What must never come back is the
       original defect — a PICK that publishes nothing — and that is the run below. */
    expect([...host!.querySelectorAll<HTMLElement>('[aria-selected="true"]')].map((e) => e.dataset.id))
      .toEqual(["a"]);

    await key("x");
    await key("j");
    await key("x");

    expect([...host!.querySelectorAll<HTMLElement>('[aria-selected="true"]')].map((e) => e.dataset.id))
      .toEqual(["a", "b"]);
    expect(rowEl("c").getAttribute("aria-selected")).toBe("false");
    // An option outside a listbox announces nothing, so the container has to say so too.
    expect(rowEl("a").getAttribute("role")).toBe("option");
    const box = rowEl("a").closest('[role="listbox"]')!;
    expect(box).toBeTruthy();
    expect(box.getAttribute("aria-multiselectable")).toBe("true");
    expect(box.getAttribute("aria-label")).toBeTruthy();
  });


  it("the bulk action is reachable from the keyboard, and the registry documents it", async () => {
    // THE GUARD for "reachable by keyboard, not just by mouse". The report's words were "I
    // can't select multiple emails and mark them seen"; a bar you can only finish with a
    // mouse is half of that. Remove the `shift+u` binding and both halves go red — the
    // keypress does nothing AND the `?` sheet stops listing it, because the sheet is
    // generated from this same table.
    await mountSeated([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ], { first: true });
    const listed = () => registry.find((b) => b.chord === "shift+u");
    expect(listed()).toBeTruthy();
    expect(listed()!.label).toBe("Mark the selection read");
    // Listed but inert while nothing is picked — a shortcut that disappears from the
    // documentation when its list is empty is a shortcut nobody learns.
    expect(listed()!.disabled).toBe(true);

    await key("x");
    await key("j");
    await key("x");
    expect(listed()!.disabled).toBe(false);

    await key("u", { shiftKey: true });
    expect(marked).toEqual([{ ids: ["a", "b"], unread: false }]);
    expect(pickCount()).toBeNull();
  });

  it("u ACTS ON THE SELECTION while there is one, and on the cursor row when there is not", async () => {
    /**
     * THE 0.15.0 LAW, and it is a behaviour change rather than an addition — stated here
     * because it is the kind that is easy to reintroduce by accident.
     *
     * This test used to assert the opposite: `u` marked the cursor's row unread and left a
     * standing selection untouched, so `x x u` marked ONE message while two were visibly
     * picked. The selection's verbs are the message pill now, every verb on it wears its
     * keycap, and a keycap on that pill must do what the pill does — so while a selection
     * exists the letters mean the selection. Gmail's model, and the `?` sheet says so in words
     * while the selection is up.
     *
     * BOTH HALVES ARE ASSERTED, because the interesting failure is not "u does nothing" but
     * "u does the wrong one of the two". The view's binding is declared ahead of the cursor's
     * twin and is `disabled` at zero picks, so the dispatcher falls through to the cursor's —
     * delete the `disabled` and the second half goes red; delete the binding and the first
     * half does.
     */
    await mountSeated([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }], { first: true });
    await key("x");
    await key("j");
    await key("x");
    expect(pickCount()).toBe("2");

    marked = [];
    await key("u");                        // …the whole selection, in ONE mutation
    expect(marked).toEqual([{ ids: ["a", "b"], unread: true }]);
    // The verb ran, so the pick is spent — the rule every bulk verb has always had.
    expect(pickCount()).toBeNull();

    // …and with nothing picked, the same key is the cursor's verb again.
    marked = [];
    await key("u");
    expect(marked).toEqual([{ ids: ["b"], unread: true }]);
  });

  it("Escape is declared in the REGISTRY, not in a listener of its own", async () => {
    // The requirement asks for Esc to clear the selection and for the binding to live in the keymap.
    // The behaviour is asserted above; this asserts WHERE it comes from, which is the part
    // that decays — five `document` Escape listeners is the state the registry exists to have ended,
    // and `FocusReplyOverlay` still carries the sixth (a known gap).
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await key("x");
    // TWO Escape bindings since that change, and their ORDER in this layer is the precedence:
    // `ordered()` runs the first match, so cancelling the bulk bar's open sub-row has to be
    // declared before clearing the selection. Swap them in `OhboxView` and one press would
    // discard a half-made screening decision AND the set it was about. With no sub-row open
    // the first is `disabled`, so the dispatcher skips it and Escape still clears — which is
    // the behaviour every other test in this describe asserts.
    //
    // FOUR since the zone model (`zone-nav.tsx`): the view's two are followed by the walk's
    // two — "back to the list" (reader zone) and "focus the menu" (list zone). NAMED here,
    // not waved through with a length check, because the order IS the ruling this test
    // exists to hold: the zone walk registers at `global` scope, so the view's own Escapes
    // stay ahead of it and a picked set is still cleared before any focus moves leftward.
    // With a selection standing the walk's list-zone Escape is ENABLED and sits BEHIND the
    // enabled clear — asserted below via the dispatch order the registry publishes.
    //
    // FIVE since the switch's point 64 (RULED: Escape closes the open letter beside a list): the frame's close of the
    // letter beside the list ("Close what is open") stands between the walk back to the list and the walk on to the
    // rail, so that one Escape from the list closes the letter before the next one focuses the menu.
    const escapes = registry.filter((b) => b.chord === "Escape");
    expect(escapes.map((b) => b.label)).toEqual([
      "Cancel the open row",
      "Clear the selection",
      "Back to the list",
      "Close what is open",
      "Focus the menu",
    ]);
    expect(escapes[0]!.disabled).toBe(true);
    expect(escapes[1]!.disabled).toBe(false);
    // The zone walk stands down where it does not apply (reader zone unfocused) and never
    // outranks the view: the first ENABLED Escape — the one `ordered()` dispatches — is
    // still the clear.
    expect(escapes[2]!.disabled).toBe(true);
    expect(escapes.find((b) => !b.disabled)!.label).toBe("Clear the selection");
  });

  it("no second global listener: after unmount, keys reach nothing", async () => {
    // The view registers its keys in its OWN effect and tears them down with itself. A second
    // global binding in `AppShell` would keep firing for every view in the product.
    await mountSeated([{ id: "a", subject: "A", unread: true }], { first: true });
    await unmount();
    marked = [];
    await key("u");
    expect(marked).toEqual([]);
  });
});
