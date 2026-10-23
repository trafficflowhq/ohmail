/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  MutationRejectedError,
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
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * UNDO PUTS THE LIST BACK AS IT STOOD AT THE PRESS — the row's place in New, the cursor on it.
 *
 * An open holds the row in New until the reader moves on, and the read rule saves the read of what
 * is on screen (the reader is laid out here, `fixtures/thread-layout.ts`). A held Delete (and Park,
 * Answer later) took the row away with its hold, so Undo returned a read row to Earlier — off
 * screen on a long New, under a toast saying it is where it was (the tester's 2026-09-28 to 10-03).
 * The read stands; only the place and the cursor come back. A j preview holds nothing and reads
 * nothing. MOVING ON is any change of the selection, the sheet or the hold after the verb, by any
 * door — then Undo restores nothing and nothing stays held in New.
 * MUTATIONS WATCHED (mutation-control.sh): the verb's record released at the press; one door
 * bypassing the moving-on watcher; the engine's no-op hold not spending the restore.
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
  layout = stubThreadLayout();
});
let layout: ThreadLayout;

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  layout.restore();
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
  to: [], date: DATES[id] ?? "2026-09-03T09:00:00.000Z", unread: UNREAD.has(id),
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
        if (refuseWhen?.(m)) throw new MutationRejectedError("refused", { status: 409, code: "conflict", retryable: false });
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
  const engine = engineOver(await storeWith(IDS, history));
  lastEngine = engine;
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


/** A wire that refuses the mutations this names — the refused-Undo cases. */
let refuseWhen: ((m: EngineMutation) => boolean) | null = null;
let lastEngine: OhmailEngine | null = null;
beforeEach(() => { refuseWhen = null; lastEngine = null; });

const IDS = ["w8", "n1", "n2", "n3", "e1", "e2"];
const UNREAD = new Set(["w8", "n1", "n2", "n3"]);
const DATES: Record<string, string> = {
  w8: "2026-09-04T08:58:00.000Z", n1: "2026-09-04T07:00:00.000Z", n2: "2026-09-04T06:00:00.000Z",
  n3: "2026-09-04T05:00:00.000Z", e1: "2026-09-03T08:00:00.000Z", e2: "2026-09-03T07:00:00.000Z",
};
const NEW = messages.ohbox.newForYou;
const EARLIER = messages.ohbox.previouslySeen;

/** `<listbox label>#<index>` for the row, or `ABSENT`. */
const where = (el: HTMLElement, id: string): string => {
  const r = el.querySelector(`.row[data-id="${id}"]`);
  if (!r) return "ABSENT";
  const lb = r.closest('[role="listbox"]');
  const rows = lb ? [...lb.querySelectorAll(".row[data-id]")].map((x) => x.getAttribute("data-id")) : [];
  return `${lb?.getAttribute("aria-label") ?? "?"}#${rows.indexOf(id)}`;
};
/** The CURSOR's row (`sel`), not the pick: a picked row publishes `aria-selected` too. */
const selectedRow = (el: HTMLElement): string =>
  el.querySelector(".row.sel[data-id]")?.getAttribute("data-id") ?? "none";
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const seen = (): number => sent.filter((m) => m.kind === "mark_seen").length;

/**
 * Put w8 on screen — `open` by a click (the read rule reads it), `preview` by j (nothing is read,
 * nothing held) — wait `ms`, take it away with key `k`, press the toast's Undo.
 */
async function pressAndUndo(ms: number, k: string, how: "open" | "preview" = "open"): Promise<HTMLElement> {
  const c = await shell(ORGANIZER_ROSTER);
  expect(where(c, "w8")).toBe(`${NEW}#0`);
  if (how === "open") await act(async () => { c.querySelector<HTMLElement>('.row[data-id="w8"]')!.click(); });
  else await key("j");
  await sleep(ms);
  await key(k);
  await waitFor(() => !rowIds(c).includes("w8"), "the row to leave");
  const undo = document.querySelector<HTMLButtonElement>(".toast-act");
  expect(undo, "the toast carried no Undo").not.toBeNull();
  await act(async () => { undo!.click(); });
  await waitFor(() => rowIds(c).includes("w8"), "the row to come back");
  await sleep(400);
  return c;
}

