/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
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
import { CURSOR_HINT_MS } from "@ohmail/app-logic/keys";
import { reportPress, reportSays } from "./ohbox/_finders.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE FIRST PRESS OF A MESSAGE VERB ON A LIST WITH NO CURSOR
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Reported from a real Ohbox: Backspace does not delete. It was not the delete — it was the
 * CURSOR. A freshly opened list has nothing selected, so `focused` is null, so every message
 * verb's binding is `disabled`, and the dispatcher dropped each one before the chord was even
 * matched (`keymap.tsx`'s `live` filter). No cursor, no request, no sentence, no `preventDefault`
 * — the `?` sheet was the only place on screen that said the keys were resting. Eighteen verbs,
 * every list, silently.
 *
 * ── WHAT THIS FILE PINS, AND WHY IT IS THE WHOLE SHELL ───────────────────────────────────────
 *
 * The rule spans four things that can each be half-wired without failing anything else: a
 * `disabledReason` at the declaring site, a walk in the dispatcher, a placer claimed by the host,
 * and one line of copy. Every one of those compiles and typechecks alone. So the press here is a
 * real keypress on a real `AppShell` over a real engine, and what is asserted is what a person
 * would see: the ring on the first row, the sentence naming the next press's verb, and NOTHING on
 * the wire.
 *
 * The transport is the one thing stubbed — the injected adapter accepts every verb and applies
 * `mutationEffects` in process — for the reason `delete-key-shell.test.tsx` states: the wire
 * mapping is `packages/client-engine`'s and has its own harness. Everything about the rule under
 * test is the shipped code.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────────
 *
 *   · make the parked walk RUN the binding (`b.run(e)` instead of the placer) → "performs
 *     NOTHING" reds alone, with the row gone and a delete on the wire;
 *   · drop the `disabledReason === "no_cursor"` clause from the `parked` filter → the Reply Run
 *     case reds: `f` rests on an empty pile, not on a cursor, and would place one;
 *   · drop the `b.group === "message"` clause → the Pull case reds, for the same reason;
 *   · drop `...noCursor` from the shell's `e` binding → the Park case reds while ⌫ still passes,
 *     which is exactly the half-applied shape;
 *   · make `placeCursor` answer `true` on an empty list → the empty-list case reds;
 *   · place a cursor at mount → "no cursor until somebody presses something" reds.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-09T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Every verb this shell put on the wire. The first-press cases assert it stays empty. */
let sent: EngineMutation[] = [];

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  // jsdom gaps, stubbed at their narrowest — `delete-key-shell.test.tsx`'s precedent.
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  /* The frame's report animates its way out (the kit's motion): jsdom has no Web Animations. */
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  sent = [];
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

/* ── the account this shell is mounted over ─────────────────────────────────────────────────── */

const address = (id: string): string => `p${id}@example.invalid`;

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  to: [], cc: [], labels: [], date: "2026-09-08T09:00:00.000Z", unread: false,
  updatedAt: "2026-09-08T09:00:00.000Z",
} as unknown as EngineMessage);

/**
 * A mirror holding `ids`, each from a CONSENTED sender — the rule is what puts the mail in the
 * Ohbox, because the cutline presents by decision and not by folder. Without the rules the pile
 * would be empty and every case here would pass vacuously.
 */
async function storeWith(ids: string[]): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
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
        sent.push(m);
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

/**
 * A consent wire, with the folders foundation ON or OFF.
 *
 * ON for every case here, and deliberately so: the delete verb is gated behind that flag in this
 * tree, and a case built on the flag being OFF would be a case about the gate rather than about
 * the cursor — a distinction that matters because the gate is on its way out. What this file
 * asserts is true either way.
 */
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
  lastSyncAt: "2026-09-09T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

async function shell(ids: string[]): Promise<HTMLElement> {
  const { MailShell: AppShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const engine = engineOver(await storeWith(ids));
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
  if (ids.length > 0) await waitFor(() => rowIds(container).length > 0, "rows in the Ohbox");
  else await settle();
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
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

/** A beat for anything that was NOT supposed to happen — so its absence means something. */
const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
};

const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(":is(.row, [role=option])[data-id]")].map((r) => r.getAttribute("data-id") ?? "");
const shortcutSheet = () => screen.queryByRole("dialog", { name: messages.shortcuts.title });
const sheetRow = (label: string): HTMLElement | null =>
  within(screen.getByRole("dialog", { name: messages.shortcuts.title })).queryByText(label)?.closest("p") ?? null;


describe("the `?` sheet says WHY a message row is grey", () => {
  it("a row waiting for a cursor carries the sentence; a live row carries none", async () => {
    await shell(["m1", "m2", "m3"]);
    await key("?");
    await waitFor(() => shortcutSheet() !== null, "the shortcut sheet");

    const del = sheetRow(messages.shortcuts.deleteKey);
    expect(del, "the sheet does not document the delete key").toBeTruthy();
    expect(del!.getAttribute("aria-disabled")).toBe("true");
    expect(del!.getAttribute("title")).toBe(messages.shortcuts.needsCursor);

    /* A LIVE ROW MUST NOT CARRY IT. Compose is bound with no `disabled` at all, so a sentence on
       it would mean the title had stopped tracking the reason and become decoration. */
    const compose = sheetRow(messages.shortcuts.compose);
    expect(compose, "the sheet does not document Compose").toBeTruthy();
    expect(compose!.getAttribute("aria-disabled")).not.toBe("true");
    expect(compose!.getAttribute("title")).toBeNull();
  }, 30000);

  it("…and the sentence GOES when the cursor arrives — the reason is state, not decoration", async () => {
    await shell(["m1", "m2", "m3"]);
    await key("j");
    await key("?");
    await waitFor(() => shortcutSheet() !== null, "the shortcut sheet");

    const del = sheetRow(messages.shortcuts.deleteKey);
    expect(del, "the sheet does not document the delete key").toBeTruthy();
    expect(del!.getAttribute("aria-disabled")).not.toBe("true");
    expect(del!.getAttribute("title"), "the sentence outlived the state it describes").toBeNull();
  }, 30000);
});
