/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  mutationEffects,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { useKeyBindings, type KeyBinding } from "@ohmail/app-logic/keys/keymap";
import { KEY_PEEK, pageModal } from "@ohmail/app-logic/session/modal-gate";
import { revealInScroller } from "@ohmail/app-logic/lists/list-window";
import { writeReplyDraft } from "@ohmail/app-logic/writing/mail-send";
import { stubThreadLayout } from "./fixtures/thread-layout";
import { parseRichValue } from "@ohmail/app-logic/writing/rich-text";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { cursorRow as seatedCursorRow, ohboxRow, ohboxRows } from "./ohbox/_finders";
import { mountSetupOverPlace, SETUP } from "./_ohbox-1-first-run";
import { cleanup, screen } from "@testing-library/react";

/**
 * ═══ THE KEYS REACH WHAT IS IN FRONT ═══════════════════════════════════════════════════════════
 *
 * R32-02: `j` walked the Ohbox cursor below the list for every row the window had mounted past the
 * fold (scrollTop 0 throughout) while the reader opened each one. Measured through the shell with
 * a laid-out list: rows 85px apart under a 681px scroller, the tester's 1440x900 geometry.
 *
 * R32-06: setup's dialog stood over the Ohbox, a step took its own button away, focus fell to the
 * page root, and ↵ there opened — and read — the letter behind it. The keymap asked where focus
 * was; it now asks whether a page modal stands, and the shell's focus rule lands inside one.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Every mutation the shell put on the wire, in order. */
const wire: EngineMutation[] = [];

/* ── layout, as a browser would answer it for the Ohbox list ──────────────────────────────── */
const LIST_TOP = 165;
const LIST_H = 681;
const ROW_H = 85;
const scrollTops = new WeakMap<Element, number>();
const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
function stub(target: object, prop: string, desc: PropertyDescriptor): void {
  saved.push([target, prop, Object.getOwnPropertyDescriptor(target, prop)]);
  Object.defineProperty(target, prop, { configurable: true, ...desc });
}
/* The seated Ohbox's list scroller: the box that holds its rows in the frame's list section (found by the box, as
   `ohbox/_finders.ts` finds the reading sheet's scrolling box, until the kit hands it out). */
const LIST_SCROLLER = 'section[aria-label="Messages"] .ob-scroll';
const isList = (el: Element): boolean => el.matches(LIST_SCROLLER);
function layOut(): void {
  stub(window, "innerHeight", { value: 900 });
  stub(HTMLElement.prototype, "scrollTop", {
    get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
    set(this: HTMLElement, v: number) { scrollTops.set(this, Math.max(0, v)); },
  });
  stub(HTMLElement.prototype, "clientHeight", {
    get(this: HTMLElement) { return isList(this) ? LIST_H : 0; },
  });
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  stub(Element.prototype, "getBoundingClientRect", {
    value(this: Element) {
      if (isList(this)) return rect(LIST_TOP, LIST_H);
      const list = this.closest(LIST_SCROLLER);
      if (list && this.matches("[role=option][data-id]")) {
        const at = [...list.querySelectorAll("[role=option][data-id]")].indexOf(this);
        return rect(LIST_TOP + at * ROW_H - list.scrollTop, ROW_H);
      }
      return rect(0, 0);
    },
  });
}

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const max = /max-width:\s*([\d.]+)px/.exec(query), min = /min-width:\s*([\d.]+)px/.exec(query);
      const matches = (max !== null || min !== null)
        && (!max || 1440 <= parseFloat(max[1]!)) && (!min || 1440 >= parseFloat(min[1]!));
      return {
        matches, media: query, onchange: null, dispatchEvent: () => false,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      };
    },
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  seq = 0;
  wire.length = 0;
});

