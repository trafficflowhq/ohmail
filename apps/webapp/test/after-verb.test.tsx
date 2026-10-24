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
 * the marker is the whole difference. The pure order walk (`nextSurvivor`) is pinned by unit
 * arms beside the journeys.
 */
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
import type { MailboxFacts } from "../app/shell/mail-state";
import {
  AFTER_VERB_STORAGE_KEY,
  DEFAULT_AFTER_VERB,
  nextSurvivor,
  readAfterVerb,
} from "../app/shell/after-verb";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;

beforeEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
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
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  window.localStorage.clear();
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

async function shell(): Promise<{ container: HTMLElement; store: MirrorStore }> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const store = await storeWith(["m1", "m2", "m3"]);
  const engine = engineOver(store);
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
  return { container, store };
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
  [...el.querySelectorAll(".row[data-id]")].map((r) => r.getAttribute("data-id") ?? "");

const selId = (el: HTMLElement): string | null =>
  el.querySelector(".view .row.sel")?.getAttribute("data-id") ?? null;

describe("nextSurvivor — the order walk", () => {
  const present = (ids: string[]) => new Set(ids);
  it("takes the row after the acted one", () => {
    expect(nextSurvivor(["a", "b", "c"], present(["b", "c"]), "a")).toBe("b");
  });
  it("skips rows that left in the same pass", () => {
    expect(nextSurvivor(["a", "b", "c"], present(["c"]), "a")).toBe("c");
  });
  it("falls back to the nearest row above at the list's end", () => {
    expect(nextSurvivor(["a", "b", "c"], present(["a", "b"]), "c")).toBe("b");
  });
  it("answers null for the only row, and for an unknown id", () => {
    expect(nextSurvivor(["a"], present([]), "a")).toBeNull();
    expect(nextSurvivor(["a", "b"], present(["a", "b"]), "x")).toBeNull();
  });
});

describe("the stored choice", () => {
  it("defaults to advance, and refuses a foreign value", () => {
    expect(DEFAULT_AFTER_VERB).toBe("advance");
    expect(readAfterVerb()).toBe("advance");
    window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, "sideways");
    expect(readAfterVerb()).toBe("advance");
    window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, "close");
    expect(readAfterVerb()).toBe("close");
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
    expect(container.textContent).toContain("Nothing open.");
  });

  it("a removal MY verb did not cause moves nothing — the marker is the difference", async () => {
    const { container, store } = await shell();
    await key("j");
    await waitFor(() => selId(container) != null, "the cursor to stand");
    const first = selId(container)!;
    // Another device's work arrives through the sync feed: the selected row is deleted with no
    // verb pressed here. The pane must rest, never pick a message nobody asked for.
    await act(async () => {
      await store.applyChanges([
        { type: "message", op: "delete", id: first, seq: ++seq, updatedAt: NOW.toISOString(), entity: null },
      ] as SyncChange[]);
    });
    await waitFor(() => !rowIds(container).includes(first), "the row to leave with the drain");
    await settle();
    expect(selId(container)).toBeNull();
  });
});
