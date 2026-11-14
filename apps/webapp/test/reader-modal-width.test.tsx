/** @vitest-environment jsdom */
/**
 * ═══ THE READER'S MODAL CLAIM IS BOUND TO NARROW WIDTHS ═══
 *
 * The 0.20.0 walk met both arms at one 1440×900 viewport and could not name the trigger:
 * the reader as an `aria-modal` dialog refusing rail presses in one run, the ordinary right
 * pane in the next. The trigger is the OPENING PATH, not chance: every list view gates its
 * row open on `readColumnHidden()` and renders its column at desktop width, but the
 * route↔message mirror's overlay arm (`#/<view>/m/<id>` on a view whose pile does not hold
 * the row — a located search hit, a deep link), a stream card's reply and an off-mirror hit
 * raise the SHEET at every width — by design, since those readings have no column to land
 * in. What was wrong is what the sheet CLAIMED there: `modal={!pushTier}` said `aria-modal`
 * at desktop width,
 * where the rail stands beside the sheet and (with app.css's rail rule) keeps its pointer
 * events. This file pins the width bound both ways plus the pane arm's trigger, and the
 * cross-navigation journey: a rail press with the sheet standing lands and closes the reader
 * through the route transition, instead of dying on the backdrop.
 *
 * The pointer-events half is CSS, which jsdom does not lay out — its deciding lines are
 * pinned structurally over the shipped stylesheet in `reader-rail-css` below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
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
});

const address = (id: string): string => `p${id}@example.invalid`;

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  to: [], date: "2026-09-03T09:00:00.000Z", unread: false,
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
  const { AppShell } = await import("../app/shell/AppShell.js");
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
  [...el.querySelectorAll(".row[data-id]")].map((r) => r.getAttribute("data-id") ?? "");

/** The modal arm's real trigger at desktop width: the route mirror's overlay arm — a URL
 *  naming a message on a view with no column to read it in (the located-search-hit shape;
 *  History reads a routed letter in its own column since that change). */
async function openHistoryRow(container: HTMLElement): Promise<void> {
  void container;
  window.location.hash = "#/search/m/h1";
  await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
  await waitFor(() => document.querySelector(".reader") != null, "the reading sheet to open");
}

describe("the reader's modal claim, by width", () => {
  it("narrow: the full-screen sheet claims aria-modal", async () => {
    narrow = true;
    const container = await shell();
    await key("j");
    await key("Enter");
    await waitFor(() => document.querySelector(".reader") != null, "the reading sheet to open");
    expect(document.querySelector(".reader")!.getAttribute("aria-modal")).toBe("true");
    void container;
  });

  it("desktop: the sheet over a place-view is a dialog WITHOUT aria-modal", async () => {
    const container = await shell();
    await openHistoryRow(container);
    const sheet = document.querySelector(".reader")!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBeNull();
  });

  it("desktop: a rail press with the sheet standing lands, and the navigation closes the reader", async () => {
    /* jsdom dispatches the click regardless of CSS hit-testing, so what this arm proves is the
       journey's WIRING: a landed rail press navigates and the route transition takes the sheet
       down — no second press, no Escape. The hit-testing half (the rail keeping pointer events
       above the overlay at ≥1024px) is the stylesheet's, pinned below. */
    const container = await shell();
    await openHistoryRow(container);
    const ohbox = [...container.querySelectorAll<HTMLButtonElement>(".rail .ritem")]
      .filter((b) => (b.textContent ?? "").includes("Ohbox"));
    expect(ohbox.length, "exactly one rail item named Ohbox").toBe(1);
    await act(async () => { ohbox[0]!.click(); });
    await settle();
    expect(document.querySelector(".reader"), "the sheet must be down after the navigation").toBeNull();
    await waitFor(() => rowIds(container).includes("m1"), "the Ohbox rows to be back on screen");
  });

  it("desktop: the Ohbox open renders the pane, never the sheet — the trigger is the view", async () => {
    const container = await shell();
    await key("j");
    await key("Enter");
    await settle();
    expect(document.querySelector(".reader")).toBeNull();
    // The message is on screen in the reading column, not gone with the sheet.
    expect(container.querySelector(".read-col")).not.toBeNull();
  });
});

describe("reader-rail-css — the ≥1024px reading rules keep the rail operable", () => {
  /* jsdom lays out no stylesheet, so the deciding lines are pinned over the SHIPPED file: the
     desktop reading block must hide the stage, not the shell, and hand the rail its pointer
     events above the overlay. Remove `pointer-events: auto` (the deciding line) and this is red. */
  const css = readFileSync(resolve(__dirname, "../app/app.css"), "utf8");
  const block = /@media \(min-width: 1024px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  it("hides the deck's non-rail content instead of the whole shell", () => {
    expect(block).toContain("body.reading .deck > :not(.rail)");
    expect(block).not.toMatch(/body\.reading div\.shell \{[^}]*opacity: 0[^.}]*\}/);
  });

  it("the rail keeps pointer events, stacked above the reading overlay", () => {
    const rail = /body\.reading \.deck > \.rail \{([\s\S]*?)\}/.exec(block)?.[1] ?? "";
    expect(rail).toContain("pointer-events: auto");
    expect(rail).toContain("z-index: calc(var(--z-read) + 1)");
  });
});
