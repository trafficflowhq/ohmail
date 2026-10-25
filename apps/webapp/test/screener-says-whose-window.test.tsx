/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, consentPartition, presentationReader,
  type EngineMessage, type ScreenerWaitingWire, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import messagesDe from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";
import type { ShellConsentFacts } from "../app/shell/consent-options.js";

/**
 * A FOLDER-WHOLE COUNT SAYS WHY (RULING-026). Where a mailbox's organizer has published no window
 * (`unstated`) or none has been read (`unread`), the reader lists the Screener folder whole and the
 * head says so beside the count, naming the holder; with every window stated it says nothing more.
 * The harness is `screener-count-is-the-store.test.tsx`'s, with the view handed `screeningDegrade`.
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

type Door = "answers" | "refuses" | "none";

async function engineWith(door: Door, given?: MemoryMirrorStore): Promise<OhmailEngine> {
  const store = given ?? new MemoryMirrorStore();
  if (!given) {
    await store.load();
    await store.applyChanges([held("m0", "a@one.test"), held("m1", "b@one.test")].map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })));
  }
  return new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      ...(door === "none" ? {} : {
        screenerWaiting: async (p?: { cursor?: string }) => {
          if (door === "refuses") throw new Error("offline");
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

/** The shell's lists over the mirror: the store, and the consent facts the partition reads. */
interface Over { store: MemoryMirrorStore; consent: ShellConsentFacts }

async function mount(door: Door, degrade: unknown = null, locale = "en", over?: Over): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const { shellConsentOptions } = await import("../app/shell/consent-options.js");
  const engine = await engineWith(door, over?.store);
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const read = engine.read();
    const presented = over ? presentationReader(read, consentPartition(read, shellConsentOptions(over.consent, NOW, []))) : undefined;
    const state = useScreenerState(engine, v, (() => {}) as never, undefined, presented);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {}, screeningDegrade: degrade,
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? messagesDe : messages, timeZone: "UTC", now: NOW,
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

describe("the Screener head says why its count is the folder whole", () => {
  it("unstated, naming the holder", async () => {
    await mount("answers", { state: "unstated", holderName: "Studio Mac" });
    expect(text()).toContain("250 first-time senders waiting. Studio Mac runs an older ohmail that doesn’t share its screening window — showing everyone in the Screener folder.");
  });

  it("unread, naming the holder", async () => {
    await mount("answers", { state: "unread", holderName: "Studio Mac" });
    expect(text()).toContain("Showing everyone in the Screener folder — Studio Mac’s screening settings haven’t been read yet.");
  });

  it("with no name for the holder, the organizing device", async () => {
    await mount("answers", { state: "unread", holderName: null });
    expect(text()).toContain("the organizing device’s screening settings haven’t been read yet.");
  });

  it("in German", async () => {
    await mount("answers", { state: "unstated", holderName: "Studio Mac" }, "de");
    expect(text()).toContain("Auf Studio Mac läuft eine ältere ohmail-Version");
  });

  it("CONTROL: every window stated — the count alone", async () => {
    await mount("answers", null);
    expect(text()).toContain("250 first-time senders waiting");
    expect(text()).not.toContain("Showing everyone");
    expect(text()).not.toContain("showing everyone");
  });
});

describe("the shell partitions with each mailbox's window, and never whose it is", () => {
  it("shellConsentOptions carries the map's windows alone; no map, no key", async () => {
    const { shellConsentOptions } = await import("../app/shell/consent-options.js");
    const base = {
      known: true, standalone: false, dormancyDays: 60, screeningBaselineAt: null,
      screeningScope: "window" as const, foldersEnabled: false,
    };
    const withMap = shellConsentOptions({
      ...base,
      screeningByMailbox: { mb: { baselineAt: null, dormancyDays: 30, scope: "window", source: "organizer", holderName: "Studio Mac" } },
    }, NOW, []);
    expect(withMap.byMailbox).toEqual({ mb: { baselineAt: null, dormancyDays: 30, scope: "window" } });
    expect("byMailbox" in shellConsentOptions({ ...base, screeningByMailbox: null }, NOW, [])).toBe(false);
  });
});

describe("a held letter is dated by its arrival, as the gate dated it", () => {
  it("an old Date received now waits, read or unread; one received before the window does not; a remount says the same", async () => {
    const { writeBootCache, readBootCache } = await import("../app/shell/boot-cache.js");
    const { CONSENT_BOOT_SCOPE } = await import("../app/shell/consent-state.js");
    const JUNE = "2026-06-02T09:00:00.000Z";
    const letter = (id: string, from: string, unread: boolean, sortAt: string): EngineMessage =>
      ({ ...held(id, from), date: JUNE, unread, sortAt });
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      letter("u1", "udo@arrived.test", true, "2026-09-26T08:30:00.000Z"),
      letter("o1", "olga@arrived.test", false, "2026-09-26T08:30:00.000Z"),
      letter("j1", "june@received.test", true, JUNE),
    ].map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
    // The account's answer as the boot cache holds it: 60 days from a baseline of 1 September.
    writeBootCache(CONSENT_BOOT_SCOPE, "acct", { v: 1, seedConfirmedAt: null, dormancyDays: 60, screeningBaselineAt: "2026-09-01T00:00:00.000Z" });
    const consent = (): ShellConsentFacts => {
      const c = readBootCache(CONSENT_BOOT_SCOPE, "acct", (p) => p as { dormancyDays: number; screeningBaselineAt: string | null })!;
      return { known: true, standalone: false, dormancyDays: c.dormancyDays, screeningBaselineAt: c.screeningBaselineAt,
        screeningScope: "window", foldersEnabled: false, screeningByMailbox: null };
    };
    for (const pass of ["first", "remount"]) {
      await mount("none", null, "en", { store, consent: consent() });
      expect(text(), pass).toContain("udo@arrived.test");
      expect(text(), pass).toContain("olga@arrived.test");
      expect(text(), pass).not.toContain("june@received.test");
      await act(async () => { root!.unmount(); });
      host?.remove();
      root = null;
    }
  });
});
