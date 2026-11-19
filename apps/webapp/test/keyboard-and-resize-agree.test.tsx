/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/react";
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
    /* The new shell's frame reads the window's width and hears its resize, as a browser moves both. */
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
    window.dispatchEvent(new Event("resize"));
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
  /* A letter as the mirror hands it whole: its labels and Cc stand (empty), as the reader reads them. */
  to: [], cc: [], labels: [], date: `2026-09-03T0${9 - Number(id.slice(1))}:00:00.000Z`, unread: true,
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

/* The Ohbox's rows by role, each named by its letter's subject ("Subject m1"). */
const idOf = (el: Element): string => /Subject (m\d)/.exec(el.getAttribute("aria-label") ?? "")?.[1] ?? "";
const options = (el: ParentNode = document): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[role="option"]')];
const rowIds = (_el: HTMLElement): string[] => options().map(idOf).filter((id) => id !== "");

async function shell(): Promise<HTMLElement> {
  const { MailShell: AppShell } = await import("./_mail-shell.js");
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

/* The open letter by role and name: the frame's reading region ("Open message"), its heading the letter's subject.
   At one column it stands over the list (today's sheet); beside the list at two (today's column). */
const readingRegion = (): HTMLElement | null => document.querySelector<HTMLElement>(`[role="region"][aria-label="${messages.reader.pane}"]`);
const subjectIn = (region: HTMLElement | null): string | null => {
  const heading = [...(region?.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"]') ?? [])]
    .map((n) => /^Subject (m\d)$/.exec(n.textContent?.trim() ?? "")?.[1]).find((id) => id !== undefined);
  return heading ?? null;
};
const sheet = (_el: HTMLElement): Element | null => (width <= 699.98 ? readingRegion() : null);
/** The row the list marks as the one the keys are on. */
const selRow = (_el: HTMLElement): string | null => {
  const marked = options().filter((o) => o.getAttribute("aria-selected") === "true");
  return marked.length === 1 ? idOf(marked[0]!) : null;
};
const focusedRow = (): string | null => {
  const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role="option"]');
  return row ? idOf(row) : null;
};
/** The subject the reading column shows, or null when it rests. */
const columnSubject = (_el: HTMLElement): string | null => (width > 699.98 ? subjectIn(readingRegion()) : null);
const earlierIds = (_el: HTMLElement): string[] => {
  const group = document.querySelector<HTMLElement>(`[role="listbox"][aria-label="Earlier"]`);
  return group ? options(group).map(idOf) : [];
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

/** A key typed wherever focus is, including inside the open help. */
async function typed(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle(60);
}

const sheetUp = () => screen.queryByRole("dialog", { name: messages.shortcuts.title }) !== null;

describe("the ? sheet closes when a key does its job behind it", () => {
  it("? then j: the cursor moves and the sheet closes", async () => {
    await setWidth(1880);
    const container = await shell();
    const list = container.querySelector<HTMLElement>(".ob-scroll")!;
    await act(async () => { list.focus(); });
    expect(document.activeElement).toBe(list);
    expect(selRow(container)).toBeNull();
    await typed("?", { shiftKey: true });
    expect(sheetUp(), "? opened no sheet").toBe(true);

    // Keyboard help consumes its dismissing key. The next key works in the returned list.
    await typed("j");
    expect(sheetUp(), "j did not dismiss keyboard help").toBe(false);
    expect(document.activeElement).toBe(list);
    expect(selRow(container), "dismissing help moved the cursor").toBeNull();
    await typed("j");
    expect(selRow(container), "the first j back in the list moves once").toBe("m1");
  });

  it("control: ? still opens it, and ? then / closes it", async () => {
    await setWidth(1880);
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
  /* ← lands on the rail's first button now (the zone model is the keys task's), so News is reached as a person reaches
     a rail row from the keyboard: focused on the rail, then ↵. What follows is the case as it was. */
  it("rail ↵ to News, 1, j, ↵: the letter opens and the Ohbox stays", async () => {
    await setWidth(1880);
    const container = await shell();
    await key("ArrowLeft");
    expect(inRail(), "← put no focus in the rail").toBe(true);
    await act(async () => { railButton("News").focus(); });
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
    await act(async () => { railButton("News").focus(); });
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
