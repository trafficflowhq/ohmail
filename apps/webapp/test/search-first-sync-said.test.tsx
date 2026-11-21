/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { enterSearchRoute, RegisteredSearch, typeSearch } from "./search-registered-fixture";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncResponse,
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import de from "../messages/de.json";

/**
 * DURING A FIRST SYNC THE RESULT LINE SAYS WHAT IT SEARCHED. The store's answers
 * below are the search route's own shape over a store mid-import (`importing: true`, the route
 * half is `packages/client-engine/test/search-first-sync.test.ts`): the line says "the mail synced
 * so far", the next sentence says the rest is not in, and the closest-words hint is scoped. The
 * same answers without the field are the complete-store control, word for word as before.
 */
// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
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
let leaveSearch: () => void;
beforeEach(() => {
  window.localStorage.clear();
  leaveSearch = enterSearchRoute();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  leaveSearch();
});

async function said(query: string, parts: Record<string, Record<string, unknown>>, importing: boolean, locale: "en" | "de" = "en"): Promise<string> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: adapterOver(parts, importing), store, now: () => NOW });
  await act(async () => {
    root.render(<RegisteredSearch engine={engine} now={NOW} locale={locale} catalogue={locale === "de" ? de : messages} />);
  });
  await act(async () => { typeSearch(host, query); });
  // Past the hold: a typed question's count is asked once it has stood.
  await act(async () => { await new Promise((r) => setTimeout(r, STORE_SEARCH_FOLLOWUP_HOLD_MS + 70)); });
  return (host.textContent ?? "").replace(/\s+/g, " ");
}

const REST = messages.search.saidSynced;
/** A line the mounted Search prints, read by its words; null when no line says them. */
const spoken = (words: string): string | null => within(host).queryAllByText(words)[0]?.textContent?.trim() ?? null;
/** The line about the mail still coming in; null when there is none. */
const syncing = (): string | null => spoken(REST);
/**
 * The section the mounted Search draws for the closest words: the Similar heading, then every line it
 * says under that heading before the rows. Nothing outside the section counts.
 */
function similarSection(): string[] {
  const heading = within(host).queryByRole("heading", { name: new RegExp(`^${messages.search.similarHead} [\\d,]+$`) });
  expect(heading, "no Similar heading with its count").not.toBeNull();
  const line = (heading as HTMLElement).parentElement ?? (heading as HTMLElement);
  /* The heading's word; its count stands beside it in its own element. */
  const word = (heading as HTMLElement).firstElementChild?.textContent?.trim() ?? "";
  const said: string[] = [word];
  for (let sib = line.nextElementSibling; sib !== null && sib.getAttribute("role") !== "list"; sib = sib.nextElementSibling) {
    const words = (sib.textContent ?? "").trim();
    if (words !== "") said.push(words);
  }
  return said;
}

describe("mid-import, the result line states the scope it searched", () => {
  it("an exact match: the mail synced so far, and the rest not in", async () => {
    const text = await said("invoice 74600", EXACT, true);
    expect(text).toContain(REST);
    expect(syncing()).toBe(REST);
    expect(text).not.toContain("whole mailbox");
  });

  it("the closest words never claim nothing matched over a store still coming in", async () => {
    const text = await said("delivery window 2059", CLOSEST, true);
    expect(text).toContain(REST);
    expect(syncing()).toBe(REST);
    expect(similarSection(), "only the part notice stands under Similar").toEqual([
      "Similar",
      messages.search.saidPart,
    ]);
    expect(text).not.toContain("whole mailbox");
  });

  it("nothing at all: the empty state says what it searched", async () => {
    const text = await said("zqxjvwk", NOTHING, true);
    expect(text).toContain(REST);
    expect(syncing()).toBe(REST);
    expect(text).not.toContain("whole mailbox");
  });
});

describe("the complete-store control: the same answers without the field read as they always did", () => {
  it.each([
    ["an exact match", "invoice 74600", EXACT, "Results 1"],
    ["the closest words", "delivery window 2059", CLOSEST, "Similar 2,526"],
    ["nothing at all", "zqxjvwk", NOTHING, "Nothing matched"],
  ] as const)("%s", async (_arm, query, parts, line) => {
    const text = await said(query, parts, false);
    if (parts === NOTHING) expect(within(host).getByText((_, node) => node?.textContent === line, { selector: ".oh-empty-label" })).toBeTruthy();
    else expect(within(host).getByRole("heading", { name: line })).toBeTruthy();
    expect(text).not.toContain("Searched your whole mailbox");
    expect(syncing()).toBeNull();
    expect(text).not.toContain("synced so far");
    if (parts === CLOSEST) {
      expect(similarSection(), "only the part notice stands under Similar").toEqual([
        "Similar",
        messages.search.saidPart,
      ]);
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
    ["en whole", "en", CUT, false, messages.search.saidAtLeast.replace("{total}", "2,000")],
    ["en synced", "en", CUT, true, messages.search.saidSynced],
    ["en mirror", "en", MIRROR, false, messages.search.saidMirror],
    ["de whole", "de", CUT, false, de.search.saidAtLeast.replace("{total}", "2.000")],
    ["de synced", "de", CUT, true, de.search.saidSynced],
    ["de mirror", "de", MIRROR, false, de.search.saidMirror],
  ] as const)("%s", async (_arm, locale, parts, importing, line) => {
    expect(await said("invoice 74600", parts, importing, locale)).toContain(line);
    const count = locale === "de" ? "2.000+" : "2,000+";
    expect(within(host).getByRole("heading", { name: `${locale === "de" ? "Treffer" : "Results"} ${count}` })).toBeTruthy();
  });
});
