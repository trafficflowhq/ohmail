/** @vitest-environment jsdom */
/**
 * ═══ AFTER A VERB, THE PANE ADVANCES (setting: advance / stay / close) ═══
 *
 * Triage is the core loop, and every verb used to drop the reading column to "Nothing open." —
 * a re-pick per verb. The shipped shell is mounted over a real engine (delete-key-shell's
 * harness shape) and a real key is pressed, because every way this could be half-wired
 * compiles: a marker never written, an effect keyed to the wrong list, a choice read once at
 * mount. What is pinned: the DEFAULT advances to the next row; `close` clears the selection;
 * a removal the person did NOT cause (a drain applying another device's work) moves nothing —
 * the marker is the whole difference. The pure row walk (`nextRowAfter`) is pinned by unit
 * arms beside the journeys.
 */
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
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import {
  AFTER_VERB_STORAGE_KEY,
  DEFAULT_AFTER_VERB,
  nextRowAfter,
  readAfterVerb,
} from "@ohmail/app-logic/press/after-verb";
import { blankSays, cursorRow, openLetter, pickedRows, seatedList } from "./ohbox/_finders.js";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** What the next `/sync` page carries: another device's work, applied by the engine's own drain. */
let pending: SyncChange[] = [];

/* The account the shell is mounted for, named before it mounts: its views read the choice kept beside it. */
const SHELL_OWNER = "acc-after-verb";

beforeEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
  setStorageOwner(SHELL_OWNER);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false, // desktop: the reading column is standing
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
  pending = [];
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetStorageOwnerForTest();
});

const address = (id: string): string => `p${id}@example.invalid`;

/** A message; thread, date, folder and sender default to a lone, read INBOX letter of the day before. */
type Spec = { id: string; thread?: string; date?: string; folder?: string; from?: string; unread?: boolean };

const msg = (s: Spec): EngineMessage => ({
  id: s.id, accountId: "a1", mailboxId: "mb1", threadId: s.thread ?? `t-${s.id}`, folder: s.folder ?? "INBOX",
  subject: `Subject ${s.thread ?? s.id}`, from: { address: s.from ?? address(s.id), name: `Person ${s.id}` },
  to: [], cc: [], date: s.date ?? "2026-09-03T09:00:00.000Z", unread: s.unread ?? false,
  labels: [],
  updatedAt: s.date ?? "2026-09-03T09:00:00.000Z",
} as unknown as EngineMessage);

async function storeWith(specs: (string | Spec)[], older: EngineMessage[] = []): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const spec of specs) {
    const m = msg(typeof spec === "string" ? { id: spec } : spec);
    const from = (m.from as { address: string }).address;
    await store.applyChanges([
      { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
      ...(m.folder === "INBOX" ? [{
        type: "rule", op: "create", id: `r-${m.id}`, seq: ++seq, updatedAt: m.updatedAt,
        entity: {
          id: `r-${m.id}`, kind: "sender", match: from,
          destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z",
        },
      }] : []),
    ] as SyncChange[]);
  }
  for (const m of older) {
    const from = (m.from as { address: string }).address;
    await store.applyChanges([{
      type: "rule", op: "create", id: `r-${m.id}`, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { id: `r-${m.id}`, kind: "sender", match: from, destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z" },
    }] as SyncChange[]);
  }
  return store;
}

/** `older`: mail the server holds past the mirror window, offered through Load older. */
function engineOver(store: MirrorStore, older: EngineMessage[] = []): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const page = pending;
        pending = [];
        return {
          changes: { creates: [], updates: [], moves: [], deletes: page },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
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
      ...(older.length > 0 ? {
        timeline: async () => ({
          total: 99, undated: 0,
          months: [{ month: (older[0]!.date ?? "").slice(0, 7), count: older.length, first: { date: older[0]!.date, id: older[0]!.id } }],
        }),
        listMessages: async () => ({ items: older, nextCursor: null }),
      } : {}),
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

/** `scope`: the account the host hands the shell; left out, the storage owner the file named. */
async function shell(
  specs: (string | Spec)[] = ["m1", "m2", "m3"], older: EngineMessage[] = [], scope?: string,
): Promise<{ container: HTMLElement; store: MirrorStore; engine: OhmailEngine }> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const store = await storeWith(specs, older);
  const engine = engineOver(store, older);
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
            ...(scope === undefined ? {} : { scope }),
            demo: false,
            engine,
            mailboxFacts: async () => ROSTER,
          } as never),
        }),
      }),
    }));
  });
  await waitFor(() => rowIds(container).length > 0, "rows in the Ohbox");
  return { container, store, engine };
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
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
  [...el.querySelectorAll(":is(.row, [role=option])[data-id]")].map((r) => r.getAttribute("data-id") ?? "");

