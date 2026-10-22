/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * READ-STATE IN THE OHBOX. Two judgements pull against each other: an open (Enter, a click on a
 * row, a mobile tap) ENTERS the conversation, and a j/k sweep past a row is a preview that
 * establishes NOTHING, however long it rests — get that wrong and a keyboard user empties their
 * own Ohbox by scrolling through it. In an entered conversation a message turns read once its
 * first and last line have been on screen (the thread-read rule), and that read is SAVED at once.
 * What still waits for the way out (a cursor move, unmount, the sheet closing where it was the
 * reading, Back) is the row's PLACE, so nothing re-sorts under the reader. The reading column has
 * a laid-out geometry here (`fixtures/thread-layout.ts`): a message's lines are on screen.
 */
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

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

/** The old dwell, kept as a length of rest: a preview resting this long still reads nothing. */
const DWELL_MS = 2000;

interface Msg {
  id: string; subject: string; unread: boolean;
}

/** A minimal EngineMessage, complete enough for MessageRow + the view's own reads. */
function msg(m: Msg): Record<string, unknown> {
  return {
    id: m.id,
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: m.subject,
    from: { name: m.id, address: `${m.id}@example.com` },
    to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z",
    folder: "INBOX",
    snippet: "preview",
    // The body rides the row, so the inert chrome reports it `full` and the rule may read it.
    body: `the words of ${m.id}`,
    unread: m.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
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
let selectedId: string | null = null;
/**
 * The shell's `readerFor` — which message the reader SHEET is showing, or null.
 *
 * Modelled here because closing the sheet is one of the four departures, and at a width with no
 * reading column it is the only one a phone reader ever performs. The shell opens the sheet
 * ONLY where the reading column is hidden (`AppShell.enterReader` asks the same media query),
 * so both harnesses below gate it the same way rather than opening it at every width — a sheet
 * that opened on the desktop would let a desktop test close one that the product never shows.
 */
let readerFor: string | null = null;
/** Re-render whichever harness is mounted; assigned by `mount`/`mountLive`. */
let rerenderNow: () => Promise<void> = async () => {};
/** The keyboard registry's live binding table, captured by the probe inside `mount`. */
let registry: Array<{ chord: string; label: string; disabled: boolean }> = [];
/** Every bulk verb OTHER than read-state that the selection's bar dispatched. */
let bulkRuns: Array<{ action: string; ids: string[] }> = [];

/**
 * The shell's half of the selection's bar, as much of it as this file's claims need.
 *
 * `⇧U` and the bar's Read button both travel `bulk.run` since that change — one path for one
 * verb, which is the rule about the read switch applied to a set. The read-state arm is
 * therefore forwarded to the SAME writer `onMarkSeen` records, because that is exactly what
 * `AppShell.onBulkAction` does with it: `markSeen(ids, unread)`, the one `mark_seen` call
 * site in the product. Every assertion in this file about what read-state the view wrote is
 * unchanged by the indirection, which is the point of modelling it rather than routing
 * around it.
 */
const bulkStub = (write: (ids: string[], unread: boolean) => void) => ({
  /* `true` = DISPATCHED, and the view clears the pick on it. The real `onBulkAction` returns
     `false` only when a READER is refused at the press — a case this stub has no role to be
     in — so an unconditional `true` is what an organizing install actually answers. Returning
     nothing here would model a permanent refusal, and every "the verb spent the pick"
     assertion in this file would go red for a reason that has nothing to do with the view. */
  run: (action: string, ids: string[]) => {
    if (action === "read" || action === "unread") write(ids, action === "unread");
    else bulkRuns.push({ action, ids });
    return true;
  },
  tag: () => {},
  screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }),
  screen: () => true,
});

/** Is the reading column hidden? The same question `AppShell.readColumnHidden` asks. */
const columnHidden = (): boolean => window.matchMedia("(max-width: 699.98px)").matches;

