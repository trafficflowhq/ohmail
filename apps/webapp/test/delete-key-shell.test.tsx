/** @vitest-environment jsdom */
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
import type { MailboxFacts } from "../app/shell/mail-state";
import { UNDO_MS } from "../app/shell/delete-undo";

/**
 * BACKSPACE AND DELETE, ON THE SHIPPED SHELL, THROUGH BOTH DOORS.
 *
 * `delete-key.test.tsx` proves the rules over the real units. This file proves they are REACHED,
 * because every way this could be half-wired compiles and passes that file: a binding factory
 * never spread into the shell's array, held ids no projection subtracts, a `case "delete"` still
 * dispatching straight to the engine. So the press here is a real keypress on a real `AppShell`
 * over a real engine, and what is asserted is what a person would see.
 *
 * ── WHY IT IS NOT THE DEMO ────────────────────────────────────────────────────────────────
 *
 * `demo: true` keeps the RESTING consent (`useConsentState(!demo, …)`), and the fixture world
 * carries no roster, so it cannot exercise the ROLE half of the gate at all. The shell is
 * therefore mounted the way a connected account mounts it: its own engine over a memory mirror,
 * a consent wire, and a mailbox roster.
 *
 * The consent wire's FOLDERS answer used to be load-bearing here — Delete was gated on the
 * "Use folders" foundation flag, so a folders-off world could not reach the verb. It is not any
 * more, and the last describe in this file is that change's control: the same press, on a shell
 * whose consent says folders are OFF, must do exactly what it does with them on. Delete files to
 * the mail server's own \Trash, which is not a folder anybody made.
 *
 * WHAT IS AND IS NOT STUBBED, stated precisely because the first version of this line overclaimed
 * ("nothing about the verb is stubbed") and review caught it: the SHELL, the bindings, the gate,
 * the queue, the projection and the role predicate are all the shipped ones. The TRANSPORT is
 * not — the injected adapter accepts every verb and applies `mutationEffects` in process, so this
 * file stays green over a broken production `DELETE /messages/:id` mapping. That mapping is
 * `packages/client-engine`'s, and its own verb-parity harness drives it against the real API;
 * asserting it here would be a second, weaker copy of that.
 *
 * ── AND THE READER DOOR IS DRIVEN, NOT DESCRIBED ──────────────────────────────────────────
 *
 * The second describe supplies a roster whose one mailbox is organized by somebody else. Nothing
 * else changes: the same shell, the same engine, the same key. The refusal that comes back is
 * produced by the shipped `screenerMode` → `readerMoveRefusal` path out of the shipped
 * catalogue, and the assertion that matters beside the sentence is `sent` — a reader must put
 * NOTHING on the wire, which is the half a released build got wrong for the Screener (a press
 * that said "filed", emptied the row, and moved nothing).
 *
 * ── HOW TO WATCH IT FAIL ──────────────────────────────────────────────────────────────────
 *
 *   · drop the `...deleteKeyBindings({…})` spread → "takes the row out of the list" goes red;
 *   · drop `hideMessages(…)` from `presented` → the same case goes red with the toast up and the
 *     row still listed — the exact half-wired state that would otherwise ship;
 *   · dispatch `message_delete` in `case "delete"` instead of holding it → "nothing is on the
 *     wire while the window is open" goes red;
 *   · drop the `refusal()` gate → "a reader is refused" goes red with a delete on the wire for a
 *     mailbox this install does not organize;
 *   · take the `modal` flag off the `?` sheet's `escapeLayers` entry → "a question standing over
 *     the deck" goes red.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Every verb this shell put on the wire. The reader cases assert it stays empty. */
let sent: EngineMutation[] = [];
/** Set before `shell()` to make `matchMedia` answer a max-width query — the narrow layout. */
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
  // jsdom gaps, stubbed at their narrowest — see `escape-precedence.test.ts`.
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
  narrow = false;
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

/* ── the account this shell is mounted over ────────────────────────────────────────────────── */

const address = (id: string): string => `p${id}@example.invalid`;

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  to: [], date: "2026-09-03T09:00:00.000Z", unread: false,
  updatedAt: "2026-09-03T09:00:00.000Z",
} as unknown as EngineMessage);

