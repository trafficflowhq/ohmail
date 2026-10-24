/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout";

/**
 * ═══ THE OPEN LETTER, THE LIST CURSOR AND THE LIST ARE ONE STATE ACROSS A RESIZE ════════════
 *
 * Read the top New letter at a wide window, narrow to 390 (the crossing raises the sheet), close
 * it with Escape — at that width closing is leaving, so the letter files under Earlier — and widen
 * again. The column, the cursor and the focus box all stay on the letter read, now under Earlier,
 * and the keys walk on from its place there. The window is moved the way a browser moves it:
 * every media query answers the new width and hears its change.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
let layout: ThreadLayout | null = null;

/* ── a window whose width the test moves: every query answers the width and hears its change ── */
let width = 1440;
type Mql = { media: string; matches: boolean; listeners: Set<(e: { matches: boolean }) => void> };
let mqls: Mql[] = [];
const answers = (q: string): boolean => {
  const max = /max-width:\s*([\d.]+)px/.exec(q), min = /min-width:\s*([\d.]+)px/.exec(q);
  if (!max && !min) return false;
  return (!max || width <= parseFloat(max[1]!)) && (!min || width >= parseFloat(min[1]!));
};
async function setWidth(w: number): Promise<void> {
  width = w;
  await act(async () => {
    for (const m of mqls) {
      const now = answers(m.media);
      if (now === m.matches) continue;
      m.matches = now;
      for (const l of [...m.listeners]) l({ matches: now });
    }
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

beforeEach(() => {
  window.location.hash = "";
  width = 1440;
  mqls = [];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const m: Mql = { media: query, matches: answers(query), listeners: new Set() };
      mqls.push(m);
      return {
        get matches() { return m.matches; },
        media: query,
        addEventListener: (_: string, l: (e: { matches: boolean }) => void) => { m.listeners.add(l); },
        removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => { m.listeners.delete(l); },
        addListener: (l: (e: { matches: boolean }) => void) => { m.listeners.add(l); },
        removeListener: (l: (e: { matches: boolean }) => void) => { m.listeners.delete(l); },
        onchange: null,
        dispatchEvent: () => false,
      };
    },
  });
  // jsdom gaps, stubbed at their narrowest — see `delete-key-shell.test.tsx`.
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
  /* The reader laid out, so an opened letter is read through the thread-read rule as in production;
     the reading column is display:none below 700px, where the sheet reads instead. */
  layout = stubThreadLayout({ columnHidden: () => width <= 699.98 });
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  layout?.restore();
  layout = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ── the account this shell is mounted over (the shape `delete-key-shell.test.tsx` uses) ───── */

const address = (id: string): string => `p${id}@example.invalid`;

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  to: [], date: `2026-09-03T0${9 - Number(id.slice(1))}:00:00.000Z`, unread: true,
  updatedAt: "2026-09-03T09:00:00.000Z",
} as unknown as EngineMessage);

/** A mirror holding `ids`, each from a CONSENTED sender — without the rule the pile is empty. */
async function storeWith(ids: string[]): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  for (const id of ids) {
    const m = msg(id);
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

/** A consent wire that says the folders foundation is on — the flag Delete is gated behind. */
const consentTransport = {
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z",
    screeningResetAt: null,
    dormancyDays: 90,
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

const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")].map((r) => r.dataset.id ?? "");

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const engine = engineOver(await storeWith(["m1", "m2", "m3", "m4"]));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        children: h(ToastHost, {
          children: h(AppShell as never, {
            demo: false,
            engine,
            consentTransport,
            mailboxFacts: async () => ORGANIZER_ROSTER,
          } as never),
        }),
      }),
    }));
  });
  await waitFor(() => rowIds(container).length > 0, "rows in the Ohbox");
  return container;
}

/** A keypress on the DOCUMENT, where the registry listens. */
const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