/** jsdom has no matchMedia; the view asks it whether it is in the split pane. */
function setViewport(mobile: boolean): void {
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

/**
 * Is a harness currently up? Both harnesses re-render from inside `onMarkSeen`; cleared before
 * the unmount so a write landing during teardown never renders into a root React has torn down.
 */
let mounted = false;

/** Tear the current view down — its keydown listener goes with it. */
async function unmount(): Promise<void> {
  mounted = false;
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mount(rows: Msg[], opts: { selected?: string } = {}): Promise<void> {
  // A second mount without a teardown would leave TWO views listening on `document`, which is
  // exactly the leak the last test in this file is about.
  await unmount();
  const { OhboxView } = await import("../app/views/OhboxView.js");
  // Since that change the view declares its keys into the keyboard registry instead of adding its
  // own `document` listener, so the provider is part of mounting it — and the keypresses
  // below now travel the same path they do in the product.
  const { KeymapProvider, useKeymap } = await import("../app/shell/keymap.js");
  const all = rows.map(msg);
  selectedId = opts.selected ?? rows[0]?.id ?? null;

  /**
   * Reads the LIVE binding table out of the registry — the only way to assert that a key
   * is bound HERE rather than by some component's own `document` listener. It is also what
   * the `?` sheet is generated from, so a binding this sees is a binding the sheet lists.
   */
  const Probe = (): null => {
    registry = useKeymap().bindings.map((b) => ({
      chord: b.chord, label: b.label, disabled: b.disabled === true,
    }));
    return null;
  };

  const render = (): React.ReactNode =>
    h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(KeymapProvider as never, { children: [h(Probe, { key: "probe" }), h(OhboxView as never, {
    settled: true, owed: false,
        key: "view",
        demo: false,
        // A client with the WHOLE mailbox on the device: `listOlderAvailable()` is false, so the
        // view renders no "load older mail" control and this harness is unchanged by the window.
        older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
        newForYou: all.filter((m) => m.unread),
        previouslySeen: all.filter((m) => !m.unread),
        tags: [],
        now: new Date("2026-08-02T09:00:00.000Z"),
        selectedId,
        onSelect: (id: string) => { selectedId = id; void rerender(); },
        onEnterReader: (id: string) => {
          entered++;
          // The shell's gate, verbatim: the sheet is raised only where the reading column is
          // `display:none`. At a split width "open" is answered by the column already showing it.
          if (columnHidden()) { readerFor = id; void rerender(); }
        },
        readerId: readerFor, readSetFor: (id: string) => [id],
        onMarkSeen: (ids: string[], unread: boolean, via?: "glance") => { marked.push({ ids, unread, via }); },
        bulk: bulkStub((ids: string[], unread: boolean) => { marked.push({ ids, unread }); }),
        doorbellInitials: [],
        doorbellCount: 0,
        onDoorbell: () => {},
        onAction: () => {},
        onAddTag: () => {},
      } as never)] } as never),
    });

  const rerender = async (): Promise<void> => {
    if (!mounted) return;
    await act(async () => { root!.render(render()); });
  };
  rerenderNow = rerender;

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
  await rerender();
}

/* ── the LIVE harness: a list that actually re-partitions ──────────────────────────────────
   `mount` above is INERT. Its `onMarkSeen` records the call and never touches a row, so the
   list it renders can never re-partition — and the runaway below was therefore structurally
   invisible to every test in this file. This harness is faithful to the shell instead:

     · `ohboxSel` starts NULL and is only ever written by `onSelect`, exactly as in the shell;
     · the selection resolves the SAME way the shell resolves it — `find(id === ohboxSel)` and
       NOTHING ELSE. It used to mirror an implicit `?? all[0]` fallback, which is how the
       runaway became visible here at all; both the shell's and the view's are deleted now, and
       the mirror went with them. Never put it back: a harness that resolves a selection the
       product does not have would report an auto-opened Ohbox as correct, which is the one
       thing these tests exist to catch;
     · `mark_seen` applies OPTIMISTICALLY, flipping `unread` on the mirror row exactly as the
       `mark_seen` branch of `mutations.ts` does, so the row leaves "New for you" and the two
       groups re-partition — which is the entire mechanism;
     · entity identity is CACHED per row, because the engine hands back the same object until
       the row itself changes. Rebuilding entities every render would make `selected` change
       identity on every commit for reasons the product never has, and the test would then be
       measuring its own churn instead of the bug. */