/**
 * A mirror holding `ids`, each from a CONSENTED sender.
 *
 * The rule is what puts the mail in the Ohbox: the consent cutline presents by decision, not by
 * folder, so mail from a sender with no rule waits in the Screener however its `folder` reads.
 * Without these the pile under test would be empty and every case below would pass vacuously.
 */
async function storeWith(ids: string[], history: string[] = []): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  /* HISTORY'S OWN ROWS — a sender nobody has decided about, whose mail is READ and old enough to
     be dormant. `consentPartition` presents exactly that in History, and no rule is written for
     them, which is what keeps them out of the Ohbox. */
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

/** An engine over `store` that records every verb and applies its own optimistic effects. */
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
 * THE CONSENT DOUBLE'S SHAPE, named once because there are two of them.
 *
 * `foldersEnabledAt` is `string | null` by ANNOTATION and not by inference: inferred from the
 * folders-on literal it is `string`, and the folders-off wire below is then not assignable —
 * five errors from `pnpm -C apps/webapp run typecheck`, which does typecheck this app's tests.
 */
interface ConsentDouble {
  foldersStorable: boolean;
  state: () => Promise<{
    seedConfirmedAt: string;
    screeningResetAt: string | null;
    dormancyDays: number;
    foldersEnabledAt: string | null;
  }>;
  setAutoSuggest: () => Promise<{ autoSuggestAt: string | null }>;
  setDormancyDays: () => Promise<Record<string, never>>;
  setBlockRemoteImages: () => Promise<{ blockRemoteImagesAt: string | null }>;
  setBlockTrackingPixels: () => Promise<{ loadTrackingPixelsAt: string | null }>;
  setBlockAutoUnsubscribe: () => Promise<{ blockAutoUnsubscribeAt: string | null }>;
  setFoldersEnabled: () => Promise<{ foldersEnabledAt: string | null }>;
  setMailboxFoldersEnabled: () => Promise<{ folderMailboxesOff: Record<string, string> }>;
  setMailboxSignature: () => Promise<{ signatures: Record<string, string> }>;
}

/** A consent wire that says the folders foundation is on. */
const consentTransportBase: ConsentDouble = {
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

const consentTransport: ConsentDouble = consentTransportBase;

/**
 * THE SAME WIRE WITH "USE FOLDERS" OFF — `foldersEnabledAt: null`, which is what an account that
 * has never turned the switch on answers, and what the hosted door answers after it is turned
 * off. `foldersStorable` stays true because this IS the hosted door: the flag is storable here
 * and the answer is simply "off", which is a different state from the standalone door where the
 * field is stripped and the flag can never be on at all.
 */
const foldersOffConsentTransport: ConsentDouble = {
  ...consentTransportBase,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z",
    screeningResetAt: null,
    dormancyDays: 90,
    foldersEnabledAt: null,
  }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: null }),
};

const ORGANIZER_ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-04T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

/** The same account, organized by another install — the door the refusal belongs to. */
const READER_ROSTER: MailboxFacts[] = [{
  ...ORGANIZER_ROSTER[0]!,
  organizerRole: "reader" as const,
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T09:00:00.000Z" },
}];

/**
 * TWO MAILBOXES, ONE ORGANIZED HERE AND ONE NOT — and the mail under test belongs to the one
 * that is NOT. This is the roster on which the account-aggregate role answered "organizer" and
 * put a delete on the wire for somebody else's mailbox (review, 2026-09-06). `mb1` is where every
 * message in this file lives, so the press must be refused; `other` is what made it permitted.
 */
const MIXED_ROSTER: MailboxFacts[] = [
  { ...ORGANIZER_ROSTER[0]!, id: "other", address: "other@example.invalid" },
  { ...READER_ROSTER[0]! },
];

/** No roster at all — before the first probe answers, and through an outage. */
const NO_ROSTER: MailboxFacts[] | null = null;

/** `null` roster = a probe that rejects (pending); `undefined` = NO PROBE, the desktop and demo. */
async function shell(
  roster: MailboxFacts[] | null | undefined,
  history: string[] = [],
  consent: ConsentDouble = consentTransport,
): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const engine = engineOver(await storeWith(["m1", "m2", "m3"], history));
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
            consentTransport: consent,
            /* UNDEFINED MEANS THE PROP IS ABSENT, which is how the desktop and the demo mount
               this shell — not a probe that answers nothing, but no probe at all. */
            ...(roster === undefined
              ? {}
              : {
                mailboxFacts: async () => {
                  if (roster === null) throw new Error("roster unavailable");
                  return roster;
                },
              }),
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

