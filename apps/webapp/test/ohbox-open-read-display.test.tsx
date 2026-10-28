/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * WHAT THE SCREEN SAYS IS WHAT THE ACCOUNT HOLDS (owner-reported presentation). An open enters the
 * conversation and the message on screen is read by the thread-read rule: the row's dot and weight
 * go, the open message's verb says "Mark unread" and the read is SAVED in the same moment, so the
 * counts agree with the row. A j/k preview shows the message and changes nothing. The row keeps
 * its PLACE under New until it is left, and `u` re-bolds it in place, puts the verb back and keeps
 * it unread for the visit. The column is laid out (`fixtures/thread-layout.ts`).
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Comfortably past the slide. */
const AFTER_SLIDE_MS = 400;

function setViewport(mobile = false): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; date?: string }

function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
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
let sel: string | null = null;
const marked: Array<{ ids: string[]; unread: boolean }> = [];
const heldLog: Array<string | null> = [];

async function draw(): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      newForYou: live.filter((r) => r.unread).map(msg),
      previouslySeen: live.filter((r) => !r.unread).map(msg),
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: sel,
      onSelect: (id: string) => { sel = id; },
      onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => (live.find((r) => r.id === id)?.unread ? [id] : []),
      onMarkSeen: (ids: string[], unread: boolean) => {
        marked.push({ ids, unread });
        for (const id of ids) {
          const row = live.find((r) => r.id === id);
          if (row) row.unread = unread;
        }
      },
      onHoldRow: (id: string | null) => { heldLog.push(id); },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

async function mount(rows: Row[]): Promise<void> {
  live = rows.map((r) => ({ ...r }));
  sel = null;
  await draw();
}

function rowEl(id: string): HTMLElement {
  const el = host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}

function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".row[data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

/** The read-state slot of the open message's action bar — "Mark read" or "Mark unread". */
function verb(): string {
  const b = host!.querySelector(".abar-read-g button.abar-read");
  if (!b) throw new Error("no read-state verb on screen — is a message open in the column?");
  return b.textContent ?? "";
}

/** A frame passes: the rule looks at what is on screen. */
async function frame(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  await draw();
}

async function click(id: string): Promise<void> {
  await act(async () => { rowEl(id).click(); });
  await draw();
  await frame();
}

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await draw();
  await frame();
}

async function settle(ms = AFTER_SLIDE_MS): Promise<void> {
  await draw();
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await draw();
}

let layout: ThreadLayout;
beforeEach(() => {
  vi.useFakeTimers();
  layout = stubThreadLayout();
  setViewport();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null; sel = null; live = [];
  marked.length = 0; heldLog.length = 0;
  layout.restore();
  vi.useRealTimers();
});

const two = (): Row[] => [{ id: "a", unread: true, date: "2026-08-02T09:01:00.000Z" }, { id: "b", unread: true, date: "2026-08-02T09:00:00.000Z" }];

describe("the selection taken away from outside is a departure", () => {
  // The URL carries the open message, so Back on `#/ohbox/m/A` clears the SHELL's selection while
  // this view stays mounted — a way of leaving that none of the in-view departures can see.
  it("Back from a preview within the rest: nothing is ever written for A", async () => {
    await mount(two());
    await press("j");          // a preview of "a"
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    sel = null;
    await draw();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(marked, "a preview left before the rest is not reading").toEqual([]);
  });

  it("Back from a preview rested on: its read stands, Back writes nothing more", async () => {
    await mount(two());
    await press("j");
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    sel = null;
    await draw();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
  });

  it("an open saves the read; Back after it writes nothing more", async () => {
    await mount(two());
    await click("a");
    await layout.passDwell(); // its top on screen for the dwell
    await draw();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    sel = null;
    await draw();
    expect(marked, "Back is a departure: it releases the place and writes nothing").toEqual([
      { ids: ["a"], unread: false },
    ]);
  });
});

describe("the open message's read state is the account's", () => {
  it("open: the message on screen is read, the verb offers Mark unread, the row unbolds IN PLACE", async () => {
    await mount(two());
    await click("a");
    await layout.passDwell();
    await draw();
    expect(verb()).toContain("Mark unread");
    expect(verb()).not.toContain("Mark read");
    expect(rowEl("a").dataset.unseen, "the open message's row keeps unread ink").toBeUndefined();
    expect(rowEl("a").classList.contains("seen")).toBe(true);
    // …and IN PLACE: nothing moved yet, the read was written, and the count agrees with the row.
    expect(idsInGroup("New")).toEqual(["a", "b"]);
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(host!.textContent).toContain("1 unread");
  });

  it("a preview shows the message as it is: bold, the verb Mark read, nothing saved; rested on, it reads", async () => {
    await mount(two());
    await press("j");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await draw();
    expect(rowEl("a").dataset.unseen, "a preview is not a reading").toBe("1");
    expect(verb()).toContain("Mark read");
    expect(marked).toEqual([]);
    expect(host!.querySelector(".read-col [data-conv-id='a']")?.hasAttribute("data-unseen"), "the opened panel wears its unread state").toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await draw();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(rowEl("a").dataset.unseen).toBeUndefined();
    expect(verb()).toContain("Mark unread");
  });

  it("`u` on the read message re-bolds it in place, the verb offers Mark read again, and it is not read back", async () => {
    await mount(two());
    await click("a");
    await layout.passDwell();
    await draw();
    expect(rowEl("a").dataset.unseen).toBeUndefined();

    await press("u");
    expect(marked.at(-1)).toEqual({ ids: ["a"], unread: true });
    expect(rowEl("a").dataset.unseen).toBe("1");
    expect(verb()).toContain("Mark read");
    expect(idsInGroup("New")).toEqual(["a", "b"]);

    // …and the keep holds: nothing after `u` writes the message read again while it stays open.
    const afterU = marked.length;
    await settle();
    await layout.passDwell();
    await frame();
    expect(marked.slice(afterU).filter((m) => m.ids.includes("a") && !m.unread)).toEqual([]);
  });

  it("the open writes exactly one read, leaving adds none, and the row then slides to Earlier", async () => {
    await mount(two());
    await click("a");
    await layout.passDwell();
    await draw();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);

    await press("j");          // departure: a preview of b — the place is released, nothing is written
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    await settle();
    expect(idsInGroup("New")).toEqual(["b"]);
    expect(idsInGroup("Earlier")).toEqual(["a"]);
  });

  it("the entered row is reported upward for the engine's hold, and cleared on departure", async () => {
    /* The shell holds the row in New (`holdOpenRow`) from the enter, before anything is read, so
       every read of the conversation meanwhile is an open read. */
    await mount(two());
    await click("a");
    expect(heldLog.at(-1)).toBe("a");
    await press("u");
    expect(heldLog.at(-1)).toBeNull();

    await click("a");          // open again
    expect(heldLog.at(-1)).toBe("a");
    await press("j");          // a preview of b is the departure; the hold ends
    expect(heldLog.at(-1)).toBeNull();
  });
});
