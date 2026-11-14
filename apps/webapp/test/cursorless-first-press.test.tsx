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
import { CURSOR_HINT_MS } from "../app/shell/AppShell";

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
  to: [], date: "2026-09-08T09:00:00.000Z", unread: false,
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
  const { AppShell } = await import("../app/shell/AppShell.js");
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
    document.dispatchEvent(
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
  [...el.querySelectorAll(".row[data-id]")].map((r) => r.getAttribute("data-id") ?? "");
const selectedIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".row.sel[data-id]")].map((r) => r.getAttribute("data-id") ?? "");
const toastText = (): string => document.querySelector(".toast")?.textContent ?? "";
const deletes = (): EngineMutation[] => sent.filter((m) => m.kind === "message_delete");

/**
 * THE SENTENCE FOR ONE VERB, from the catalogue rather than typed out here. `{label}` is a plain
 * ICU argument, so substitution is the whole of the formatting — and reading the catalogue is what
 * makes a copy edit visible to this file instead of silently disagreeing with it.
 */
const hintFor = (label: string): string => messages.cursor.placed.replace("{label}", label);

/** The `?` sheet's row for one label, and the sentence (if any) it carries. */
const sheetRow = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(".ks li")]
    .find((li) => (li.querySelector(".ks-lab")?.textContent ?? "").trim() === label);

describe("a list with rows and no cursor", () => {
  it("no cursor exists until somebody presses something — an arrival places nothing", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    /* THE HAZARD THIS DESIGN REFUSES, stated as an assertion: `selectedOhbox`'s own comment
       records what a `?? allOhbox[0]` fallback did — it fetched a body from the user's own server
       and put somebody's mail in the reading column on arrival. ⌫ is that with a delete on the
       end of it. */
    expect(selectedIds(container), "a cursor was placed with no press").toEqual([]);
    expect(toastText()).not.toContain("Press again");
    expect(sent, "the shell put a verb on the wire on arrival").toEqual([]);
  }, 30000);

  it("BACKSPACE places the cursor on the first row, says which verb is next, and performs NOTHING", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    const before = rowIds(container);
    expect(before.length).toBeGreaterThan(1);

    await key("Backspace");

    expect(selectedIds(container), "the cursor did not land on the first row").toEqual([before[0]]);
    expect(toastText()).toBe(hintFor(messages.shortcuts.deleteKey));
    /* THE HALF THAT MATTERS. A first press that also deleted would be the design inverted: the
       blind ⌫ this rule exists to make impossible. */
    expect(rowIds(container), "the first press moved mail").toEqual(before);
    expect(deletes(), "the first press put a delete on the wire").toEqual([]);
  }, 30000);

  it("…and the SECOND press performs — the ordinary path, not a second mechanism", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    const before = rowIds(container);

    await key("Backspace");
    await key("Backspace");

    await waitFor(() => !rowIds(container).includes(before[0]!), "the row to leave the list");
    expect(toastText()).toContain(messages.ohbox.toastDeleted);
    expect(toastText()).toContain(messages.screener.toastUndo);
  }, 30000);

  /**
   * THE HINT NAMES THE VERB OF THE CHORD PRESSED — three verbs sampled, one shell each.
   *
   * One `it` per verb rather than a loop, and the loop was written first: sharing one jsdom
   * document across three mount/unmount cycles left the second verb placing nothing, which is a
   * fact about the fixture and not about the product (each verb passes alone). A case that can
   * fail for a reason the product cannot cause is a case nobody can read.
   *
   * `{label}` is the binding's OWN sheet label, so every verb reads correctly with no grammar per
   * verb — which is the whole reason the sentence is built this way rather than one string each.
   */
  for (const [chord, label, name] of [
    ["r", messages.shortcuts.reply, "Reply"],
    ["e", messages.shortcuts.park, "Park"],
    ["b", messages.shortcuts.resurface, "Resurface"],
  ] as const) {
    it(`\`${chord}\` places the cursor and its hint names ${name}`, async () => {
      const container = await shell(["m1", "m2", "m3"]);
      await key(chord);
      expect(selectedIds(container), `${chord} placed no cursor`).toHaveLength(1);
      expect(toastText(), `${chord}'s hint names the wrong verb`).toBe(hintFor(label));
      expect(sent, `${chord} performed on its first press`).toEqual([]);
    }, 30000);
  }

  it("PARK's second press parks — a verb that is not the delete, through the same two presses", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    const first = rowIds(container)[0]!;

    await key("e");
    expect(rowIds(container), "the first press filed mail").toContain(first);

    await key("e");
    await waitFor(() => !rowIds(container).includes(first), "the parked row to leave the Ohbox");
    expect(sent.some((m) => m.kind === "triage_set"), "nothing was filed").toBe(true);
  }, 30000);

  it("the hint carries no action and stands for the hint's own window", async () => {
    /* A cursor has nothing to undo, and an Undo button beside this sentence would read as "put the
       mail back" — from a press that moved none. The duration is read from the constant so a copy
       or timing change is visible here rather than silently disagreeing. */
    await shell(["m1", "m2", "m3"]);
    await key("Backspace");
    expect(document.querySelector(".toast .toast-act"), "the hint offers an action").toBeNull();
    expect(CURSOR_HINT_MS).toBe(2400);
  }, 30000);

  it("the hint is ANNOUNCED — the toast's own live region, asserted rather than assumed", async () => {
    await shell(["m1", "m2", "m3"]);
    await key("Backspace");
    const toast = document.querySelector(".toast");
    expect(toast?.getAttribute("role")).toBe("status");
    expect(toast?.getAttribute("aria-live")).toBe("polite");
  }, 30000);

  it("focus does NOT move to the row — the ring is the indicator, the keyboard stays where it is", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    const before = document.activeElement;
    await key("Backspace");
    expect(selectedIds(container)).toHaveLength(1);
    expect(document.activeElement, "the placement stole focus").toBe(before);
  }, 30000);

  it("a HELD key places nothing — auto-repeat is not a press", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    await key("Backspace", { repeat: true });
    await settle();
    expect(selectedIds(container), "a repeat placed a cursor").toEqual([]);
    expect(toastText()).not.toContain("Press again");
    // THE CONTROL: the same key, the same list, pressed rather than held.
    await key("Backspace");
    expect(selectedIds(container)).toHaveLength(1);
  }, 30000);

  it("A QUESTION STANDING OVER THE DECK owns the key — nothing is placed under it", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");
    /* The sheet dismisses on ANY key, so this press both closes it and — with the gate missing —
       would place a cursor underneath it. The gate is read at the press, not after. */
    await key("Backspace");
    await settle();
    expect(selectedIds(container), "a cursor was placed under an open dialog").toEqual([]);
  }, 30000);
});