/** The mirror `mountLive` renders, mutated in place by `mark_seen`. */
let live: Msg[] = [];
/** `AppShell`'s `ohboxSel` — null until something is deliberately selected. */
let ohboxSel: string | null = null;
let entities = new Map<string, { unread: boolean; entity: Record<string, unknown> }>();
/** Land a new message at the top of "New for you", the way a sync delta does. */
let pushLive: (row: Msg) => Promise<void> = async () => {};
/** Take a message OUT of the Ohbox, the way a move or a file does. */
let dropLive: (id: string) => Promise<void> = async () => {};

function entityOf(r: Msg): Record<string, unknown> {
  const hit = entities.get(r.id);
  if (hit && hit.unread === r.unread) return hit.entity;
  const entity = msg(r);
  entities.set(r.id, { unread: r.unread, entity });
  return entity;
}

const unreadIds = (): string[] => live.filter((r) => r.unread).map((r) => r.id);

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
const inNew = (r: { id: string; unread: boolean }): boolean => r.unread || r.id === held;

async function mountLive(rows: Msg[]): Promise<void> {
  await unmount();
  const { OhboxView } = await import("../app/views/OhboxView.js");
  // The registry probe is here too, and not only in `mount`, for one claim `mount` cannot make:
  // that harness always starts with a row selected, so it can never observe what the `?` sheet
  // says about an Ohbox nobody has touched.
  const { KeymapProvider, useKeymap } = await import("../app/shell/keymap.js");
  const Probe = (): null => {
    registry = useKeymap().bindings.map((b) => ({
      chord: b.chord, label: b.label, disabled: b.disabled === true,
    }));
    return null;
  };
  live = rows.map((r) => ({ ...r }));
  ohboxSel = null;
  held = null;
  entities = new Map();

  const liveMarkSeen = (ids: string[], unread: boolean, via?: "glance"): void => {
    marked.push({ ids, unread, via });
    for (const id of ids) {
      const row = live.find((r) => r.id === id);
      if (row) row.unread = unread;
    }
    void rerender();
  };

  const render = (): React.ReactNode => {
    const newForYou = live.filter(inNew);
    const previouslySeen = live.filter((r) => !inNew(r));
    const order = [...newForYou, ...previouslySeen];
    const selected = order.find((r) => r.id === ohboxSel) ?? null;
    return h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(KeymapProvider as never, {
        children: [h(Probe, { key: "probe" }), h(OhboxView as never, {
    settled: true, owed: false,
          key: "view",
          demo: false,
          // A client with the WHOLE mailbox on the device: `listOlderAvailable()` is false, so the
          // view renders no "load older mail" control and this harness is unchanged by the window.
          older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
          newForYou: newForYou.map(entityOf),
          previouslySeen: previouslySeen.map(entityOf),
          tags: [],
          now: new Date("2026-08-02T09:00:00.000Z"),
          selectedId: selected?.id ?? null,
          onSelect: (id: string) => { ohboxSel = id; void rerender(); },
          onEnterReader: (id: string) => {
            entered++;
            if (columnHidden()) { readerFor = id; void rerender(); }
          },
          readerId: readerFor, readSetFor: (id: string) => [id],
          onMarkSeen: liveMarkSeen,
          onHoldRow: holdArmed,
          bulk: bulkStub(liveMarkSeen),
          doorbellInitials: [],
          doorbellCount: 0,
          onDoorbell: () => {},
          onAction: () => {},
          onAddTag: () => {},
        } as never)],
      } as never),
    });
  };

  const rerender = async (): Promise<void> => {
    if (!mounted) return;
    await act(async () => { root!.render(render()); });
  };
  rerenderNow = rerender;
  pushLive = async (row: Msg): Promise<void> => {
    live.unshift({ ...row });
    await rerender();
  };
  dropLive = async (id: string): Promise<void> => {
    live = live.filter((r) => r.id !== id);
    await rerender();
  };

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
  await rerender();
}