describe("a held Delete, undone", () => {
  for (const ms of [300, 2300]) {
    it(`a preview (${ms} ms): back at the top of New, selected, still unread, nothing sent`, async () => {
      const c = await pressAndUndo(ms, "Backspace", "preview");
      expect(where(c, "w8")).toBe(`${NEW}#0`);
      expect(selectedRow(c)).toBe("w8");
      expect(seen()).toBe(0);
      expect(toastText()).toContain(messages.ohbox.deleteUndone);
      expect(deletes()).toEqual([]);
    }, 30000);
  }
  for (const ms of [300, 1500, 3000]) {
    it(`after opening it (${ms} ms): back at the top of New and selected, the read standing`, async () => {
      const c = await pressAndUndo(ms, "Backspace");
      expect(where(c, "w8"), "Undo filed the row under Earlier").toBe(`${NEW}#0`);
      expect(selectedRow(c), "Undo left the cursor where the delete moved it").toBe("w8");
      expect(seen(), "the open's read").toBe(1);
      expect(toastText()).toContain(messages.ohbox.deleteUndone);
      expect(deletes()).toEqual([]);
    }, 30000);
  }

  it("NOT UNDONE: the row stays gone and exactly one delete goes out when the window closes", async () => {
    const c = await shell(ORGANIZER_ROSTER);
    await act(async () => { c.querySelector<HTMLElement>('.row[data-id="w8"]')!.click(); });
    await sleep(2300);
    await key("Backspace");
    await waitFor(() => !rowIds(c).includes("w8"), "the row to leave");
    expect(deletes()).toEqual([]);
    await sleep(UNDO_MS + 500);
    expect(deletes()).toEqual([{ kind: "message_delete", messageId: "w8" }]);
    expect(rowIds(c)).not.toContain("w8");
  }, 30000);

  it("MOVING ON after the Undo files the read row under Earlier, as it would without the Delete", async () => {
    const c = await pressAndUndo(2300, "Backspace");
    expect(where(c, "w8")).toBe(`${NEW}#0`);
    await key("j");
    await sleep(600);
    expect(selectedRow(c)).not.toBe("w8");
    expect(where(c, "w8")).toBe(`${EARLIER}#0`);
    expect(deletes()).toEqual([]);
  }, 30000);
});

describe("the verbs beside it: Park and Answer later, undone after an open", () => {
  for (const [verb, k] of [["Park", "e"], ["Answer later", "a"]] as const) {
    it(`${verb}: back at the top of New and selected`, async () => {
      const c = await pressAndUndo(2300, k);
      expect(where(c, "w8"), "Undo filed the row under Earlier").toBe(`${NEW}#0`);
      expect(selectedRow(c)).toBe("w8");
      expect(toastText()).toContain(messages.ohbox.toastUndone);
      expect(deletes()).toEqual([]);
    }, 30000);
    it(`${verb} advances to the next row, and Undo still puts the row back in New, selected`, async () => {
      const c = await dwellAndPress(k);
      expect(selectedRow(c), "the verb did not advance").toBe("n1");
      await clickUndo();
      await waitFor(() => rowIds(c).includes("w8"), "the row to come back");
      await sleep(400);
      expect(where(c, "w8")).toBe(`${NEW}#0`);
      expect(selectedRow(c)).toBe("w8");
    }, 30000);
    it(`${verb}, CONTROL on a preview: back at the top of New`, async () => {
      const c = await pressAndUndo(1000, k, "preview");
      expect(where(c, "w8")).toBe(`${NEW}#0`);
      expect(deletes()).toEqual([]);
    }, 30000);
  }
});

describe("a split view keeps its own cursor (measured: no Ohbox placement there)", () => {
  it("History: the deleted row and the cursor come back on Undo", async () => {
    const c = await shell(ORGANIZER_ROSTER, ["h1", "h2"]);
    window.location.hash = "#/history";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => rowIds(c).includes("h1"), "History rows");
    await key("j");
    await key("j");
    const at = selectedRow(c);
    await key("Backspace");
    await waitFor(() => !rowIds(c).includes(at), "the row to leave");
    await act(async () => { document.querySelector<HTMLButtonElement>(".toast-act")!.click(); });
    await sleep(400);
    expect(selectedRow(c)).toBe(at);
    expect(deletes()).toEqual([]);
  }, 30000);
});