/** A beat for anything that was NOT supposed to happen — so its absence means something. */
const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
};

const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".row[data-id]")].map((r) => r.getAttribute("data-id") ?? "");
const toastText = (): string => document.querySelector(".toast")?.textContent ?? "";
const deletes = (): EngineMutation[] => sent.filter((m) => m.kind === "message_delete");

describe("an install that organizes the mailbox", () => {
  it("BACKSPACE takes the row out of the list, offers Undo, and puts NOTHING on the wire yet", async () => {
    const container = await shell(ORGANIZER_ROSTER);
    const id = rowIds(container)[0]!;

    await key("j");
    await key("Backspace");

    await waitFor(() => !rowIds(container).includes(id), "the row to leave the list");
    expect(toastText()).toContain(messages.ohbox.toastDeleted);
    expect(toastText()).toContain(messages.screener.toastUndo);
    /* THE WHOLE POINT OF THE WINDOW. The press is reversible because nothing has been sent —
       `message_delete` has no inverse, so an Undo over a request already gone would be a button
       for something this product cannot do. */
    expect(deletes()).toEqual([]);
  });

  it("UNDO puts it back, and still nothing was sent", async () => {
    const container = await shell(ORGANIZER_ROSTER);
    const id = rowIds(container)[0]!;
    await key("j");
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(id), "the row to leave the list");

    const undo = document.querySelector<HTMLButtonElement>(".toast-act");
    expect(undo, "the toast carried no Undo").not.toBeNull();
    await act(async () => { undo!.click(); });

    await waitFor(() => rowIds(container).includes(id), "the row to come back");
    expect(toastText()).toContain(messages.ohbox.deleteUndone);
    expect(deletes()).toEqual([]);
  });

  it("DELETE does the same thing as Backspace", async () => {
    const container = await shell(ORGANIZER_ROSTER);
    const id = rowIds(container)[0]!;
    await key("j");
    await key("Delete");
    await waitFor(() => !rowIds(container).includes(id), "the row to leave the list");
    expect(deletes()).toEqual([]);
  });

  it("WHEN THE WINDOW CLOSES the delete goes out — once, for the row that was pressed", async () => {
    const container = await shell(ORGANIZER_ROSTER);
    const id = rowIds(container)[0]!;
    await key("j");
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(id), "the row to leave the list");

    /* THE REAL `UNDO_MS`, WAITED OUT, rather than a fake clock. Fake timers cannot be installed
       here after the fact — the window was armed by the press through the real `setTimeout`, so
       a clock swapped in afterwards advances nothing and the case would report "nothing was
       sent" for a delete that is simply still pending. Installing them BEFORE the mount would
       put the shell's own boot on a controlled clock, which is a much larger claim than this
       case needs. `delete-key.test.tsx` drives the queue's timing directly with an injected
       timer; this one waits, so the number under test is the one the product ships. */
    await waitFor(() => deletes().length > 0, "the window to close and the delete to go out",
      UNDO_MS + 8000);

    expect(deletes()).toEqual([{ kind: "message_delete", messageId: id }]);
    expect(rowIds(container)).not.toContain(id);
  }, UNDO_MS + 20000);

  it("A QUESTION STANDING OVER THE DECK owns the key — the `?` sheet is open, nothing moves", async () => {
    const container = await shell(ORGANIZER_ROSTER);
    const before = rowIds(container);
    await key("j");
    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");
    /* The sheet dismisses on ANY key, so this press both closes it and — with the gate missing —
       would delete underneath it. That is the sequence worth guarding: the gate is read at the
       moment of the press, not after the sheet has gone. */
    await key("Backspace");
    await settle();
    expect(rowIds(container)).toEqual(before);
    expect(toastText()).not.toContain(messages.ohbox.toastDeleted);
    expect(deletes()).toEqual([]);
  });

  it("the `?` sheet documents it as ONE row with both keycaps", async () => {
    await shell(ORGANIZER_ROSTER);
    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");
    const rows = [...document.querySelectorAll<HTMLElement>(".ks li")]
      .filter((li) => (li.querySelector(".ks-lab")?.textContent ?? "").trim() === messages.shortcuts.deleteKey);
    expect(rows, "the sheet does not document the delete key").toHaveLength(1);
    expect([...rows[0]!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["⌫", "⌦"]);
  });
});

