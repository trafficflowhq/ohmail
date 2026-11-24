/** @vitest-environment jsdom */
/** The reading sheet claims modality at phone width. At desktop width the rail
 * remains usable beside an open Ohbox or Search letter. */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
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

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Set before `shell()`: max-width queries answer true — the narrow layout. */
let narrow = false;
/** The new frame plans its columns by the window's width (a phone's 390 is one column), not by a media query. */
const WIDE = { w: window.innerWidth, h: window.innerHeight };
function sized(w: number, hgt: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: hgt });
}

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: narrow && /max-width/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
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
  narrow = false;
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
  sized(WIDE.w, WIDE.h);
});

const address = (id: string): string => `p${id}@example.invalid`;

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  /* A whole row, as the mirror hands one: its labels and its Cc are lists (FOR-S3-TO-S8 point 63 (c)). */
  to: [], cc: [], labels: [], date: "2026-09-03T09:00:00.000Z", unread: false,
  updatedAt: "2026-09-03T09:00:00.000Z",
} as unknown as EngineMessage);

/** Consented Ohbox rows plus History's own (read, dormant, rule-less) rows. */
async function storeWith(ids: string[], history: string[]): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const id of history) {
    const m = { ...msg(id), unread: false, date: "2024-01-05T09:00:00.000Z" } as EngineMessage;
    await store.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
    ] as SyncChange[]);
  }
  for (const id of ids) {
    const m = msg(id);
    await store.applyChanges([
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
  return store;
}

function engineOver(store: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m: EngineMutation) => {
        const changes = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type,
            op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-04T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

async function shell(): Promise<HTMLElement> {
  const { MailShell: AppShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const engine = engineOver(await storeWith(["m1", "m2"], ["h1", "h2"]));
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
            mailboxFacts: async () => ROSTER,
          } as never),
        }),
      }),
    }));
  });
  await waitFor(() => rowIds(container).length > 0, "rows in the Ohbox");
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
};

const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll("[role=option][data-id]")].map((r) => r.getAttribute("data-id") ?? "");

/** The open letter's surface: the frame's reading column (its region), or the dialog that holds it. */
const readingSurface = (): HTMLElement | null => {
  const region = document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
  if (region === null) return null;
  return region.closest<HTMLElement>("[role=dialog]") ?? region.querySelector<HTMLElement>("[role=dialog]") ?? region;
};

/** At desktop width the registered Search place reads its routed letter beside the results. */
async function openSearchLetter(): Promise<HTMLElement> {
  window.location.hash = "#/search/m/h1";
  await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
  await waitFor(() => readingSurface()?.textContent?.includes("Subject h1") === true, "the Search letter to open");
  return readingSurface()!;
}

describe("the reader's modal claim, by width", () => {
  it("narrow: the full-screen sheet claims aria-modal", async () => {
    narrow = true;
    sized(390, 844);
    const container = await shell();
    await key("j");
    await key("Enter");
    await waitFor(() => readingSurface()?.textContent?.includes("Subject m") === true, "the reading sheet to open");
    expect(readingSurface()!.getAttribute("aria-modal")).toBe("true");
    void container;
  });

  it("desktop: the letter opens beside Search without claiming modality", async () => {
    const container = await shell();
    const reader = await openSearchLetter();
    expect(within(container).getByRole("textbox", { name: messages.search.aria })).toBeTruthy();
    expect(reader.getAttribute("role")).toBe("region");
    expect(reader.getAttribute("aria-modal")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("desktop: the Ohbox open renders the pane, never the sheet — the trigger is the view", async () => {
    const container = await shell();
    await key("j");
    await key("Enter");
    await settle();
    /* No sheet: nothing over the list claims to be a dialog. */
    expect(document.querySelector("[role=dialog]")).toBeNull();
    // The message is on screen in the reading column, not gone with the sheet.
    expect(container.querySelector('[role="region"][aria-label="Open message"]')?.textContent ?? "").toContain("Subject m");
  });

  it("desktop: a rail press while reading in Search lands and closes the letter", async () => {
    const container = await shell();
    await openSearchLetter();
    const rail = within(container).getByRole("navigation", { name: "Places" });
    await act(async () => { within(rail).getByRole("button", { name: /^Ohbox/ }).click(); });
    await waitFor(() => rowIds(container).includes("m1"), "the Ohbox rows to be back on screen");
    expect(readingSurface(), "the Search letter closed on navigation").toBeNull();
  });
});