const heldRow = (): string | null => lastEngine!.openRowHeld();
async function goHash(hash: string): Promise<void> {
  window.location.hash = hash;
  await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
  await sleep(300);
}
const clickUndo = async (): Promise<void> => {
  const undo = document.querySelector<HTMLButtonElement>(".toast-act");
  expect(undo, "the toast carried no Undo").not.toBeNull();
  await act(async () => { undo!.click(); });
};
/** Open w8 by a click (the read rule reads it), wait, take it away with `k`. */
async function dwellAndPress(k: string): Promise<HTMLElement> {
  const c = await shell(ORGANIZER_ROSTER);
  await act(async () => { c.querySelector<HTMLElement>('.row[data-id="w8"]')!.click(); });
  await sleep(2300);
  await key(k);
  await waitFor(() => !rowIds(c).includes("w8"), "the row to leave");
  await sleep(200);
  return c;
}

/* ...and the toast does not say the message is where it was: it files under Earlier, so it says
   only that it was not deleted (the cases above, who did not move on, read the old sentence). */
describe("a person who moved on is not dragged back (every door)", () => {
  it("→ into the reading pane of the row the delete advanced to, then Undo", async () => {
    const c = await dwellAndPress("Backspace");
    const advanced = selectedRow(c);
    expect(advanced, "the premise: the delete advanced the cursor").not.toBe("none");
    await key("ArrowRight");
    await sleep(300);
    await clickUndo();
    await sleep(600);
    expect(selectedRow(c)).toBe(advanced);
    expect(where(c, "w8")).toBe(`${EARLIER}#0`);
    expect(heldRow()).not.toBe("w8");
    expect(deletes()).toEqual([]);
    expect(toastText()).toContain(messages.ohbox.deleteUndoneLeft);
    expect(toastText()).not.toContain(messages.ohbox.deleteUndone);
  }, 30000);

  it("a URL opens another message inside the window, then Undo", async () => {
    const c = await dwellAndPress("Backspace");
    await goHash("#/ohbox/m/n3");
    expect(selectedRow(c), "the premise: the URL opened n3").toBe("n3");
    await clickUndo();
    await sleep(600);
    expect(selectedRow(c)).toBe("n3");
    expect(where(c, "w8")).toBe(`${EARLIER}#0`);
    expect(heldRow()).not.toBe("w8");
    expect(deletes()).toEqual([]);
    expect(toastText()).toContain(messages.ohbox.deleteUndoneLeft);
    expect(toastText()).not.toContain(messages.ohbox.deleteUndone);
  }, 30000);

  it("Back from a message opened by URL to the one before it, then Undo", async () => {
    const c = await dwellAndPress("Backspace");
    const advanced = selectedRow(c);
    await goHash("#/ohbox/m/n3");
    await goHash(`#/ohbox/m/${advanced}`);
    expect(selectedRow(c), "the premise: Back returned to the advanced row").toBe(advanced);
    await clickUndo();
    await sleep(600);
    expect(selectedRow(c)).toBe(advanced);
    expect(where(c, "w8")).toBe(`${EARLIER}#0`);
    expect(heldRow()).not.toBe("w8");
    expect(deletes()).toEqual([]);
    expect(toastText()).toContain(messages.ohbox.deleteUndoneLeft);
    expect(toastText()).not.toContain(messages.ohbox.deleteUndone);
  }, 30000);

  it("Back out of every message (the bare URL) inside the window, then Undo", async () => {
    const c = await dwellAndPress("Backspace");
    await goHash("#/ohbox");
    expect(selectedRow(c), "the premise: Back left no row open").toBe("none");
    await clickUndo();
    await sleep(600);
    expect(selectedRow(c)).toBe("none");
    expect(where(c, "w8")).toBe(`${EARLIER}#0`);
    expect(heldRow()).not.toBe("w8");
    expect(deletes()).toEqual([]);
    expect(toastText()).toContain(messages.ohbox.deleteUndoneLeft);
    expect(toastText()).not.toContain(messages.ohbox.deleteUndone);
  }, 30000);

  it("NOT STUCK IN NEW: Park after an open, j twice, Undo, then j on read rows", async () => {
    const c = await dwellAndPress("e");
    await key("j"); await sleep(200);
    await key("j"); await sleep(200);
    await clickUndo();
    await sleep(600);
    for (let i = 0; i < 4; i++) { await key("j"); await sleep(250); }
    await sleep(800);
    expect(heldRow(), "the engine still holds the undone row").not.toBe("w8");
    expect(where(c, "w8")).toBe(`${EARLIER}#0`);
    expect(deletes()).toEqual([]);
  }, 30000);

  it("CONTROL: the delete window still runs out — exactly one delete when nobody undoes", async () => {
    const c = await dwellAndPress("Backspace");
    await goHash("#/ohbox/m/n3");
    await sleep(UNDO_MS + 500);
    expect(deletes()).toEqual([{ kind: "message_delete", messageId: "w8" }]);
    expect(rowIds(c)).not.toContain("w8");
  }, 30000);
});