describe("\"USE FOLDERS\" IS NOT A TERM — the same press, on a folders-off account", () => {
  /**
   * ── THE INVERSION, AND WHY IT IS AN INVERSION ─────────────────────────────────────────────
   *
   * These cases used to be impossible to write: with the consent wire answering
   * `foldersEnabledAt: null` the shell's delete admission was false, the binding was `disabled`,
   * and `keymap` dropped the press before the chord matched — no toast, no refusal sentence, no
   * request, and the `?` sheet the only place the state showed at all. That was the shipped
   * behaviour and it was measured live on a real folders-off account: a PICKED row deleted with
   * a "Moved to Trash." toast and a `DELETE /messages/:id` on the wire, while the row under the
   * CURSOR produced nothing.
   *
   * So every assertion below is the OPPOSITE of what this file could once have asserted about a
   * folders-off world, and that is the point: one verb, one admission, whichever door asks.
   * Delete files the message to the mail server's own \Trash — a system folder every account
   * already has, discovered at connect beside \Junk — so the USER-folders foundation was never
   * a fact about whether the verb can run, and the engine's `message_delete` never read it.
   *
   * The ROLE half of the gate is untouched and is asserted here too: a folders-off READER is
   * still refused, in the same words. Dropping one term is not opening the door.
   */
  it("BACKSPACE takes the row out and offers Undo — with the folders switch OFF", async () => {
    const container = await shell(ORGANIZER_ROSTER, [], foldersOffConsentTransport);
    const id = rowIds(container)[0]!;

    await key("j");
    await key("Backspace");

    await waitFor(() => !rowIds(container).includes(id), "the row to leave the list");
    expect(toastText()).toContain(messages.ohbox.toastDeleted);
    expect(toastText()).toContain(messages.screener.toastUndo);
    expect(deletes()).toEqual([]);
  });

  it("DELETE does the same thing — with the folders switch OFF", async () => {
    const container = await shell(ORGANIZER_ROSTER, [], foldersOffConsentTransport);
    const id = rowIds(container)[0]!;
    await key("j");
    await key("Delete");
    await waitFor(() => !rowIds(container).includes(id), "the row to leave the list");
    expect(deletes()).toEqual([]);
  });

  it("AND THE DELETE GOES OUT when the window closes — the wire, not just the row", async () => {
    // The row leaving the list is the projection; this is the half that proves the press
    // reached the verb rather than merely hiding a row on a shell that would never send.
    const container = await shell(ORGANIZER_ROSTER, [], foldersOffConsentTransport);
    const id = rowIds(container)[0]!;
    await key("j");
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(id), "the row to leave the list");
    await waitFor(() => deletes().length > 0, "the window to close and the delete to go out",
      UNDO_MS + 8000);
    expect(deletes()).toEqual([{ kind: "message_delete", messageId: id }]);
  }, UNDO_MS + 20000);

  it("`d` OPENS THE ASK with the switch off — and the sheet draws neither row greyed", async () => {
    /* The `?` sheet's `off` class is computed from each binding's `disabled`, so this case is
       what a person actually sees: before the fix both the `d` row and the `⌫·⌦` row were drawn
       greyed on a folders-off account, which is how a live check found the defect. */
    const container = await shell(ORGANIZER_ROSTER, [], foldersOffConsentTransport);
    await key("j");

    await key("?");
    await waitFor(() => document.querySelector(".ks") != null, "the shortcut sheet");
    const rowFor = (label: string): HTMLElement => {
      const li = [...document.querySelectorAll<HTMLElement>(".ks li")]
        .find((el) => (el.querySelector(".ks-lab")?.textContent ?? "").trim() === label);
      expect(li, `the sheet does not document ${JSON.stringify(label)}`).not.toBeUndefined();
      return li!;
    };
    expect(rowFor(messages.shortcuts.deleteKey).className, "⌫·⌦ drawn greyed with folders off")
      .not.toContain("off");
    expect(rowFor(messages.shortcuts.deleteAsk).className, "`d` drawn greyed with folders off")
      .not.toContain("off");
    await key("Escape");

    await key("d");
    await waitFor(() => container.querySelector(".abar-delete") != null,
      "the delete confirm strip");
    const strip = container.querySelector<HTMLElement>(".abar-delete")!;
    expect(strip.getAttribute("role")).toBe("alertdialog");
    // The ask ALONE dispatches nothing — the ceremony is unchanged, only its admission moved.
    expect(deletes()).toEqual([]);
  });

  it("THE CONTROL: a folders-off READER is still refused, in the same words", async () => {
    const container = await shell(READER_ROSTER, [], foldersOffConsentTransport);
    const before = rowIds(container);
    await key("j");
    await key("Backspace");
    await settle();
    expect(rowIds(container)).toEqual(before);
    // The catalogue's sentence, chosen by the shipped derivation from the roster — the same
    // assertion the folders-ON reader case makes, so the two differ in the flag and nothing else.
    expect(toastText()).toContain(
      messages.screener.readerMoveRefused.replace("{name}", "ohmail Cloud"),
    );
    expect(toastText()).not.toContain(messages.ohbox.toastDeleted);
    expect(deletes()).toEqual([]);
  });
});