afterEach(async () => {
  cleanup();
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  window.localStorage.clear();
  for (const [target, prop, desc] of saved.splice(0).reverse()) {
    if (desc) Object.defineProperty(target, prop, desc);
    else delete (target as Record<string, unknown>)[prop];
  }
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/* ── the account the shell is mounted over (the shape `keyboard-and-resize-agree` uses) ───── */
const address = (id: string): string => `p${id}@example.invalid`;
const msg = (id: string, n: number): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  to: [], date: new Date(Date.UTC(2026, 8, 3, 9, 0) - n * 60_000).toISOString(), unread: true,
  updatedAt: "2026-09-03T09:00:00.000Z",
  /* Made whole for the new reader, which reads a letter's tags and copies (today's read past their absence). */
  cc: [], labels: [], snippet: `the words of ${id}`, hasAttachments: false, attachmentCount: 0,
} as unknown as EngineMessage);

async function storeWith(ids: string[]): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  for (const [n, id] of ids.entries()) {
    const m = msg(id, n);
    await s.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
      {
        type: "rule", op: "create", id: `r-${id}`, seq: ++seq, updatedAt: m.updatedAt,
        entity: {
          id: `r-${id}`, kind: "sender", match: address(id),
          destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z",
        },
      },
    ] as SyncChange[]);
  }
  return s;
}

function engineOver(s: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: s.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m: EngineMutation) => {
        wire.push(m);
        const changes = mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type,
            op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        await s.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

const consentTransport = {
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
    foldersEnabledAt: "2026-09-01T00:00:00.000Z",
  }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

const ORGANIZER_ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-04T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

const IDS = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
const rowIds = (el: HTMLElement): string[] => ohboxRows(el).map((r) => r.dataset.id ?? "");

let engineNow: OhmailEngine | null = null;
async function shell(): Promise<HTMLElement> {
  const { MailShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const engine = engineOver(await storeWith(IDS));
  engineNow = engine;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        children: h(ToastHost, {
          children: h(MailShell as never, {
            demo: false, engine, consentTransport, mailboxFacts: async () => ORGANIZER_ROSTER,
          } as never),
        }),
      }),
    }));
  });
  await waitFor(() => rowIds(container).length === IDS.length, "every row in the Ohbox");
  return container;
}

/** A keypress where the browser sends it: at the focused element, or the page root. */
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    const at = (document.activeElement as HTMLElement | null) ?? document.body;
    at.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