const selId = (el: HTMLElement): string | null =>
  cursorRow(el)?.getAttribute("data-id") ?? null;

describe("nextRowAfter — the row walk", () => {
  const standing = (keys: string[]) => new Set(keys);
  const rows = (...keys: string[]) => keys.map((k) => ({ key: k, members: [{ id: k }] }));
  it("takes the row below the acted one", () => {
    expect(nextRowAfter(rows("a", "b", "c"), standing(["b", "c"]), "a")).toBe("b");
  });
  it("skips rows that left in the same pass", () => {
    expect(nextRowAfter(rows("a", "b", "c"), standing(["c"]), "a")).toBe("c");
  });
  it("falls back to the nearest row above at the list's end", () => {
    expect(nextRowAfter(rows("a", "b", "c"), standing(["a", "b"]), "c")).toBe("b");
  });
  it("answers null for the only row, and for an id in no row", () => {
    expect(nextRowAfter(rows("a"), standing([]), "a")).toBeNull();
    expect(nextRowAfter(rows("a", "b"), standing(["a", "b"]), "x")).toBeNull();
  });
  it("finds the acted row through a member that does not lead it, and never lands on its rest", () => {
    const before = [
      { key: "t-c", members: [{ id: "s" }, { id: "a" }] },
      ...rows("b2", "b3"),
      { key: "t-x", members: [{ id: "x" }] },
    ];
    expect(nextRowAfter(before, standing(["t-c", "b2", "b3", "t-x"]), "a")).toBe("b2");
  });
});

describe("the stored choice", () => {
  it("defaults to advance, and refuses a foreign value", () => {
    expect(DEFAULT_AFTER_VERB).toBe("advance");
    expect(readAfterVerb(null)).toBe("advance");
    window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, "sideways");
    expect(readAfterVerb(null)).toBe("advance");
    window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, "close");
    expect(readAfterVerb(null)).toBe("close");
  });
});