describe("an install that only READS the mailbox", () => {
  it("is refused in the words the rest of the product uses, and NOTHING is dispatched", async () => {
    const container = await shell(READER_ROSTER);
    const before = rowIds(container);
    await key("j");
    await key("Backspace");
    await settle();

    // The sentence is the catalogue's, chosen by the shipped derivation from the roster above.
    expect(toastText()).toContain(
      messages.screener.readerMoveRefused.replace("{name}", "ohmail Cloud"),
    );
    // Nothing moved, nothing was hidden, and nothing reached the wire — the three halves that
    // came apart in the released Screener, where a press said "filed" over an untouched server.
    expect(rowIds(container)).toEqual(before);
    expect(deletes()).toEqual([]);
    expect(toastText()).not.toContain(messages.ohbox.toastDeleted);
  });

  it("…and no window opens behind the refusal — the delete never arrives late", async () => {
    /* A refusal that merely suppressed the toast would still arm the window, and the delete
       would land `UNDO_MS` later with nothing on screen to connect it to the press. So this
       waits PAST the window on the real clock and asserts the wire stayed empty. */
    const container = await shell(READER_ROSTER);
    const before = rowIds(container);
    await key("j");
    await key("Backspace");
    await act(async () => { await new Promise((r) => setTimeout(r, UNDO_MS + 1500)); });
    expect(deletes()).toEqual([]);
    expect(rowIds(container)).toEqual(before);
  }, UNDO_MS + 20000);
});

describe("the roster decides, one mailbox at a time", () => {
  it("A MIXED ROSTER refuses the press on the mailbox somebody else organizes", async () => {
    /* THE DEFECT: the account-wide role answered `organizer` because ANOTHER mailbox is organized
       here, so the delete was offered, the row hidden, and the mutation dispatched — with only the
       server's per-mailbox check to roll it back. Every message in this shell belongs to `mb1`,
       which this roster reads. */
    const container = await shell(MIXED_ROSTER);
    const before = rowIds(container);
    await key("j");
    await key("Backspace");
    await settle();
    expect(toastText()).toContain(
      messages.screener.readerMoveRefused.replace("{name}", "ohmail Cloud"),
    );
    expect(rowIds(container)).toEqual(before);
    expect(deletes()).toEqual([]);
  });

  it("A DOOR WITH NO PROBE DELETES — the desktop and the demo, which have no roster at all", async () => {
    /* The regression: `mailboxFacts` is optional and those doors supply none, so the roster is
       `null` for ever and every press was refused with a sentence naming another install. The
       shell is mounted here exactly as they mount it — the prop absent — and the press must
       reach the wire, because on those doors the server has always been the authority. */
    const container = await shell(undefined);
    const before = rowIds(container);
    await key("j");
    await key("Backspace");
    await waitFor(() => rowIds(container).length < before.length, "the row to leave the list");
    expect(toastText()).toContain(messages.ohbox.toastDeleted);
    expect(toastText()).not.toContain(messages.screener.readerMoveRefusedUnknown);
    await waitFor(() => deletes().length > 0, "the delete to reach the wire", UNDO_MS + 8000);
    expect(deletes()).toHaveLength(1);
  }, UNDO_MS + 20000);

  it("NO ROSTER refuses too — a destructive verb fails closed before it knows", async () => {
    const container = await shell(NO_ROSTER);
    const before = rowIds(container);
    await key("j");
    await key("Backspace");
    await settle();
    expect(toastText()).toContain(messages.screener.readerMoveRefusedUnknown);
    expect(rowIds(container)).toEqual(before);
    expect(deletes()).toEqual([]);
  });
});

