/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import { stubThreadLayout, type ThreadLayout } from "../fixtures/thread-layout.js";

/**
 * READING MOVES THE MESSAGE TO "EARLIER", AND IT MOVES IT NOW — mail read here or on another client
 * (a `\Seen` the worker writes into the mirror) re-files without a reload, by SLIDING (`slideOut`:
 * the row keeps its slot for `SETTLE_MS` wearing `settling`, then is redrawn below). Three things
 * hold at once: the move happens whatever read the message; it never happens while the message is
 * the one being read (its read is saved while it is open, its place held until it is left — `heldRead`),
 * and it is never a teleport; a later explicit act beats it. THE HARNESS IS LIVE: `onMarkSeen`
 * mutates the mirror the way the shell's optimistic overlay does, or no row could change section.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Must match `SETTLE_MS` in `OhboxView.tsx` — the slide's own duration. */
const SETTLE_MS = 280;
/** Comfortably past the slide. */
const AFTER_SLIDE_MS = 400;

/** `false` is the split width (a reading column beside the list); `true` is the phone. */
function setViewport(mobile = false): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; threadId?: string; date?: string }

function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: `snip-${m.id}`, body: `the words of ${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** The mirror. `onMarkSeen` writes it, the way the engine's optimistic overlay does. */
let live: Row[] = [];
/** `AppShell`'s `ohboxSel` — null until something is deliberately selected. */
let sel: string | null = null;
/** Which message the reader sheet is showing, or null. Only ever set below 700px. */
let readerId: string | null = null;
const marked: Array<{ ids: string[]; unread: boolean }> = [];
let replyDone: { messageId: string; at: string } | null = null;

/**
 * THE SHELL'S HOLD, modelled: the view reports the row it entered (`onHoldRow`) and the shell has
 * the engine hold that row in New (`holdOpenRow`, only while it is unread then), deriving
 * the groups through `ohboxView`'s one rule — a CONVERSATION with a member `unread || id === held`
 * stands in New whole (pinned on the real selector in
 * `packages/client-engine/test/ohbox-one-row-per-conversation.test.ts`).
 */
let held: string | null = null;
const holdArmed = (id: string | null): void => {
  held = id !== null && live.find((r) => r.id === id)?.unread === true ? id : null;
};
const keyOf = (r: Row): string => r.threadId ?? `msg:${r.id}`;
const inNew = (r: Row): boolean =>
  live.some((o) => keyOf(o) === keyOf(r) && (o.unread || o.id === held));

/** Render the view over the mirror as it is NOW — one shell re-render. */
async function draw(): Promise<void> {
  const OhboxView = await (await import("./_today.js")).prepareToday();
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      newForYou: live.filter(inNew).map(msg),
      previouslySeen: live.filter((r) => !inNew(r)).map(msg),
      onHoldRow: holdArmed,
      replyDone,
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: sel,
      onSelect: (id: string) => { sel = id; },
      onEnterReader: (id: string) => { if (window.matchMedia("(max-width: 699.98px)").matches) readerId = id; },
      readerId, readSetFor: (id: string) => (live.find((r) => r.id === id)?.unread ? [id] : []),
      onMarkSeen: (ids: string[], unread: boolean) => {
        marked.push({ ids, unread });
        for (const id of ids) {
          const row = live.find((r) => r.id === id);
          if (row) row.unread = unread;
        }
      },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      onMarkAllRead: (ids: string[]) => {
        marked.push({ ids, unread: false });
        for (const id of ids) {
          const row = live.find((r) => r.id === id);
          if (row) row.unread = false;
        }
      },
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

async function mount(rows: Row[]): Promise<void> {
  live = rows.map((r) => ({ ...r }));
  sel = null;
  held = null;
  readerId = null;
  replyDone = null;
  await draw();
}

function rowEl(id: string): HTMLElement {
  const el = host!.querySelector<HTMLElement>(`[role=option][data-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}; rows on screen: ${idsInGroup("New").join(",")} | ${idsInGroup("Earlier").join(",")}`);
  return el;
}

/** The row standing for this message — its lead, or a folded member of it (`data-ids`). */
function rowHolding(id: string): HTMLElement {
  const el = host!.querySelector<HTMLElement>(`[role=option][data-id="${id}"], [role=option][data-ids~="${id}"]`);
  if (!el) throw new Error(`no row holds ${id}; rows on screen: ${idsInGroup("New").join(",")} | ${idsInGroup("Earlier").join(",")}`);
  return el;
}

/** The data-ids of the rows in the group with this aria-label ("New", "Earlier"). */
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll("[role=option][data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

/** A click, then the shell's re-render over whatever the click wrote, and a frame for the rule. */
async function click(id: string): Promise<void> {
  await act(async () => { rowEl(id).click(); });
  await draw();
  await frame();
}

/** A frame passes: the rule looks at what is on screen. */
async function frame(): Promise<void> {
  if (vi.isFakeTimers()) await act(async () => { vi.advanceTimersByTime(20); });
  else await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await draw();
}

/**
 * READ A MESSAGE FOR REAL, the way the split pane does it: a click OPENS it, and the read rule
 * saves the read of what is on screen; then the cursor moves off with `j`/`k` — a preview, the
 * departure that releases the row's place so it can slide, and reads nothing itself.
 */
async function readAndLeave(id: string, leaveTo: string): Promise<void> {
  await click(id);
  await layout.passDwell(); // the message's top on screen for the dwell: it is read
  const order = [...idsInGroup("Resurfaced"), ...idsInGroup("New"), ...idsInGroup("Earlier")];
  const from = order.indexOf(sel ?? id);
  const to = order.indexOf(leaveTo);
  const step = to > from ? "j" : "k";
  for (let i = 0; i < Math.abs(to - from); i++) await press(step);
}

/** An older member read in the conversation's column (the shell's rule), as the view is told. */
async function readInColumn(id: string, settled = true): Promise<void> {
  marked.push({ ids: [id], unread: false });
  live.find((r) => r.id === id)!.unread = false;
  await draw();
  if (settled) await settle();
  else await frame();
}

/** A chord, the way the keymap's dispatcher sees it, then the shell's re-render. */
async function press(key: string, shift = false): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));
  });
  await draw();
  await frame();
}

/**
 * Let the slide run to its end.
 *
 * It DRAWS FIRST, and that is not padding: a departure can land in an effect (the reader
 * sheet closing is one), so the mirror is a render behind at the moment this is called and the
 * view has not yet been given the list that starts the slide. Advancing a clock over a slide that
 * has not been armed is how a real move reads as no move at all.
 */
async function settle(ms = AFTER_SLIDE_MS): Promise<void> {
  await draw();
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await draw();
}

/**
 * A DELTA FROM SOMEWHERE ELSE — the worker writing an adopted `\Seen` (or an adopted unread) into
 * the mirror. No click, no keypress, nothing this view initiated: just the list it is handed
 * changing underneath it, which is the whole of how an external read reaches the Ohbox.
 */
async function delta(id: string, unread: boolean): Promise<void> {
  const row = live.find((r) => r.id === id);
  if (row) row.unread = unread;
  await draw();
}

let layout: ThreadLayout;
beforeEach(() => {
  layout = stubThreadLayout({ columnHidden: () => window.matchMedia("(max-width: 699.98px)").matches });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null; live = []; sel = null; readerId = null; replyDone = null;
  marked.length = 0;
  layout.restore();
  vi.useRealTimers();
});

describe("a message read in the Ohbox moves to Earlier, now", () => {
  it("the row slides out of New and lands under Earlier — no reload", async () => {
    /* THE HEADLINE GUARD. Delete the `slideOut` call from the effect that watches `earlierIds`
       in `OhboxView.tsx` — or the `setDismissed` inside `slideOut` — and this goes red: the
       message is read, the dot is gone, and the row sits in "New for you" for the rest of the
       session, which is exactly what was reported. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);
    expect(idsInGroup("New")).toEqual(["a", "b"]);

    await readAndLeave("a", "b");
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);

    await settle();
    expect(idsInGroup("New")).toEqual(["b"]);
    expect(idsInGroup("Earlier")).toEqual(["a"]);
  });


  it("mark-all-read empties New — every row slides, none is left behind", async () => {
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }, { id: "c", unread: false }]);
    await act(async () => { [...host!.querySelectorAll<HTMLElement>("button")].find((b) => /^Mark all \d+ unread messages read$/.test(b.getAttribute("aria-label") ?? ""))!.click(); });
    await draw();
    await settle();
    expect(idsInGroup("New")).toEqual([]);
    expect(idsInGroup("Earlier").sort()).toEqual(["a", "b", "c"]);
  });
});

describe("a conversation moves as one row", () => {
  it("one of three read: the row STAYS in New, count and all; the last read takes the row", async () => {
    /* The unit of reading is the message and the unit of place is the conversation, so a thread
       with unread replies left in it is still waiting and must not move. The harness models
       `ohboxView`'s filing; the rule itself is pinned by the engine census, where putting it back
       to per message reddens it. What this measures is the view: the read member rides the row,
       the row stays one, and it leaves New only with its last unread member. */
    vi.useFakeTimers();
    setViewport();
    await mount([
      { id: "t3", unread: true, threadId: "T", date: "2026-08-02T09:03:00.000Z" },
      { id: "t2", unread: true, threadId: "T", date: "2026-08-02T09:02:00.000Z" },
      { id: "t1", unread: true, threadId: "T", date: "2026-08-02T09:01:00.000Z" },
      { id: "solo", unread: true, date: "2026-08-02T09:00:00.000Z" },
    ]);
    // One row for the conversation, led by its latest unread, and one for the loner.
    expect(idsInGroup("New")).toEqual(["t3", "solo"]);
    expect(rowEl("t3").dataset.ids?.split(" ").length, "the row stands for its 3 letters").toBe(3);

    // Read the conversation's lead, then leave it.
    await readAndLeave("t3", "solo");
    await settle();

    // The conversation is still waiting — two replies of it are unread — so the row stands.
    // The read message RIDES that row (2026-09-28): the conversation is one row, and
    // its count is the conversation's length, not what is left unread. The row keeps t3's id:
    // a conversation opens on its newest, its older unread members wait.
    expect(idsInGroup("New")).toEqual(["t3", "solo"]);
    expect(rowEl("t3").dataset.ids?.split(" ").length, "the row stands for its 3 letters").toBe(3);
    expect(idsInGroup("Earlier")).toEqual([]);

    // Work through the rest, read in the conversation's column. The last one takes the row with it.
    await readInColumn("t2");
    expect(idsInGroup("New")).toEqual(["t3", "solo"]);

    await readInColumn("t1");
    expect(idsInGroup("New")).toEqual(["solo"]);
    // The whole conversation is one row under Earlier now.
    expect(idsInGroup("Earlier")).toEqual(["t3"]);
    expect(rowEl("t3").dataset.ids?.split(" ").length, "the row stands for its 3 letters").toBe(3);
  });

});

describe("a later explicit act beats a slide", () => {

  it("an unread arriving from another client brings a row that already went down BACK", async () => {
    /* `dismissed` takes an entry for every message read in the session now, so a permanent one
       would swallow the way back. Drop the `earlierIds` conjunct from `dropped` in
       `OhboxView.tsx` and this goes red: mail marked unread in Outlook re-partitions into "New
       for you" and this view refuses to draw it there — the row is in neither section. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);
    await readAndLeave("a", "b");
    await settle();
    expect(idsInGroup("Earlier")).toEqual(["a"]);

    await delta("a", true);            // somebody marked it unread on another device
    await settle();
    expect(idsInGroup("New")).toContain("a");
    expect(idsInGroup("Earlier")).toEqual([]);
  });
});

describe("the reader is not yanked", () => {
  it("the row does not move while the message is the one being read", async () => {
    /* The only thing standing between the reader and a list that re-sorts under their eyes: the
       read is saved while the message is open and the list re-partitions, but the held place keeps
       the row in its group — the view reports the row it entered and the shell's selector holds it
       (`holdArmed`, `inNew` above). Report nothing and this goes red: the row leaves while it is
       being read. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);

    await click("a");                                    // a click opens; the dwell done, the read is saved
    await layout.passDwell();
    await settle();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(idsInGroup("New")).toEqual(["a", "b"]);
    expect(rowEl("a").classList.contains("settling")).toBe(false);
    // The row HOLDS ITS PLACE and presents as read, which it now is.
    expect(rowEl("a").dataset.unseen).toBeUndefined();

    await press("j");                                    // moving on is the departure
    await settle();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(idsInGroup("Earlier")).toEqual(["a"]);
  });

  it("nothing writes the list's scrollTop — the slide never moves the viewport itself", async () => {
    /* The row's own height is animated away and the browser's scroll anchoring does the rest.
       Add a `scrollTop` assignment anywhere on the slide path — the obvious "scroll the reader
       back to the top" — and this goes red. A reader forty rows down does not expect a message
       they finished with to take the page with it. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);
    const scroller = host!.querySelector(".ob-scroll")!;
    let writes = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => { writes += 1; },
    });

    await readAndLeave("a", "b");
    await settle();
    expect(idsInGroup("Earlier")).toEqual(["a"]);
    expect(writes).toBe(0);
  });
});

describe("a read that happened somewhere else", () => {

  it("a settled reply marks the answered message read, and the same slide carries it down", async () => {
    /* The reply case is no longer a mechanism of its own — `replyDone` writes the read state and
       `slideOut` does the rest. Delete the `markSeenRef` call from the `replyDone` effect and
       this goes red at the dispatch: answering a message would leave it sitting in "New for you"
       as unanswered mail. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "p", unread: true }, { id: "keep", unread: true }]);

    replyDone = { messageId: "p", at: "2026-08-02T09:01:00.000Z" };
    await draw();
    expect(marked).toEqual([{ ids: ["p"], unread: false }]);
    await draw();                                        // the shell's re-render on the flip

    await settle();
    expect(idsInGroup("New")).toEqual(["keep"]);
    expect(idsInGroup("Earlier")).toEqual(["p"]);
  });
});
