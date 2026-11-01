/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncResponse,
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";

/**
 * DURING A FIRST SYNC THE RESULT LINE SAYS WHAT IT SEARCHED. The store's answers
 * below are the search route's own shape over a store mid-import (`importing: true`, the route
 * half is `packages/client-engine/test/search-first-sync.test.ts`): the line says "the mail synced
 * so far", the next sentence says the rest is not in, and the closest-words hint is scoped. The
 * same answers without the field are the complete-store control, word for word as before.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-26T16:42:00.000Z");

function letter(i: number, subject: string): EngineMessage {
  return {
    id: `m${i}`, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject,
    from: { name: "Shop", address: `shop${i}@example.test` }, to: [], cc: [],
    date: new Date(NOW.getTime() - i * 3_600_000).toISOString(), folder: "INBOX",
    snippet: subject, unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/** The route's answers by part; `importing` is added to every part when the store is mid-import. */
function adapterOver(parts: Record<string, Record<string, unknown>>, importing: boolean): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (_q: string, o: { parts?: string }) => {
      const wire = parts[o.parts ?? "both"] ?? parts.page!;
      return importing ? { ...wire, importing: true } : wire;
    },
  } as unknown as EngineAdapter;
}

const EXACT = {
  page: { items: [letter(0, "invoice 74600")], total: 1, totalExact: true, tier: "exact", ms: 22 },
  estimate: { items: [], total: 1, totalExact: true, tier: "exact", ms: 3, facets: { folder: { INBOX: 1 }, sender: [], unread: { true: 0, false: 1 }, hasAttachments: { true: 0, false: 1 }, date: { today: 1, last7: 0, last30: 0, older: 0 } } },
};
const CLOSEST = {
  page: { items: [1, 2, 3].map((i) => letter(i, `delivery windows ${2050 + i}`)), total: 3, totalExact: false, tier: "similar", ms: 50 },
  estimate: { items: [], total: 2526, totalExact: true, tier: "similar", ms: 9, facets: { folder: { INBOX: 2526 }, sender: [], unread: { true: 0, false: 2526 }, hasAttachments: { true: 0, false: 2526 }, date: { today: 0, last7: 0, last30: 0, older: 2526 } } },
};
const NOTHING = {
  page: { items: [], total: 0, totalExact: true, tier: "exact", ms: 12 },
  estimate: { items: [], total: 0, totalExact: true, tier: "exact", ms: 2 },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function said(query: string, parts: Record<string, Record<string, unknown>>, importing: boolean, locale: "en" | "de" = "en"): Promise<string> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: adapterOver(parts, importing), store, now: () => NOW });
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : messages, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, {
        children: h(SearchView, { engine, version: 1, now: NOW, query, onQuery: () => {}, onOpen: () => {} }),
      }),
    }));
  });
  // Past the hold: a typed question's count is asked once it has stood.
  await act(async () => { await new Promise((r) => setTimeout(r, STORE_SEARCH_FOLLOWUP_HOLD_MS + 70)); });
  return (host.textContent ?? "").replace(/\s+/g, " ");
}

const REST = "The rest of your mail has not synced yet.";
const syncing = (): Element | null => host.querySelector('[data-testid="search-syncing"]');

describe("mid-import, the result line states the scope it searched", () => {
  it("an exact match: the mail synced so far, and the rest not in", async () => {
    const text = await said("invoice 74600", EXACT, true);
    expect(text).toContain("Searched the mail synced so far — 1 matched · ");
    expect(syncing()?.textContent?.trim()).toBe(REST);
    expect(text).not.toContain("whole mailbox");
  });

  it("the closest words never claim nothing matched over a store still coming in", async () => {
    const text = await said("delivery window 2059", CLOSEST, true);
    expect(text).toContain("Searched the mail synced so far — 2,526 with a close word · ");
    expect(syncing()?.textContent?.trim()).toBe(REST);
    expect(host.querySelector('[data-similar="head"]')?.textContent).toBe(
      `Similar Nothing synced so far matched exactly, so these are the closest words. ${messages.search.partReach}`);
    expect(text).not.toContain("whole mailbox");
  });

  it("nothing at all: the empty state says what it searched", async () => {
    const text = await said("zqxjvwk", NOTHING, true);
    expect(host.querySelector(".empty")?.textContent ?? "").toContain("Searched the mail synced so far — nothing matched · ");
    expect(syncing()?.textContent?.trim()).toBe(REST);
    expect(text).not.toContain("whole mailbox");
  });
});

describe("the complete-store control: the same answers without the field read as they always did", () => {
  it.each([
    ["an exact match", "invoice 74600", EXACT, "Searched your whole mailbox — 1 matched · "],
    ["the closest words", "delivery window 2059", CLOSEST, "Searched your whole mailbox — 2,526 with a close word · "],
    ["nothing at all", "zqxjvwk", NOTHING, "Searched your whole mailbox — nothing matched · "],
  ] as const)("%s", async (_arm, query, parts, line) => {
    const text = await said(query, parts, false);
    expect(text).toContain(line);
    expect(syncing()).toBeNull();
    expect(text).not.toContain("synced so far");
    if (parts === CLOSEST) {
      expect(host.querySelector('[data-similar="head"]')?.textContent).toBe(
        `Similar Nothing matched exactly, so these are the closest words. ${messages.search.partReach}`);
    }
  });
});

/** A page cut at the count's cap whose estimate names no number: the line keeps its lower bound. */
const CUT = {
  page: { items: [letter(0, "invoice 74600")], total: 2_000, totalExact: false, tier: "exact", ms: 22 },
  estimate: { items: [], total: 2_000, totalExact: false, tier: "exact", ms: 3 },
};
const MIRROR = { page: { ...CUT.page, answeredFrom: "mirror" }, estimate: { ...CUT.estimate, answeredFrom: "mirror" } };

describe("a count at its cap is grouped as every other count", () => {
  it.each([
    ["en whole", "en", CUT, false, "Searched your whole mailbox — at least 2,000 matched · "],
    ["en synced", "en", CUT, true, "Searched the mail synced so far — at least 2,000 matched · "],
    ["en mirror", "en", MIRROR, false, "Search covers the mail on this computer while ohmail Cloud is unreachable — at least 2,000 matched · "],
    ["de whole", "de", CUT, false, "Dein ganzes Postfach wurde durchsucht — mindestens 2.000 gefunden · "],
    ["de synced", "de", CUT, true, "Bisher synchronisierte Mails durchsucht: mindestens 2.000 gefunden · "],
    ["de mirror", "de", MIRROR, false, "Durchsucht werden die Mails auf diesem Computer, solange ohmail Cloud nicht erreichbar ist: mindestens 2.000 gefunden · "],
  ] as const)("%s", async (_arm, locale, parts, importing, line) => {
    expect(await said("invoice 74600", parts, importing, locale)).toContain(line);
  });
});

describe("the sentences exist in both catalogues", () => {
  it("every key is in en and de", () => {
    for (const m of [messages, de]) {
      const search = m.search as Record<string, string>;
      for (const key of ["scopeSynced", "scopeSyncedAtLeast", "scopeSyncedAbout", "syncing", "similarHintSynced"]) {
        expect(search[key], key).toBeTypeOf("string");
      }
    }
  });
});