/** A keypress delivered at the page root whatever holds focus — the R32-06 shape. */
const keyAtRoot = async (k: string): Promise<void> => {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

/** The row's unread mark: `data-unread` on the seated row (today's row said it as `data-unseen`). */
const unseen = (el: HTMLElement, id: string): boolean => ohboxRow(el, id)?.hasAttribute("data-unread") === true;
const list = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(LIST_SCROLLER)!;
const cursorRow = (el: HTMLElement): HTMLElement | null => seatedCursorRow(el);
/** Where the cursor row stands against the list's visible box. */
function cursorPlace(el: HTMLElement): { id: string | null; top: number; bottom: number; scrollTop: number; onScreen: boolean } {
  const row = cursorRow(el);
  const r = row?.getBoundingClientRect();
  const top = r?.top ?? NaN, bottom = r?.bottom ?? NaN;
  return {
    id: row?.dataset.id ?? null, top, bottom, scrollTop: list(el).scrollTop,
    onScreen: top >= LIST_TOP && bottom <= LIST_TOP + LIST_H,
  };
}

describe("R32-02: every j and k leaves the cursor row wholly on screen, moving the list as little as it can", () => {
  it("j through twelve rows under a 681px list, then k back to the top", async () => {
    layOut();
    const el = await shell();
    const seen: string[] = [];
    for (let i = 1; i <= IDS.length; i++) {
      await key("j");
      const p = cursorPlace(el);
      seen.push(`j${i} ${p.id} ${p.top}-${p.bottom} scroll ${p.scrollTop}`);
      expect(p.id, `j${i} did not move the cursor`).toBe(IDS[i - 1]);
      expect(p.onScreen, `j${i} left the cursor row off screen:\n${seen.join("\n")}`).toBe(true);
      /* MINIMAL: no scroll while the row already stood on screen, and then exactly the overflow. */
      const overflow = Math.max(0, LIST_TOP + i * ROW_H - (LIST_TOP + LIST_H));
      expect(p.scrollTop, `j${i} moved the list by more than the row needed`).toBe(overflow);
    }
    const bottomScroll = list(el).scrollTop;
    for (let i = IDS.length - 1; i >= 1; i--) {
      await key("k");
      const p = cursorPlace(el);
      expect(p.id).toBe(IDS[i - 1]);
      expect(p.onScreen, `k back to ${p.id} left it off screen`).toBe(true);
      expect(p.scrollTop, `k to ${p.id} moved the list past the row`).toBe(Math.min(bottomScroll, (i - 1) * ROW_H));
    }
  });

  it("ArrowDown is the same walk, and keeps the cursor on screen too", async () => {
    layOut();
    const el = await shell();
    for (let i = 1; i <= IDS.length; i++) {
      await key("ArrowDown");
      expect(cursorPlace(el).onScreen, `↓${i} left the cursor row off screen`).toBe(true);
    }
    expect(cursorPlace(el).id).toBe(IDS[IDS.length - 1]);
  });
});

describe("revealInScroller — the arithmetic, on its own", () => {
  const box = (top: number, height: number) => ({ getBoundingClientRect: () => ({ top, bottom: top + height, height }) });
  function scroller(childBoxes: Array<{ top: number; height: number; sticky?: boolean }>) {
    const kids = childBoxes.map((c) => {
      const node = document.createElement("div");
      if (c.sticky) node.style.position = "sticky";
      Object.assign(node, box(c.top, c.height));
      return node;
    });
    const s = document.createElement("div");
    kids.forEach((k) => s.appendChild(k));
    let st = 400;
    Object.defineProperty(s, "scrollTop", { get: () => st, set: (v: number) => { st = v; }, configurable: true });
    Object.defineProperty(s, "clientHeight", { get: () => 300 });
    Object.assign(s, box(100, 300));
    document.body.appendChild(s);
    return { s, kids, st: () => st };
  }
  it("a row below the fold scrolls by exactly its overflow; one above, by exactly its underflow", () => {
    const below = scroller([{ top: 380, height: 40 }]);
    revealInScroller(below.s, below.kids[0]!);
    expect(below.st()).toBe(420);
    const above = scroller([{ top: 80, height: 40 }]);
    revealInScroller(above.s, above.kids[0]!);
    expect(above.st()).toBe(380);
  });
  it("a row already on screen moves nothing (the control)", () => {
    const on = scroller([{ top: 150, height: 40 }]);
    revealInScroller(on.s, on.kids[0]!);
    expect(on.st()).toBe(400);
  });
  it("a row under a sticky notice pinned at the top comes out from under it", () => {
    const under = scroller([{ top: 100, height: 50, sticky: true }, { top: 120, height: 40 }]);
    revealInScroller(under.s, under.kids[1]!);
    expect(under.st()).toBe(370);
  });
  it("a short viewport: a row inside the list but past the window scrolls the page by its overflow, not the list", () => {
    const pageTops = new WeakMap<Element, number>();
    stub(HTMLElement.prototype, "scrollTop", {
      get(this: HTMLElement) { return pageTops.get(this) ?? 0; },
      set(this: HTMLElement, v: number) { pageTops.set(this, v); },
    });
    stub(document, "scrollingElement", { value: document.documentElement });
    stub(window, "innerHeight", { value: 350 });
    const past = scroller([{ top: 330, height: 40 }]);
    revealInScroller(past.s, past.kids[0]!);
    expect(past.s.scrollTop, "the list moved for a row it already shows").toBe(400);
    expect(document.documentElement.scrollTop, "the page did not bring the row inside the window").toBe(20);
  });
  it("a row taller than the list shows its top", () => {
    const tall = scroller([{ top: 250, height: 500 }]);
    revealInScroller(tall.s, tall.kids[0]!);
    expect(tall.st()).toBe(550);
  });
});

/* ══ R32-06 ══════════════════════════════════════════════════════════════════════════════════
   RE-POINTED (share ohbox-1): today's `FirstRun` dialog under today's key provider gave way to THE FIRST RUN AS THE
   NEW FRAME's STAGE (`_ohbox-1-first-run.tsx`: the frame's own key registry and focus rule, the stage the first run
   hands it, a mailbox another install organizes), over the same list behind it: ↵ opens the row under the cursor,
   `j` moves it, a global letter and a binding that answers a modal beside them. The stage is a page modal
   (`role="dialog"`, `aria-modal`), found by role; its words are the first run's own catalogue's, the same sentences. */

const ob = SETUP;

/** The list behind the dialog: ↵ opens the row under the cursor, `j` moves it — the Ohbox's own shape. */
function Behind({ opened, moved }: { opened: () => void; moved: () => void }) {
  const keys: KeyBinding[] = [
    { chord: "Enter", group: "message", label: "Open", when: (e) => (e.target as HTMLElement).tagName !== "BUTTON", run: opened },
    { chord: "j", group: "navigate", label: "Next", run: moved },
  ];
  useKeyBindings(keys, "view");
  return h("button", { type: "button", className: "opener" }, "Set up ›");
}

/** A global binding that answers the modal itself, and one that does not. */
function Globals({ answered, behind }: { answered: () => void; behind: () => void }) {
  useKeyBindings([
    { chord: "mod+Enter", group: "message", label: "Send", inInput: true, inModal: true, run: answered },
    { chord: "c", group: "app", label: "Compose", run: behind },
  ], "global");
  return null;
}

const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

async function setup(opts: { open?: boolean } = {}) {
  const counts = { opened: 0, moved: 0, answered: 0, behind: 0, completed: 0 };
  const el = document.body;
  const made = mountSetupOverPlace(() => [
    h(Behind, { key: "b", opened: () => { counts.opened += 1; }, moved: () => { counts.moved += 1; } }),
    h(Globals, { key: "g", answered: () => { counts.answered += 1; }, behind: () => { counts.behind += 1; } }),
  ], { open: opts.open ?? true });
  Object.defineProperty(counts, "completed", { get: made.completed, enumerable: true });
  /* Setup opened over the list, as its address opens it; it is never closed by a case here. */
  const render = async (open: boolean) => {
    if (open) await made.setupAt();
    await flush();
  };
  await flush();
  return { el, counts, render };
}

/** The same page with a plain page modal in front of it: `aria-modal`, and no modal gate taken. */
async function pageModalOnly() {
  const counts = { opened: 0, moved: 0, answered: 0, behind: 0 };
  const el = document.body;
  mountSetupOverPlace(() => [
    h(Behind, { key: "b", opened: () => { counts.opened += 1; }, moved: () => { counts.moved += 1; } }),
    h(Globals, { key: "g", answered: () => { counts.answered += 1; }, behind: () => { counts.behind += 1; } }),
    h("div", { key: "pm", role: "dialog", "aria-modal": "true" }, h("button", { type: "button" }, "OK")),
  ], { open: false });
  await flush();
  return { el, counts };
}

const button = (el: HTMLElement, label: string): HTMLButtonElement => {
  const b = [...el.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim().startsWith(label));
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
const heading = (el: HTMLElement): string => (el.querySelector("h1")?.textContent ?? "").trim();
/** Setup's dialog: the stage, a page modal, by its role. */
const card = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;

/** ↵ as a browser delivers it: keydown at the focused element, then a focused button's activation. */
async function enter(): Promise<void> {
  await act(async () => {
    const at = (document.activeElement as HTMLElement | null) ?? document.body;
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    at.dispatchEvent(ev);
    if (!ev.defaultPrevented && at instanceof HTMLButtonElement) at.click();
  });
  await flush();
}

describe("R32-06: while setup stands, no key reaches the list behind it", () => {
  it("setup opened from a button behind it takes focus", async () => {
    const s = await setup({ open: false });
    await act(async () => { button(s.el, "Set up").focus(); });
    await s.render(true);
    expect(card(s.el).contains(document.activeElement),
      `focus stayed on ${(document.activeElement as HTMLElement | null)?.textContent} behind the dialog`).toBe(true);
    await enter();
    expect(s.counts.opened, "↵ reached the list behind setup").toBe(0);
  });

  it("a step taken with focus fallen to the page root: focus returns inside, ↵ opens ohmail, the letter behind stays shut", async () => {
    const s = await setup();
    /* "Just read it here": the step's choice by its name (today's was a radio of value "read"). */
    const read = [...s.el.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim().startsWith(ob.elsewhereChoiceRead));
    await act(async () => { read!.click(); });
    /* The browser's half of a disabled or swapped button: focus leaves it for the page root, and
       the step changes after that, with no focused node removed for anybody to answer. */
    const go = button(s.el, ob.continue);
    await act(async () => { go.focus(); go.blur(); });
    expect(document.activeElement).toBe(document.body);
    await act(async () => { go.click(); });
    await flush();
    expect(heading(s.el), "Continue did not reach the summary").toBe(ob.doneReaderTitle);
    expect(card(s.el).contains(document.activeElement), "the step left focus on the page root").toBe(true);
    expect((document.activeElement as HTMLElement).textContent?.trim().startsWith(ob.doneOpen),
      "focus did not land on the ↵ control").toBe(true);
    await enter();
    expect(s.counts.opened, "↵ opened the letter behind setup").toBe(0);
    expect(s.counts.completed, "↵ on the summary did not open ohmail").toBe(1);
  });

  it("focus on the page root with the dialog up: ↵, j and a global letter reach nothing behind it", async () => {
    const s = await setup();
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    expect(document.activeElement).toBe(document.body);
    await key("Enter");
    await key("j");
    await key("c");
    expect(s.counts, "a key reached the mail behind the dialog").toMatchObject({ opened: 0, moved: 0, behind: 0 });
  });

  it("Tab at the page root with the dialog up lands inside the dialog, not on a control behind it", async () => {
    const s = await setup();
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    expect(document.activeElement).toBe(document.body);
    let tab: KeyboardEvent | null = null;
    await act(async () => {
      tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      document.body.dispatchEvent(tab);
    });
    expect(card(s.el).contains(document.activeElement), "Tab left focus outside the dialog").toBe(true);
    expect(tab!.defaultPrevented, "the browser's own Tab would walk on from the landing").toBe(true);
  });

  it("controls: setup's own Escape still asks to cancel, and its modal gate holds every binding", async () => {
    const s = await setup();
    await key("Escape");
    expect(s.el.textContent, "setup's Escape no longer asks to cancel").toContain(ob.cancelConfirm);
    /* Setup takes the modal gate (`first-run-stage.test.ts`), which is stricter than a page modal:
       a binding that answers a modal answers none of setup's, so it waits with the rest. */
    await key("Enter", { ctrlKey: true });
    expect(s.counts.answered, "a binding ran behind setup's modal gate").toBe(0);
  });

  it("control: under a page modal that takes no gate, a binding that answers the modal still runs", async () => {
    const s = await pageModalOnly();
    await key("Enter", { ctrlKey: true });
    expect(s.counts.answered, "an inModal binding was suspended with the rest").toBe(1);
    await key("c");
    expect(s.counts.behind, "a global letter reached the page behind the modal").toBe(0);
  });

  it("control: with no dialog, the same keys reach the list (the gate admits the ordinary case)", async () => {
    const s = await setup({ open: false });
    await key("Enter");
    await key("j");
    await key("c");
    expect(s.counts).toMatchObject({ opened: 1, moved: 1, behind: 1 });
  });
});

describe("pageModal — which surfaces own the page", () => {
  const add = (attrs: Record<string, string>, cls = ""): HTMLElement => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    for (const [k, v] of Object.entries(attrs)) d.setAttribute(k, v);
    document.body.appendChild(d);
    return d;
  };
  it("an aria-modal dialog does; the reading sheet, a peek, a hidden one and a popover do not", () => {
    expect(pageModal(document)).toBeNull();
    add({ role: "dialog", "aria-modal": "true" }, "reader");
    add({ role: "dialog", "aria-modal": "true", [KEY_PEEK]: "" });
    add({ role: "dialog", "aria-modal": "true", hidden: "" });
    add({ role: "dialog" });
    add({ role: "alertdialog" });
    expect(pageModal(document), "a surface that claims no page gated the keys").toBeNull();
    const modal = add({ role: "dialog", "aria-modal": "true" });
    expect(pageModal(document)).toBe(modal);
  });
});

describe("through the shell: a page modal over the Ohbox keeps ↵ and j from the list", () => {
  it("the palette open, keys at the page root: j moves no cursor and ↵ opens no letter", async () => {
    /* The reader laid out, so the ↵ that opens a letter reads it as production does: through the
       thread-read rule, which reads a letter once its top was on screen for the dwell. Without a
       layout ↵ would read nothing either way, and the check that ↵ behind the palette reads nothing
       could not fail. The dwell is passed by hand once it is under way, never waited out. */
    const layout = stubThreadLayout();
    try {
    const el = await shell();
    await key("j");
    const before = cursorRow(el)?.dataset.id ?? null;
    expect(before).toBe("m1");
    await key("k", { ctrlKey: true });
    const palette = () => screen.queryByRole("dialog", { name: "Command palette" });
    await waitFor(() => palette()?.getAttribute("aria-modal") === "true", "the palette");
    /* The keys arrive at the page root, where a step that took its own button away leaves them;
       the palette, a page modal, would otherwise take focus straight back. */
    await keyAtRoot("j");
    await keyAtRoot("Enter");
    expect(cursorRow(el)?.dataset.id ?? null, "j moved the cursor behind the palette").toBe(before);
    // m1 stands in the column, laid out: a ↵ that entered it would start its dwell in the next frame.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(layout.dwelling(), "↵ entered the letter behind the palette").toBe(false);
    await layout.passDwell();
    expect(unseen(el, "m1"), "↵ opened, and so read, the letter behind the palette").toBe(true);
    await key("k", { ctrlKey: true });
    await waitFor(() => palette() === null, "the palette's own toggle closing it");
    /* The control: the same two keys with nothing in front of the list. */
    await keyAtRoot("j");
    expect(cursorRow(el)?.dataset.id ?? null, "j stayed dead after the palette closed").toBe("m2");
    await keyAtRoot("Enter");
    await waitFor(() => layout.dwelling() || !unseen(el, "m2"), "↵ entering the letter: its top on screen, its dwell under way");
    await layout.passDwell();
    await waitFor(() => !unseen(el, "m2"), "↵ opening the letter under the cursor");
    } finally {
      layout.restore();
    }
  });

  it("the Reply Run is a page modal, and its own send key still sends from inside it", async () => {
    const el = await shell();
    await act(async () => {
      await engineNow!.mutate({ kind: "triage_set", messageId: "m3", state: "reply_later" } as EngineMutation);
    });
    await waitFor(() => !rowIds(el).includes("m3"), "m3 leaving the Ohbox for Answer Later");
    /* A reply already written for it, in the per-message buffer the run reads on open. */
    writeReplyDraft("m3", parseRichValue("Thursday works."), storageOwner());
    await act(async () => {
      window.location.hash = "#/triage";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByRole("button", { name: "Reply Run" });
    await key("f");
    await screen.findByRole("toolbar", { name: "Reply run" });
    const modal = pageModal(document);
    await key("Enter", { ctrlKey: true });
    await waitFor(() => wire.some((m) => m.kind === "mail_send"), "the run's ⌘↵ putting a send on the wire");
    const sent = wire.find((m) => m.kind === "mail_send") as unknown as { inReplyTo?: string };
    expect(sent.inReplyTo).toBe("m3");
    expect(modal, "the run does not own the page").not.toBeNull();
  });

  it("the shortcut sheet closes on j and the next j moves the cursor", async () => {
    const el = await shell();
    await key("?", { shiftKey: true });
    const sheet = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });
    await waitFor(() => sheet() !== null, "the sheet");
    const before = cursorRow(el);
    await key("j");
    expect(sheet()).toBeNull();
    expect(cursorRow(el)).toBe(before);
    await key("j");
    expect(cursorRow(el)?.dataset.id ?? null).toBe("m1");
  });
});
