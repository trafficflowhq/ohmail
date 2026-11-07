/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type EngineMessage, type ScreenerWaitingWire, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE SCREENER STATES THE STORE'S COUNT, AND SAYS WHEN IT CANNOT. The mirror here holds two of the
 * queue's senders; the store counts 250. The meta and the segment say 250, a press on the tail
 * fetches the next page, and a door that cannot answer is named as this device's own count.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

const NOW = new Date("2026-09-26T09:00:00.000Z");
let seq = 0;

function held(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-26T08:00:00.000Z", folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-26T08:00:00.000Z",
  };
}

const FIRST: ScreenerWaitingWire = {
  items: [held("m0", "a@one.test"), held("m1", "b@one.test")].map((m) => ({
    messageId: m.id, address: m.from.address, name: null, receivedAt: m.date!, subject: m.subject, snippet: m.snippet, mailboxId: "mb",
  })),
  nextCursor: "n", total: 250, inFlight: [],
};
const ONWARD: ScreenerWaitingWire = {
  items: [{ messageId: "far", address: "far@away.test", name: "Far", receivedAt: "2026-01-01T08:00:00.000Z", subject: "An old note", snippet: "old", mailboxId: "mb" }],
  nextCursor: null, total: null, inFlight: [],
};

type Door = "answers" | "refuses" | "none" | "empty-later";
/** Opens the "empty-later" door: the store answers that nobody waits, once released. */
let releaseDoor: () => void = () => {};
/** Every render's waiting count and rows, as the Ohbox strip and the rail would read them. */
let seen: string[] = [];

async function engineWith(door: Door): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([held("m0", "a@one.test"), held("m1", "b@one.test")].map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      ...(door === "none" ? {} : {
        screenerWaiting: async (p?: { cursor?: string }) => {
          if (door === "refuses") throw new Error("offline");
          if (door === "empty-later") {
            await new Promise<void>((r) => { releaseDoor = r; });
            return { items: [], nextCursor: null, total: 0, inFlight: [] };
          }
          return p?.cursor ? ONWARD : FIRST;
        },
      }),
    } as never,
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

async function mount(door: Door): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const engine = await engineWith(door);
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, (() => {}) as never);
    seen.push(`${state.waitingCount}:${state.waiting.map((w) => w.from.address).join(",")}`);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: state.queueSettled, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
    }));
  });
  await flush();
  await settleFirstPaint();
  await flush();
}

const text = (): string => host!.textContent ?? "";
const button = (label: string): HTMLElement => {
  const hits = [...host!.querySelectorAll<HTMLElement>("button")].filter((b) => (b.textContent ?? "").trim() === label);
  if (hits.length !== 1) throw new Error(`${hits.length} buttons read "${label}"`);
  return hits[0]!;
};

describe("the Screener's count is the store's", () => {
  it("states the store's total over a mirror that holds two of its senders, and pages onward", async () => {
    await mount("answers");
    expect(text()).toContain("250 first-time senders waiting");
    expect(text()).not.toContain("counted on this device");
    expect(text()).not.toContain("far@away.test");
    await act(async () => { button("Show more senders").click(); });
    await flush();
    expect(text(), "the next page's sender is not on screen").toContain("Far");
    expect(host!.querySelectorAll("button").length).toBeGreaterThan(0);
    expect([...host!.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Show more senders")).toBe(false);
  });

  it("names the count as this device's own while the store has not answered", async () => {
    await mount("refuses");
    expect(text()).toContain("2 first-time senders waiting, counted on this device");
  });

  it("never states the device's own senders while the store's first answer is on its way", async () => {
    seen = [];
    await mount("empty-later");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => s !== "0:"), "a count or a row before the store answered").toEqual([]);
    expect(text()).not.toContain("No one’s waiting.");
    await act(async () => { releaseDoor(); });
    await flush();
    expect(seen.filter((s) => s !== "0:"), "a count or a row the store does not hold").toEqual([]);
    expect(text()).toContain("No one’s waiting.");
  });

  it("a client with no store keeps the plain sentence", async () => {
    await mount("none");
    expect(text()).toContain("2 first-time senders waiting");
    expect(text()).not.toContain("counted on this device");
  });
});
