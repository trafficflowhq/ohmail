/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * ═══ ↵ AFTER THE WINDOW NARROWS ACROSS THE READING COLUMN'S CUT ══════════════════════════════
 *
 * A message open in the reading column at 1440, the window narrowed to 390: the crossing raises the
 * reader sheet with that message (DESIGN-FOLD-WIDTHS §1). The sheet used to take focus on its first
 * control, the back button, so the ↵ that opens a message pressed it and the sheet closed. A sheet
 * the WIDTH raised takes focus at its own root. Two sequences: narrowing, and widening then
 * narrowing from a sheet opened at 390.
 *
 * ↵ is driven as a browser does it: keydown at the focused element, and where nothing took it, a
 * focused button's activation (`click`). jsdom has no activation behaviour of its own.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;

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
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
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
  to: [], date: "2026-09-03T09:00:00.000Z", unread: false,
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
  const engine = engineOver(await storeWith(["m1", "m2", "m3"]));
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

describe("↵ opens the reader sheet after the window narrows across the cut", () => {
  it("open in the reading column at 1440, narrowed to 390: ↵ leaves the sheet open on that message", async () => {
    const container = await shell();
    await key("j");
    await key("Enter");
    expect(sheet(container), "a sheet stood over the 1440 reading column").toBeNull();
    await setWidth(390);
    await waitFor(() => sheet(container) !== null, "the crossing raising the sheet");
    await enter();
    expect(sheet(container), "↵ after the narrowing closed the sheet it should have opened").not.toBeNull();
    expect(document.activeElement?.closest(".reader-close"), "focus stands on the sheet's back control").toBeNull();
  });

  it("the twin: opened at 390, widened to 1440, narrowed again — ↵ leaves the sheet open", async () => {
    await setWidth(390);
    const container = await shell();
    await key("j");
    await enter();
    expect(sheet(container), "↵ at 390 opened no sheet").not.toBeNull();
    await setWidth(1440);
    await waitFor(() => sheet(container) === null, "the widening handing the sheet to the column");
    await setWidth(390);
    await waitFor(() => sheet(container) !== null, "the crossing raising the sheet again");
    await enter();
    expect(sheet(container), "↵ after widening then narrowing closed the sheet").not.toBeNull();
  });

  it("positive control: a sheet a PRESS opened still takes focus on its first control", async () => {
    await setWidth(390);
    const container = await shell();
    await key("j");
    await enter();
    await waitFor(() => document.activeElement?.closest(".reader") != null, "focus entering the pressed sheet");
    expect(document.activeElement?.classList.contains("reader-close"), "a pressed sheet no longer enters at its first control").toBe(true);
  });
});