describe("a list with NO rows", () => {
  it("nothing is placed, nothing is said, nothing is performed", async () => {
    const container = await shell([]);
    expect(rowIds(container), "the fixture is not the empty list this case is about").toEqual([]);

    for (const chord of ["Backspace", "Delete", "r", "e", "b"]) await key(chord);
    await settle();

    expect(selectedIds(container)).toEqual([]);
    expect(toastText()).not.toContain("Press again");
    expect(sent, "a verb reached the wire over an empty list").toEqual([]);
  }, 30000);
});

describe("a binding resting for ANOTHER reason keeps falling through", () => {
  it("`f` rests on an EMPTY REPLY-LATER PILE, not on a cursor — it places nothing", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    /* THE CLAIM UNDER TEST, asserted first so this cannot pass on a live binding: the sheet is
       generated from the same table the dispatcher walks, and `f`'s row is greyed here. */
    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");
    const row = sheetRow(messages.shortcuts.replyRun);
    expect(row, "the sheet does not list the Reply Run").toBeDefined();
    expect(row!.className, "`f` is live here, so this case proves nothing").toContain("off");
    await key("Escape");
    await settle();

    await key("f");
    await settle();
    expect(selectedIds(container), "a verb resting on an empty pile placed a cursor").toEqual([]);
    expect(toastText()).not.toContain("Press again");
  }, 30000);

  it("`p` is an APP verb — the rule is scoped to the message group and `p` places nothing", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");
    const row = sheetRow(messages.shortcuts.pull);
    expect(row, "the sheet does not list Pull").toBeDefined();
    expect(row!.className, "Pull is live here, so this case proves nothing").toContain("off");
    await key("Escape");
    await settle();

    await key("p");
    await settle();
    expect(selectedIds(container), "an app verb placed a message cursor").toEqual([]);
    expect(toastText()).not.toContain("Press again");
  }, 30000);

  it("`⇧R` on a message with nobody else on it falls through WITH a cursor on the row", async () => {
    const container = await shell(["m1", "m2", "m3"]);
    await key("j");
    expect(selectedIds(container), "the cursor did not move").toHaveLength(1);
    const before = toastText();

    await key("R", { shiftKey: true });
    await settle();
    /* Disabled for its OWN reason — `replyAllRecipients` is null on a 1:1 message — so no hint,
       no placement, and the key is left to fall through exactly as it does today. */
    expect(toastText(), "a verb resting on its own predicate showed the cursor hint").toBe(before);
  }, 30000);
});

describe("the `?` sheet says WHY a message row is grey", () => {
  it("a row waiting for a cursor carries the sentence; a live row carries none", async () => {
    await shell(["m1", "m2", "m3"]);
    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");

    const del = sheetRow(messages.shortcuts.deleteKey);
    expect(del, "the sheet does not document the delete key").toBeDefined();
    expect(del!.className).toContain("off");
    expect(del!.getAttribute("title")).toBe(messages.shortcuts.needsCursor);

    /* A LIVE ROW MUST NOT CARRY IT. Compose is bound with no `disabled` at all, so a sentence on
       it would mean the title had stopped tracking the reason and become decoration. */
    const compose = sheetRow(messages.shortcuts.compose);
    expect(compose, "the sheet does not document Compose").toBeDefined();
    expect(compose!.className ?? "").not.toContain("off");
    expect(compose!.getAttribute("title")).toBeNull();
  }, 30000);

  it("…and the sentence GOES when the cursor arrives — the reason is state, not decoration", async () => {
    await shell(["m1", "m2", "m3"]);
    await key("j");
    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");

    const del = sheetRow(messages.shortcuts.deleteKey);
    expect(del, "the sheet does not document the delete key").toBeDefined();
    expect(del!.className ?? "").not.toContain("off");
    expect(del!.getAttribute("title"), "the sentence outlived the state it describes").toBeNull();
  }, 30000);
});