/* ── the SHELL harness: the whole client, on the demo engine ───────────────────────────────
   Both harnesses above stop at `OhboxView`, which is right for everything they assert and
   blind to exactly one thing: the shell keeps its OWN resolved selection (`selectedOhbox`),
   and that is what decides which body is fetched, which attachments are held and what the
   message verbs act on. A view-level guard cannot see it, so a half-deletion — this view's
   fallback removed, the shell's left standing — would look green and still open mail nobody
   asked for. `demo: true` because the fixture engine has an Ohbox with unread mail in it and
   no network at all. */
async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
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

/**
 * Sit still for `n` whole dwell periods, flushing React between each.
 *
 * One long `advanceTimersByTime` is NOT equivalent: a cascade re-arms from inside a commit,
 * and the commit only lands when the floating `rerender()` promise resolves at the end of an
 * `act`. Advancing in whole-period steps gives a runaway the same room it has in a browser.
 */
const idle = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await act(async () => { vi.advanceTimersByTime(DWELL_MS); });
  }
};

/** Past the 280 ms slide to "Earlier" and short of a dwell, so no other row is armed. */
const slide = async (): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(400); });
};

/** A frame passes: the rule looks at what is on screen. */
const frame = async (): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(20); });
};

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
  await frame();
};

const rowEl = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!;

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
  host!.querySelector('.list-foot .abar-count [role="status"]')?.textContent ?? null;

/** Is this message's row in the group with this label ("New", "Earlier")? */
const inGroup = (label: string, id: string): boolean =>
  host!.querySelector(`[role="listbox"][aria-label="${label}"] .row[data-id="${id}"]`) != null;

/* ── the four departures, as a test can perform them ─────────────────────────────────────────
   #1 (the cursor moves) is `key("j")` / `click(other)` and needs no helper. */

/** #3 — the shell dismisses the reader sheet. */
const closeReader = async (): Promise<void> => {
  readerFor = null;
  await rerenderNow();
};

/** #4 — the tab is closed, navigated away from, or frozen into the back/forward cache. */
const pagehide = async (): Promise<void> => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
};

let layout: ThreadLayout;
beforeEach(() => {
  vi.useFakeTimers();
  layout = stubThreadLayout({ columnHidden });
  marked = [];
  bulkRuns = [];
  entered = 0;
  selectedId = null;
  ohboxSel = null;
  readerFor = null;
  rerenderNow = async () => {};
  live = [];
  registry = [];
  setViewport(false);
});