describe("the DOM gate, on the shipped shell", () => {
  it("a FIRST-RUN dialog over the deck stops the key — the enumerated list never saw it", async () => {
    /* Rendered as the real card is (`FirstRun.tsx`), over a live Ohbox with a cursor on a row.
       The gate reads the DOM at the press, so a dialog the shell's Escape list does not know
       about still blocks — which is the whole reason the gate stopped enumerating. */
    const container = await shell(ORGANIZER_ROSTER);
    const before = rowIds(container);
    await key("j");
    const card = document.createElement("div");
    card.className = "login-card ob-card set-pane";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    document.body.appendChild(card);
    await key("Backspace");
    await settle();
    expect(rowIds(container)).toEqual(before);
    expect(deletes()).toEqual([]);
    // THE CONTROL: the same cursor, the same key, with the dialog gone.
    card.remove();
    await key("Backspace");
    await waitFor(() => rowIds(container).length < before.length, "the row to leave once nothing is open");
  });

  it("an open message MENU stops it — state the shell does not hold at all", async () => {
    const container = await shell(ORGANIZER_ROSTER);
    const before = rowIds(container);
    await key("j");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    await key("Delete");
    await settle();
    expect(rowIds(container)).toEqual(before);
    expect(deletes()).toEqual([]);
    menu.remove();
    await key("Delete");
    await waitFor(() => rowIds(container).length < before.length, "the control");
  });
});

describe("HISTORY is filtered like every other view", () => {
  /**
   * THIS CASE ALSO PROVES THE SPLIT VIEWS ARE WIRED, and that is not incidental.
   *
   * History has its own view-local cursor, so the shell's global binding is disabled there
   * (`focused` is null in every split view). The press below can only be answered by the chords
   * `message-verbs.ts` declares — which is where they were MISSING: Tag, Folder, History and
   * Triage showed a message with a visible cursor on it and both keys did nothing. If that
   * declaration is removed, this test goes red at the first `waitFor`.
   */
  it("a held row leaves History too, and comes back on Undo", async () => {
    /* History is built by `consentPartition` over the MIRROR's reader, so `presented`'s
       projection never reached it: the toast said the message had moved to Trash while the row
       sat in History for the whole undo window (review finding). */
    const container = await shell(ORGANIZER_ROSTER, ["h1", "h2"]);
    window.location.hash = "#/history";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => rowIds(container).includes("h1"), "History to list its rows");

    await key("j");
    // j walks History now: the row under the cursor is the one the delete takes.
    const cursor = container.querySelector<HTMLElement>(".view .row.sel")!.dataset.id!;
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(cursor), "the row to leave History");
    expect(deletes(), "and still nothing on the wire").toEqual([]);

    const undo = document.querySelector<HTMLButtonElement>(".toast-act");
    expect(undo, "the toast carried no Undo").not.toBeNull();
    await act(async () => { undo!.click(); });
    await waitFor(() => rowIds(container).includes(cursor), "the row to come back to History");
  });
});

/* ── the ordering the refusal has to keep ─────────────────────────────────────────────────── */

describe("a refused press changes nothing on screen", () => {
  it("the reading sheet stays open — the refusal decides before the sheet closes", async () => {
    /* Reversed, a refused reader delete closed the sheet over the very message it had declined to
       touch: the person is told nothing moved, and the message they were reading is gone from the
       screen (review finding). `remove` answers whether it acted so the caller can order this. */
    /* NARROW, because the sheet is what a narrow layout raises: at a standing reading column
       there is no `readerFor` to close and the ordering under test is not reachable. */
    narrow = true;
    const container = await shell(READER_ROSTER);
    await waitFor(() => rowIds(container).length > 0, "rows");
    await key("j");
    await key("Enter");
    await waitFor(() => document.querySelector(".reader") != null, "the reading sheet to open");
    await key("Backspace");
    await settle();
    expect(document.querySelector(".reader"), "the sheet must still be there").not.toBeNull();
    expect(toastText()).toContain(
      messages.screener.readerMoveRefused.replace("{name}", "ohmail Cloud"),
    );
    expect(deletes()).toEqual([]);
  });
});