/** ↵ as a browser delivers it: at the focused element, then a focused button's own activation. */
async function enter(): Promise<void> {
  await act(async () => {
    const at = (document.activeElement as HTMLElement | null) ?? document.body;
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    at.dispatchEvent(ev);
    if (!ev.defaultPrevented && at instanceof HTMLButtonElement) at.click();
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

const sheet = (el: HTMLElement): Element | null => el.querySelector(".reader");
const selRow = (el: HTMLElement): string | null =>
  el.querySelector<HTMLElement>(".view-ohbox .row.sel[data-id]")?.dataset.id ?? null;
const focusedRow = (): string | null =>
  (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".row[data-id]")?.dataset.id ?? null;
/** The subject the reading column shows, or null when it rests. */
const columnSubject = (el: HTMLElement): string | null => {
  const col = el.querySelector(".view-ohbox .read-col");
  const m = /Subject (m\d)/.exec(col?.textContent ?? "");
  return m ? m[1]! : null;
};
const earlierIds = (el: HTMLElement): string[] => {
  const rows = [...el.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")];
  const line = [...el.querySelectorAll<HTMLElement>(".view-ohbox *")]
    .find((n) => n.children.length === 0 && n.textContent?.trim() === "Earlier");
  if (!line) return [];
  return rows
    .filter((r) => (line.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    .map((r) => r.dataset.id ?? "");
};
const settle = async (ms = 400): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
};

describe("a resize keeps the open letter, the cursor and the list one state", () => {
  it("read at 1880, narrowed to 390, closed, widened: the column, the cursor and k stay with the row read", async () => {
    await setWidth(1880);
    const container = await shell();
    expect(rowIds(container).slice(0, 4), "newest first").toEqual(["m1", "m2", "m3", "m4"]);
    await key("j");
    await enter();
    await layout!.passDwell(); // its top on screen for the dwell: read
    expect(columnSubject(container), "the read letter stands in the column").toBe("m1");
    await setWidth(390);
    await waitFor(() => sheet(container) !== null, "the crossing raising the sheet");
    await key("Escape");
    await waitFor(() => sheet(container) === null, "Escape closing the sheet");
    await waitFor(() => earlierIds(container).includes("m1"), "the letter filing under Earlier");
    await settle();
    await setWidth(1880);
    await settle();
    expect(earlierIds(container), "the read letter is not under Earlier").toEqual(["m1"]);
    expect(selRow(container), "the cursor left the row read").toBe("m1");
    expect(focusedRow(), "the focus box left the row read").toBe("m1");
    expect(columnSubject(container), "the column and the list cursor name two letters").toBe("m1");
    await key("k");
    await settle(100);
    expect(selRow(container), "k from the read letter did not walk back into New").toBe("m4");
  }, 20_000);

  it("control: a resize with nothing open opens nothing, and j enters at the top of New", async () => {
    await setWidth(1880);
    const container = await shell();
    await setWidth(390);
    await settle();
    expect(sheet(container), "a sheet rose over a list with nothing open").toBeNull();
    await setWidth(1880);
    await settle();
    expect(columnSubject(container), "the column opened a letter nobody chose").toBeNull();
    expect(selRow(container), "a cursor appeared from a resize").toBeNull();
    await key("j");
    expect(selRow(container), "j did not enter at the top").toBe("m1");
  }, 20_000);

  it("control: j and k walk New into Earlier and back with no resize", async () => {
    await setWidth(1880);
    const container = await shell();
    await key("j");
    await enter();
    await layout!.passDwell(); // its top on screen for the dwell: read
    await key("j");
    await waitFor(() => earlierIds(container).includes("m1"), "the read letter filing under Earlier once left");
    await settle();
    expect(selRow(container), "j from the read letter did not reach the next in New").toBe("m2");
    await key("j");
    await key("j");
    expect(selRow(container), "j did not reach the last letter in New").toBe("m4");
    await key("j");
    expect(selRow(container), "j did not cross into Earlier after New").toBe("m1");
    await key("k");
    expect(selRow(container), "k did not walk back into New").toBe("m4");
  }, 20_000);
});

/**
 * A BROWSER RUNS MICROTASKS BETWEEN TWO LISTENERS of a key the person typed, so React commits the
 * first listener's update — and runs its effects — before the second listener is called. jsdom
 * dispatches from script and never does; this wraps every `document` keydown listener so pending
 * sync work flushes after each, as it does in the browser. Removal is mapped through the wrap.
 */
function checkpointBetweenListeners(): () => void {
  const add = document.addEventListener;
  const remove = document.removeEventListener;
  const wraps = new WeakMap<EventListener, EventListener>();
  const wrap = (l: EventListener): EventListener => {
    let w = wraps.get(l);
    if (!w) {
      w = function (this: unknown, e: Event) {
        try { l.call(this, e); } finally { flushSync(() => {}); }
      };
      wraps.set(l, w);
    }
    return w;
  };
  document.addEventListener = function (this: Document, type: string, l: unknown, o?: unknown) {
    const real = type === "keydown" && typeof l === "function" ? wrap(l as EventListener) : l;
    return add.call(this, type, real as EventListener, o as AddEventListenerOptions);
  } as typeof document.addEventListener;
  document.removeEventListener = function (this: Document, type: string, l: unknown, o?: unknown) {
    const real = typeof l === "function" ? (wraps.get(l as EventListener) ?? l) : l;
    return remove.call(this, type, real as EventListener, o as EventListenerOptions);
  } as typeof document.removeEventListener;
  return () => { document.addEventListener = add; document.removeEventListener = remove; };
}

/** A key as the person types it: dispatched outside `act`, so React schedules as a browser would. */
async function typed(k: string, init: KeyboardEventInit = {}): Promise<void> {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  await settle(60);
}

const sheetUp = (): boolean => document.querySelector(".ks") !== null;

describe("the ? sheet closes when a key does its job behind it", () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  it("? then j: the cursor moves and the sheet closes", async () => {
    await setWidth(1880);
    restore = checkpointBetweenListeners();
    const container = await shell();
    await typed("?", { shiftKey: true });
    expect(sheetUp(), "? opened no sheet").toBe(true);
    await typed("j");
    expect(selRow(container), "j behind the sheet moved no cursor").toBe("m1");
    expect(sheetUp(), "the sheet stayed open over the list j just moved").toBe(false);
  });

  it("control: ? still opens it, and ? then / closes it", async () => {
    await setWidth(1880);
    restore = checkpointBetweenListeners();
    await shell();
    await typed("?", { shiftKey: true });
    expect(sheetUp(), "? opened no sheet").toBe(true);
    await typed("/");
    expect(sheetUp(), "/ left the sheet open").toBe(false);
  });
});

const inRail = (): boolean => (document.activeElement as HTMLElement | null)?.closest(".rail") != null;
const railButton = (label: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll<HTMLButtonElement>(".rail button")]
    .find((el) => el.textContent?.trim().startsWith(label));
  if (!b) throw new Error(`no rail button ${label}`);
  return b;
};

describe("Enter opens what the list cursor is on after a digit go-to", () => {
  it("← ↓ ↵ to News, 1, j, ↵: the letter opens and the Ohbox stays", async () => {
    await setWidth(1880);
    const container = await shell();
    await key("ArrowLeft");
    expect(inRail(), "← put no focus in the rail").toBe(true);
    await key("ArrowDown");
    await enter();
    await waitFor(() => container.querySelector(".view-ohbox") === null, "News opening");
    expect(inRail(), "the pressed rail row keeps focus").toBe(true);
    await key("1");
    await waitFor(() => container.querySelector(".view-ohbox") !== null, "1 going to the Ohbox");
    await key("j");
    expect(selRow(container), "j placed no cursor").toBe("m1");
    await enter();
    expect(container.querySelector(".view-ohbox"), "↵ opened the rail's section, not the letter").not.toBeNull();
    expect(columnSubject(container), "↵ did not open the letter under the cursor").toBe("m1");
  });

  it("the same through g o", async () => {
    await setWidth(1880);
    const container = await shell();
    await key("ArrowLeft");
    await key("ArrowDown");
    await enter();
    await waitFor(() => container.querySelector(".view-ohbox") === null, "News opening");
    await key("g");
    await key("o");
    await waitFor(() => container.querySelector(".view-ohbox") !== null, "g o going to the Ohbox");
    expect(inRail(), "after g o the focus ring still stands on the rail").toBe(false);
  });

  it("control: a rail row focused by Tab still opens its section on ↵", async () => {
    await setWidth(1880);
    const container = await shell();
    await act(async () => { railButton("News").focus(); });
    expect(inRail(), "the rail row took no focus").toBe(true);
    await enter();
    await waitFor(() => container.querySelector(".view-ohbox") === null, "↵ on the focused rail row opening News");
  });
});