describe("Undo restores the cursor only for a row its verb took and whose reversal took", () => {
  it("a deselection no verb caused (Back), then a set's Park of that row, Undo: the cursor stays put", async () => {
    const c = await shell(ORGANIZER_ROSTER);
    await act(async () => { c.querySelector<HTMLElement>('.row[data-id="w8"]')!.click(); });
    await sleep(2300);
    await key("x");
    await goHash("#/ohbox");
    expect(selectedRow(c), "the premise: Back left no row open").toBe("none");
    await key("e");
    await waitFor(() => !rowIds(c).includes("w8"), "the set's Park");
    await clickUndo();
    await sleep(600);
    expect(selectedRow(c)).toBe("none");
    expect(heldRow()).not.toBe("w8");
    expect(deletes()).toEqual([]);
  }, 30000);

  /* A guard for `settle`'s per-row verdict (watched red by mutation): the refused row must not
     be held, or it would stand in New the moment anything brought it back. */
  it("the open row's own reversal refused while another's took: no cursor on a row that is not there", async () => {
    const c = await shell(ORGANIZER_ROSTER);
    await act(async () => { c.querySelector<HTMLElement>('.row[data-id="n1"]')!.click(); });
    await key("x");
    await act(async () => { c.querySelector<HTMLElement>('.row[data-id="w8"]')!.click(); });
    await sleep(2300);
    await key("x");
    expect(selectedRow(c), "the premise: the cursor is on w8").toBe("w8");
    expect(heldRow(), "the premise: w8 is read and held").toBe("w8");
    await key("e");
    await waitFor(() => !rowIds(c).includes("w8") && !rowIds(c).includes("n1"), "the set's Park");
    refuseWhen = (m) => m.kind === "triage_set" && (m as { messageId?: string }).messageId === "w8";
    await clickUndo();
    await sleep(800);
    expect(rowIds(c), "the other row's reversal").toContain("n1");
    expect(rowIds(c), "w8's reversal was refused").not.toContain("w8");
    expect(selectedRow(c)).not.toBe("w8");
    expect(heldRow()).not.toBe("w8");
    expect(deletes()).toEqual([]);
  }, 30000);

  it("CONTROL: a set's Park of the open row, undone at once: back in New, selected", async () => {
    const c = await shell(ORGANIZER_ROSTER);
    await act(async () => { c.querySelector<HTMLElement>('.row[data-id="w8"]')!.click(); });
    await sleep(2300);
    await key("x");
    await key("e");
    await waitFor(() => !rowIds(c).includes("w8"), "the set's Park");
    await clickUndo();
    await sleep(600);
    expect(where(c, "w8")).toBe(`${NEW}#0`);
    expect(selectedRow(c)).toBe("w8");
    expect(deletes()).toEqual([]);
  }, 30000);
});