describe("after a verb, on the shipped shell", () => {
  it("the default ADVANCES: delete on the open row selects the next one", async () => {
    const { container } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(first), "the acted row to leave");
    await waitFor(() => selId(container) != null && selId(container) !== first,
      "the selection to advance");
    // The pane did not rest: the reading column shows the advanced-to message.
    expect(container.textContent).not.toContain("Nothing open.");
  });

  for (const [verb, k] of [["Park", "e"], ["Later", "a"]] as const) {
    it(`the default ADVANCES after ${verb} (${k}) on the open row too`, async () => {
      const { container } = await shell();
      await key("j");
      await waitFor(() => selId(container) != null, "the cursor to stand");
      const first = selId(container)!;
      await key(k);
      await waitFor(() => !rowIds(container).includes(first), "the acted row to leave");
      await waitFor(() => selId(container) != null && selId(container) !== first, "the selection to advance");
      await settle();
      expect(selId(container)).not.toBe(first);
      expect(selId(container)).not.toBeNull();
      expect(container.textContent).not.toContain("Nothing open.");
    });
  }

  /* Our reply today puts the conversation at the top of Earlier; its open target is their letter
     of yesterday, whose own slot is 8 rows down. The cursor must take the row below, not that slot. */
  const yesterday = (hh: number): string => `2026-09-03T${String(hh).padStart(2, "0")}:00:00.000Z`;
  const answered: Spec[] = [
    { id: "s", thread: "t-c", folder: "Sent", from: "me@example.com", date: "2026-09-04T08:00:00.000Z" },
    { id: "a", thread: "t-c", from: "c@example.com", date: yesterday(13) },
    ...[2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `b${n}`, from: `p${n}@example.com`, date: yesterday(22 - n) })),
    { id: "b9", from: "p9@example.com", date: yesterday(12) },
  ];
  for (const k of ["b", "e", "a", "Backspace"] as const) {
    it(`after ${k} on a conversation row led by our reply, the cursor takes the row below`, async () => {
      const { container } = await shell(answered);
      await key("j");
      await waitFor(() => selId(container) === "a", "the cursor on the conversation's letter");
      await key(k);
      await waitFor(() => selId(container) != null && selId(container) !== "a", "the selection to advance");
      await settle();
      expect(selId(container)).toBe("b2");
      expect(console.error).not.toHaveBeenCalled();
    });
  }

  it("a bulk delete over the open row ADVANCES as a single delete does, and never says 'elsewhere'", async () => {
    const { container } = await shell(["m1", "m2", "m3", "m4"]);
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "J", shiftKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => pickedRows(container).length >= 2, "two rows picked");
    const picked = pickedRows(container).map((r) => r.getAttribute("data-id"));
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(first), "the picked rows to leave");
    await waitFor(() => selId(container) != null, "the selection to advance");
    await settle();
    expect(picked).toContain(first);
    expect(picked).not.toContain(selId(container));
    expect(container.textContent).not.toContain(messages.reader.gone);
    expect(container.textContent).not.toContain("Nothing open.");
  });

  it("`close` clears the selection back to the list", async () => {
    window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, "close");
    const { container } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(first), "the acted row to leave");
    await settle();
    expect(selId(container)).toBeNull();
    /* PARITY L19, DECLARED (RULING-JOIN J-3): the resting column says the list's blank, not "Nothing open.": nothing is
       open and the column says so. */
    expect(openLetter(container)).toBeNull();
    expect(blankSays(container), "the column does not rest").not.toBeNull();
  });

  /* The choice obeyed is the one kept for the shell's own account: its host hands it one account while the storage
     owner names another (another tab signed in as somebody else), whose own choice is to advance. */
  it("obeys the choice kept for the account its host hands it, whatever the storage owner names", async () => {
    const other = "acc-another-tab";
    window.localStorage.setItem(`${AFTER_VERB_STORAGE_KEY}:${SHELL_OWNER}`, "close");
    window.localStorage.setItem(`${AFTER_VERB_STORAGE_KEY}:${other}`, "advance");
    setStorageOwner(other);
    const { container } = await shell(["m1", "m2", "m3"], [], SHELL_OWNER);
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    await key("Backspace");
    await waitFor(() => !rowIds(container).includes(first), "the acted row to leave");
    await settle();
    expect(selId(container)).toBeNull();
    /* PARITY L19, DECLARED (RULING-JOIN J-3): the resting column says the list's blank, not "Nothing open.": nothing is
       open and the column says so. */
    expect(openLetter(container)).toBeNull();
    expect(blankSays(container), "the column does not rest").not.toBeNull();
  });

  it("a removal MY verb did not cause moves nothing — the marker is the difference", async () => {
    const { container, engine } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    // Another device's work arrives through the sync feed: the selected row is deleted with no
    // verb pressed here. The pane must rest, never pick a message nobody asked for.
    // Through the drain, which notifies; a bare store write showed only at the 8 s poll.
    pending = [{ type: "message", op: "delete", id: first, seq: ++seq, updatedAt: NOW.toISOString(), entity: null } as SyncChange];
    await act(async () => { await engine.syncOnce(); });
    await waitFor(() => !rowIds(container).includes(first), "the row to leave with the drain");
    await settle();
    expect(selId(container)).toBeNull();
  });
});