afterEach(async () => {
  await unmount();
  layout.restore();
  // The shell guard spies on the engine's own body fetch; a spy left installed would silence
  // it for every file that runs after this one in the same worker.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("opening a message enters it: what is on screen is read and SAVED; leaving releases its place", () => {
  it("↵ opens the reader and saves the read once its top was on screen for the dwell; leaving writes nothing more", async () => {
    // THE GUARD. Drop the `markSeenRef` call from `readByRule` in `OhboxView.tsx` and this
    // goes red: the message is read on screen while nothing is sent.
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("Enter");
    expect(marked, "the write waits for the dwell").toEqual([]);
    await layout.passDwell();
    expect(marked).toEqual([glance("a")]);
    expect(entered).toBe(1);
    await key("j");
    expect(marked).toEqual([glance("a")]);
  });

  it("a click on a row is an open: it enters, and what is on screen is saved read", async () => {
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
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
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await click("b");
    expect(entered).toBe(1);
    expect(readerFor).toBe("b");
    expect(marked).toEqual([]);
    await closeReader();
    expect(marked).toEqual([]);
  });

  it("opening an ALREADY-read message arms nothing, so no departure writes anything", async () => {
    await mount([{ id: "a", subject: "A", unread: false }]);
    await key("Enter");
    expect(marked).toEqual([]);
    expect(entered).toBe(1);
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("the message being read keeps its PLACE, and its ink and the count agree with the save", async () => {
    // The row is saved read at the open and the list re-partitions, but the held place keeps it
    // in "New" under the reader (the shell's hold, `holdArmed`: report nothing from `onHoldRow`
    // and it is gone after the 280 ms slide); leaving files it under "Earlier". The count follows the save.
    await mountLive([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    await key("j");                         // cursor to "a" (nothing is open until something is)
    await key("Enter");                     // …and opens it
    await idle(20);
    expect(unreadIds()).toEqual(["b"]);
    expect(inGroup("New", "a"), "the saved read moved the row under the reader").toBe(true);
    expect(rowEl("a").querySelector(".dot-unread")).toBeNull();
    expect(text()).toContain("1 unread");

    await key("j");                         // …and leaving is what moves it
    await slide();
    expect(inGroup("Earlier", "a")).toBe(true);
    expect(marked).toEqual([glance("a")]);
  });
});

describe("a preview reads nothing — j/k is navigating, however long it rests", () => {
  it("a j/k sweep past several rows commits NOTHING", async () => {
    // THE GUARD that matters most here. Make `selectByUser` enter the conversation and this goes
    // red: every row the sweep touched is marked read, i.e. a keyboard user empties their own
    // Ohbox by scrolling through it.
    await mount([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
      { id: "d", subject: "D", unread: true },
    ]);
    for (const _ of [1, 2, 3]) {
      await key("j");
      await act(async () => { vi.advanceTimersByTime(DWELL_MS - 100); });
    }
    expect(marked).toEqual([]);
  });

  it("a preview resting forty seconds saves nothing, with the message on screen", async () => {
    // Base: the 2 s dwell saved it. A preview is never a read, so nobody's mail turns read by a
    // cursor left on it.
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("j");
    await idle(20);
    expect(marked).toEqual([]);
    await key("Enter");                     // …and entering it is what reads
    await layout.passDwell();
    expect(marked).toEqual([glance("b")]);
  });

  it("resting on a row and then MOVING ON commits nothing", async () => {
    await mount([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ]);
    await key("j");
    await act(async () => { vi.advanceTimersByTime(DWELL_MS); });
    await key("j");
    expect(marked).toEqual([]);
  });

  it("passing through a row saves nothing, then or on the way out", async () => {
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("j");
    await act(async () => { vi.advanceTimersByTime(DWELL_MS - 100); });
    await key("k");
    expect(marked).toEqual([]);
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("a selection on MOBILE shows nothing and reads nothing", async () => {
    setViewport(true);
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("j");
    await act(async () => { vi.advanceTimersByTime(DWELL_MS * 3); });
    // Nothing was armed, so nothing is saved — and every departure agrees.
    expect(marked).toEqual([]);
    await key("k");
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("an already-read selection writes nothing", async () => {
    await mount([{ id: "a", subject: "A", unread: false }]);
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
    await mountLive([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
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
    await mountLive([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
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
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("Enter");
    await layout.passDwell();
    expect(marked).toEqual([glance("a")]);
    await unmount();
    expect(marked).toEqual([glance("a")]);
  });

  it("#3 — the reader sheet closing, AT A MOBILE WIDTH, writes nothing", async () => {
    setViewport(true);
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("Enter");
    expect(readerFor).toBe("a");
    await closeReader();
    expect(marked, "the sheet is the reading there; closing it is leaving, not reading").toEqual([]);
  });

  it("#3 does NOT fire at a SPLIT width — the column is still showing the message", async () => {
    // On the desktop the sheet duplicates a column that stays up, so dismissing it leaves the
    // message on screen. Drop the media check in the reader-close effect and this goes red: the
    // row slides to "Earlier" while the reader is still looking at it.
    await mountLive([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("j");
    await key("Enter");
    // The shell never raises a sheet at this width (`enterReader` is gated): simulate one opened
    // from another surface, the one case that can still close here.
    readerFor = "a";
    await rerenderNow();
    await closeReader();
    await idle(1);
    expect(inGroup("New", "a")).toBe(true);
    expect(marked).toEqual([glance("a")]);
  });

  it("#4 — pagehide owes nothing: the read went out at the open", async () => {
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("Enter");
    await layout.passDwell();
    expect(marked).toEqual([glance("a")]);
    await pagehide();
    expect(marked).toEqual([glance("a")]);
  });

  it("a read is written ONCE, however many departures arrive", async () => {
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("Enter");
    await layout.passDwell();
    readerFor = "a";
    await rerenderNow();
    await closeReader();
    await pagehide();
    await unmount();
    expect(marked).toEqual([glance("a")]);
  });

  it("a message filed out of the Ohbox while previewed is not written", async () => {
    await mountLive([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    await key("j");                         // the dwell starts on "a"
    await act(async () => { vi.advanceTimersByTime(DWELL_MS / 2); });
    await dropLive("a");                    // …and a move/file takes it out of the Ohbox
    await idle(2);
    await pagehide();
    expect(marked).toEqual([]);
  });

  it("a message already read by another device while previewed is not re-written", async () => {
    await mountLive([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
    ]);
    await key("j");                         // the dwell starts on "a"
    await act(async () => { vi.advanceTimersByTime(DWELL_MS / 2); });
    live.find((r) => r.id === "a")!.unread = false;   // a delta from elsewhere
    await rerenderNow();
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
    await mountLive(FIVE);
    await idle(20);
    expect(marked).toEqual([]);
    expect(unreadIds()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("opening ONE message commits exactly one; the other four stay unread", async () => {
    await mountLive(FIVE);
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
    await mountLive(FIVE);
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
    await mountLive(FIVE);
    await click("a");                       // selects
    await click("a");                       // …and opens
    expect(ohboxSel).toBe("a");
    await idle(20);
    expect(ohboxSel).toBe("a");
  });

  it("an open saves that one, and stops there", async () => {
    // The save re-partitions the list, and the next unread row is not entered by it — only a
    // person's open enters.
    await mountLive(FIVE);
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
    await mountLive(FIVE);
    await key("j"); await key("Enter"); await idle(1);
    expect(marked).toEqual([glance("a")]);
    await key("j"); await key("Enter"); await idle(1);
    expect(marked).toEqual([glance("a"), glance("b")]);
    await idle(20);
    expect(marked).toHaveLength(2);
  });

  it("a j/k sweep over a list that re-partitions still commits nothing", async () => {
    await mountLive(FIVE);
    for (const _ of [1, 2, 3, 4]) {
      await key("j");
      await act(async () => { vi.advanceTimersByTime(DWELL_MS - 100); });
    }
    expect(marked).toEqual([]);
    expect(unreadIds()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a click that MOVES the cursor enters, unlike j: that one is read, and only that one", async () => {
    // A click is an open: a mouse never previews, or a mouse would never read.
    await mountLive(FIVE);
    await click("c");
    await idle(20);
    await pagehide();
    expect(marked).toEqual([glance("c")]);
    expect(unreadIds()).toEqual(["a", "b", "d", "e"]);
  });

  it("a message read by another route while previewed is not written a second time", async () => {
    await mountLive(FIVE);
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
    await mountLive(FIVE);
    await key("j");                                   // …on a message, which now takes a cursor
    await key("i", { shiftKey: true });
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(unreadIds()).toEqual(["b", "c", "d", "e"]);
  });

  it("entering an ALREADY-READ row writes nothing", async () => {
    await mountLive([
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
    await mountLive(FIVE);
    await key("j");
    await key("Enter");                               // "a" is entered and read
    await pushLive({ id: "z", subject: "Z", unread: true });
    await idle(20);
    await pagehide();
    expect(marked).toEqual([glance("a")]);
    expect(unreadIds()).toEqual(["z", "b", "c", "d", "e"]);
  });

  it("`u` is not undone by the rule: the opened message stays unread for the visit", async () => {
    // Drop the `keepUnread` in `markUnread` and this goes red — the explicit `u` is reverted by
    // the rule in the next frame, while the user watches.
    await mountLive([
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
    await mountLive([
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
    await mountLive(FIVE);
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

  /** The reading column's contents, as two questions: is a message in it, and is the rest state? */
  const column = (): { pane: Element | null; rest: Element | null; text: string } => {
    const col = host!.querySelector<HTMLElement>(".read-col")!;
    return {
      pane: col.querySelector(".msg"),
      rest: col.querySelector(".empty"),
      text: col.textContent ?? "",
    };
  };

  it("GUARD (a) — a fresh Ohbox rests; the newest unread message is NOT in the column", async () => {
    // Fails against the shipped code with `.msg` present: the view's own `?? all[0]` had already
    // resolved "the selection" to the first unread row, so `MessagePane` rendered it.
    await mountLive(THREE);
    const { pane, rest, text } = column();
    expect(pane, "the Ohbox opened a message nobody asked for").toBeNull();
    expect(rest, "the column is blank rather than resting").not.toBeNull();
    expect(text).toContain(messages.ohbox.emptyRestTitle);
    // …and the list is untouched: every row is still new, and still says so.
    expect(unreadIds()).toEqual(["a", "b", "c"]);
    expect(marked).toEqual([]);
  });

  it("…and the FIRST j is what opens one — the resting state is a state, not a wall", async () => {
    await mountLive(THREE);
    await key("j");
    expect(column().pane, "the first j opened nothing").not.toBeNull();
    expect(ohboxSel).toBe("a");
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
    await mountLive(THREE);
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
    await mountLive(THREE);
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
    await mountShell();
    expect(asked, "the shell hydrated a body for a message nobody opened").toEqual([]);
    await key("j");
    expect(asked).toHaveLength(1);
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
    await mount([{ id: "a", subject: "A", unread: false }]);
    await key("u");
    expect(marked).toEqual([{ ids: ["a"], unread: true }]);

    // IDEMPOTENT — the property a toggle does not have. Pressing it again asks for the same
    // state rather than undoing it.
    marked = [];
    await mount([{ id: "z", subject: "Z", unread: true }]);
    await key("u");
    expect(marked).toEqual([{ ids: ["z"], unread: true }]);
  });

  it("shift+i marks read whatever the message already was", async () => {
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("i", { shiftKey: true });
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);

    marked = [];
    await mount([{ id: "z", subject: "Z", unread: false }]);
    await key("i", { shiftKey: true });
    expect(marked).toEqual([{ ids: ["z"], unread: false }]);
  });

  it("bare i is not shift+i — an unshifted letter must not run the shifted verb", async () => {
    // `chordMatches` holds plain letters to this rule so a shifted binding is reachable at
    // all. Asserted here because `i` is unbound, so a leak would look like nothing happening.
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("i");
    expect(marked).toEqual([]);
  });

  it("a modifier key is not `u` — ⌘U belongs to the browser", async () => {
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("u", { metaKey: true });
    expect(marked).toEqual([]);
  });
});

describe("multi-select", () => {
  it("x picks at the cursor, the bar counts, and its action marks the whole selection", async () => {
    await mount([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ]);
    await key("x");
    expect(pickCount()).toBe("1");
    await key("j");
    await key("x");
    expect(pickCount()).toBe("2");
    expect(rowEl("a").className).toContain("picked");

    // Marking the selection dispatches ONE mutation with both ids — one request, one
    // transaction, one intent.
    // BY NAME since that change, and the name is shorter since the bar became the message pill:
    // the read pair is "Read | Unread" with the pill's own dots, so the label is "Read". The
    // claim below — one mutation carrying both ids — is unchanged.
    await act(async () => {
      [...host!.querySelectorAll<HTMLButtonElement>(".list-foot .abar-b")]
        .find((b) => (b.textContent ?? "").trim().startsWith("Read"))!
        .click();
    });
    expect(marked).toEqual([{ ids: ["a", "b"], unread: false }]);
    expect(pickCount()).toBeNull();
  });

  it("x on an already-picked row unpicks it", async () => {
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("x");
    expect(pickCount()).toBe("1");
    await key("x");
    expect(pickCount()).toBeNull();
  });

  it("shift-click extends a range from the anchor and does NOT move the cursor", async () => {
    await mount([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
      { id: "d", subject: "D", unread: true },
    ]);
    await key("x");                       // anchor at "a"
    await click("c", { shiftKey: true });
    expect(pickCount()).toBe("3");
    for (const id of ["a", "b", "c"]) expect(rowEl(id).className).toContain("picked");
    expect(rowEl("d").className).not.toContain("picked");
    // The capture-phase handler stopped the row's own click, so the reader never opened.
    expect(entered).toBe(0);
    expect(marked).toEqual([]);
  });

  it("Esc clears the selection", async () => {
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("x");
    expect(pickCount()).toBe("1");
    await key("Escape");
    expect(pickCount()).toBeNull();
  });

  it("the selection does not survive the view unmounting — it is not a document", async () => {
    await mount([{ id: "a", subject: "A", unread: true }]);
    await key("x");
    expect(pickCount()).toBe("1");
    await unmount();

    await mount([{ id: "a", subject: "A", unread: true }]);
    expect(pickCount()).toBeNull();
  });

  it("a picked row is aria-selected, inside a multi-selectable listbox", async () => {
    // THE GUARD for the first half. Measured live with many unread rows
    // present: picking rows set `aria-selected` on ZERO of them — the pick was a class name
    // and nothing else, so it existed for sighted mouse users and for nobody else. Delete
    // the `picked` prop pass-through in `OhboxView`, or the role and `aria-selected` in
    // `MessageRow`, and every assertion here goes red.
    await mount([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ]);
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

  it("the count is ANNOUNCED and sits OUTSIDE the scroller, so it cannot scroll away", async () => {
    // THE GUARD for the second half. The bar was once the scroller's first child, so a
    // selection made forty rows down scrolled its own count and its own action off screen.
    // Put it back inside `ListPane`'s children and the `.scroller` assertion goes red.
    //
    // WHICH SIDE OF THE SCROLLER IS NOT THE CLAIM, and the title used to say "above" as if it
    // were. The bar stands in the column's FOOT now, under the scroller, where this product
    // puts the verbs for the thing you are looking at. What the defect was about — and what is
    // asserted — is that it is not INSIDE the scroller and therefore cannot scroll away.
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
    await key("x");

    // Every bar, not the first one: `querySelector` alone passed a mutation that ADDED a
    // second copy back inside the scroller, because the header's came first in document
    // order. A count rendered twice is its own defect anyway.
    const bars = [...host!.querySelectorAll<HTMLElement>(".list-foot")];
    expect(bars).toHaveLength(1);
    const bar = bars[0]!;
    expect(bar.textContent).toContain("selected");
    expect(pickCount()).toBe("1");
    // ANNOUNCED, and it is the NUMBER that carries the live region now: the count is a span
    // inside the capsule rather than a sentence in a wash, so a change in it is what speaks.
    expect(bar.querySelector('[role="status"]')?.textContent).toBe("1");
    expect(bar.closest(".scroller")).toBeNull();
    expect(host!.querySelector(".list-col")!.contains(bar)).toBe(true);
  });

  it("the bulk action is reachable from the keyboard, and the registry documents it", async () => {
    // THE GUARD for "reachable by keyboard, not just by mouse". The report's words were "I
    // can't select multiple emails and mark them seen"; a bar you can only finish with a
    // mouse is half of that. Remove the `shift+u` binding and both halves go red — the
    // keypress does nothing AND the `?` sheet stops listing it, because the sheet is
    // generated from this same table.
    await mount([
      { id: "a", subject: "A", unread: true },
      { id: "b", subject: "B", unread: true },
      { id: "c", subject: "C", unread: true },
    ]);
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
    await mount([{ id: "a", subject: "A", unread: true }, { id: "b", subject: "B", unread: true }]);
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
    await mount([{ id: "a", subject: "A", unread: true }]);
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
    const escapes = registry.filter((b) => b.chord === "Escape");
    expect(escapes.map((b) => b.label)).toEqual([
      "Cancel the open row",
      "Clear the selection",
      "Back to the list",
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
    await mount([{ id: "a", subject: "A", unread: true }]);
    await unmount();
    marked = [];
    await key("u");
    expect(marked).toEqual([]);
  });
});