describe("the keyboard ring stays on the row the verbs act on", () => {
  /* A key pressed where focus is, as a person's key is: on the focused row, bubbling to the keymap. */
  const press = async (k: string): Promise<void> => {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
  };
  const ringId = (): string | null => (document.activeElement as HTMLElement | null)?.closest?.(":is(.row, [role=option])")?.getAttribute("data-id") ?? null;
  const focusCursor = async (el: HTMLElement): Promise<void> => {
    await act(async () => { cursorRow(el)!.focus(); });
  };

  it("u moves the row up under New, and the ring goes with it, not to the row that slid into its place", async () => {
    const { container } = await shell();
    await key("j");
    await key("j");
    await waitFor(() => selId(container) === "m2", "the cursor on the middle row");
    await focusCursor(container);
    await press("u");
    await waitFor(() => rowIds(container)[0] === "m2", "the row to move up under New");
    await settle();
    expect(selId(container)).toBe("m2");
    expect(ringId()).toBe("m2");
  });

  it("a verb that leaves no cursor leaves no ring on a row either: focus stands on the list", async () => {
    window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, "close");
    const { container } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    await focusCursor(container);
    await press("a");
    await waitFor(() => !rowIds(container).includes(first), "the acted row to leave");
    await settle();
    expect(selId(container)).toBeNull();
    expect(ringId()).toBeNull();
    expect(document.activeElement).toBe(seatedList(container)?.querySelector(".ob-scroll"));
    // j from the list takes the cursor, and the ring with it.
    await press("j");
    await waitFor(() => selId(container) != null, "j to take the cursor");
    expect(ringId()).toBe(selId(container));
  });

  it("after the default advance the ring is on the advanced-to row", async () => {
    const { container } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    await focusCursor(container);
    await press("e");
    await waitFor(() => selId(container) != null && selId(container) !== first, "the selection to advance");
    await settle();
    expect(ringId()).toBe(selId(container));
  });

  /* A layer opened from a control in the list's column gives the keyboard back to that control when it closes. */
  const named = (role: string, name: string): HTMLElement => {
    const all = [...document.querySelectorAll<HTMLElement>(role === "button" ? "button" : `[role=${role}]`)];
    const el = all.find((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().startsWith(name));
    if (!el) throw new Error(`no ${role} named ${name}`);
    return el;
  };
  const pressOn = async (el: HTMLElement): Promise<void> => {
    await act(async () => { el.focus(); el.click(); });
    await settle();
  };
  const escape = async (): Promise<void> => {
    await press("Escape");
    await settle();
  };

  it("the list's menu, closed with Escape or by a choice, gives the keyboard back to its button", async () => {
    await shell([{ id: "m1", unread: true }, "m2", "m3"]);
    const button = named("button", "Ohbox actions");
    await pressOn(button);
    expect(document.activeElement?.closest("[role=menu]"), "the menu took the keyboard").not.toBeNull();
    await escape();
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(button);
    await pressOn(button);
    await pressOn(named("menuitem", "Mark all read"));
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("the selection's More, closed with Escape or by a choice, gives the keyboard back to More", async () => {
    const { container } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    await focusCursor(container);
    await press("x");
    const more = named("button", "More");
    await pressOn(more);
    expect(document.activeElement?.closest("[role=menu]"), "More took the keyboard").not.toBeNull();
    await escape();
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(more);
    await pressOn(more);
    await pressOn(named("menuitem", "Delete"));
    await pressOn(named("menuitem", "Cancel"));
    expect(document.querySelector("[role=menu], [role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  /* An ask opened from a menu on the selection's foot, by keys alone: the case reaches the bar's control as Tab does,
     then focuses nothing. Enter presses what holds the keyboard (jsdom does not turn the key into the press). */
  const enter = async (): Promise<void> => {
    await press("Enter");
    await act(async () => { (document.activeElement as HTMLElement).click(); });
    await settle();
  };
  const holder = (): Element | null => document.activeElement;
  const pickTheCursor = async (): Promise<{ container: HTMLElement; first: string }> => {
    const { container } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    await focusCursor(container);
    await press("x");
    await settle();
    return { container, first: selId(container)! };
  };
  const tabTo = async (el: HTMLElement): Promise<void> => {
    await act(async () => { el.focus(); });
  };
  const noLayer = (): Element | null => document.querySelector("[role=menu], [role=dialog]");

  it("the delete ask opened from More holds the keyboard; ArrowDown then Enter deletes, and the row takes it", async () => {
    const { container, first } = await pickTheCursor();
    await tabTo(named("button", "More"));
    await enter();
    expect(holder()?.closest("[role=menu]"), "More's menu took the keyboard").not.toBeNull();
    await enter();
    expect(document.querySelector("[role=dialog]"), "the delete ask stands").not.toBeNull();
    expect(holder(), "the ask holds the keyboard on its first control").toBe(named("menuitem", "Cancel"));
    await press("ArrowDown");
    await enter();
    await waitFor(() => !rowIds(container).includes(first), "the picked row to leave");
    await settle();
    expect(noLayer()).toBeNull();
    expect(selId(container), "a cursor stands").not.toBeNull();
    expect(ringId(), "the keyboard on the cursor's row").toBe(selId(container));
  });

  it("the delete ask opened from More, cancelled or escaped, gives the keyboard back to More", async () => {
    const { container, first } = await pickTheCursor();
    const more = named("button", "More");
    await tabTo(more);
    await enter();
    await enter();
    expect(holder(), "the ask holds the keyboard on its first control").toBe(named("menuitem", "Cancel"));
    await enter();
    expect(noLayer()).toBeNull();
    expect(holder(), "cancelled: the keyboard on More").toBe(more);
    await enter();
    await enter();
    expect(holder()?.closest("[role=dialog]"), "the ask again, by keys alone").not.toBeNull();
    await escape();
    expect(noLayer()).toBeNull();
    expect(holder(), "escaped: the keyboard on More").toBe(more);
    expect(rowIds(container)).toContain(first);
  });

  it("Screening's ask opened from a place holds the keyboard; ArrowDown then Enter screens, and the list takes it", async () => {
    const { container, first } = await pickTheCursor();
    await tabTo(named("button", "Screening"));
    await enter();
    expect(holder()?.closest("[role=dialog]"), "the places took the keyboard").not.toBeNull();
    await press("ArrowDown");
    await enter();
    expect(document.querySelector("[role=dialog]")?.getAttribute("aria-label"), "Screening's ask stands").toBe("Screening");
    expect(holder(), "the ask holds the keyboard on its first control").toBe(named("menuitem", "Cancel"));
    await press("ArrowDown");
    await enter();
    await waitFor(() => !rowIds(container).includes(first), "the screened row to leave");
    await settle();
    expect(noLayer()).toBeNull();
    /* Screening moves no cursor on: the keyboard is on the cursor's row where one stands, else on the list. */
    const list = cursorRow(container)
      ?? seatedList(container)?.querySelector(".ob-scroll");
    expect(list, "the list stands").not.toBeNull();
    expect(holder(), "the keyboard back in the list").toBe(list);
  });

  it("Screening's ask, cancelled or escaped, gives the keyboard back to Screening", async () => {
    const { container, first } = await pickTheCursor();
    const screening = named("button", "Screening");
    await tabTo(screening);
    await enter();
    await press("ArrowDown");
    await enter();
    expect(holder(), "the ask holds the keyboard on its first control").toBe(named("menuitem", "Cancel"));
    await enter();
    expect(noLayer()).toBeNull();
    expect(holder(), "cancelled: the keyboard on Screening").toBe(screening);
    await enter();
    await press("ArrowDown");
    await enter();
    expect(holder()?.closest("[role=dialog]"), "the ask again, by keys alone").not.toBeNull();
    await escape();
    expect(noLayer()).toBeNull();
    expect(holder(), "escaped: the keyboard on Screening").toBe(screening);
    expect(rowIds(container)).toContain(first);
  });
});
