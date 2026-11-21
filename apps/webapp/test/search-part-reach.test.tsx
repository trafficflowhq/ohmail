/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { enterSearchRoute, RegisteredSearch, findSearchField, typeSearch } from "./search-registered-fixture";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncResponse,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * SEARCH SAYS WHERE A PART INSIDE A WORD IS LOOKED FOR (SEARCH-PART-WORD-INSIDE-A-BODY-WORD). The
 * stores look for it in subjects, senders, recipients and attachment names, never the text, so the
 * store's empty and closest-words answers say so for a query that opens that arm (`substringOpen`).
 * Not for an exact answer, not for `"levation"` or `-levation` (exactness asked), and not while the
 * store still indexes, whose older rows are read by subject and sender alone.
 */
(globalThis as unknown as { React: unknown }).React = React;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-26T16:42:00.000Z");
const FACETS = { folder: { INBOX: 3 }, sender: [], unread: { true: 0, false: 3 }, hasAttachments: { true: 0, false: 3 }, date: { today: 0, last7: 0, last30: 0, older: 3 } };

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

type Parts = Record<string, Record<string, unknown>>;
const NOTHING: Parts = {
  page: { items: [], total: 0, totalExact: true, tier: "exact", ms: 12 },
  estimate: { items: [], total: 0, totalExact: true, tier: "exact", ms: 2 },
};
const CLOSEST: Parts = {
  page: { items: [1, 2, 3].map((i) => letter(i, `elevator notice ${i}`)), total: 3, totalExact: true, tier: "similar", ms: 40 },
  estimate: { items: [], total: 3, totalExact: true, tier: "similar", ms: 4, facets: FACETS },
};
const EXACT: Parts = {
  page: { items: [letter(0, "Trip elevation")], total: 1, totalExact: true, tier: "exact", ms: 20 },
  estimate: { items: [], total: 1, totalExact: true, tier: "exact", ms: 3, facets: FACETS },
};
const indexing = (p: Parts): Parts => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, indexed: { done: 40, total: 100 } }]));

function adapterOver(parts: Parts): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (_q: string, o: { parts?: string }) => parts[o.parts ?? "both"] ?? parts.page!,
  } as unknown as EngineAdapter;
}

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

async function reach(query: string, parts: Parts, locale: "en" | "de" = "en"): Promise<string[]> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: adapterOver(parts), store, now: () => NOW });
  const catalogue = locale === "en" ? en : de;
  await act(async () => {
    root.render(<RegisteredSearch engine={engine} now={NOW} locale={locale} catalogue={catalogue} />);
  });
  await findSearchField(host);
  await act(async () => { typeSearch(host, query); });
  await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
  return within(host).queryAllByText(catalogue.search.saidPart).map((e) => e.textContent!.trim());
}

const SAID = en.search.saidPart;

describe("the store's empty and closest-words answers say where a part inside a word is looked for", () => {
  it("an empty answer for a part: the sentence, in the empty state, in both catalogues", async () => {
    expect(await reach("levation", NOTHING)).toEqual([SAID]);
    const shown = within(host);
    const verdict = shown.getByText((_, node) => node?.textContent === "Nothing matched", { selector: ".oh-empty-label" });
    expect(verdict.compareDocumentPosition(shown.getByText(SAID))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await reach("levation", NOTHING, "de")).toEqual([de.search.saidPart]);
  });

  it("a closest-words answer for a part: the sentence under the Similar head", async () => {
    expect(await reach("levation", CLOSEST)).toEqual([SAID]);
    expect(within(host).getByText("Similar").compareDocumentPosition(within(host).getByText(SAID))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a part beside an excluded word: the words asked are looked for inside words as they are alone", async () => {
    expect(await reach("mail -thanks", NOTHING)).toEqual([SAID]);
  });

  it.each([
    ["a quoted part (exactness asked)", '"levation"', NOTHING],
    ["an excluded part (exactness asked)", "-levation", NOTHING],
    ["an exact answer", "levation", EXACT],
    ["an answer while the store still indexes", "levation", indexing(NOTHING)],
    ["a query under a trigram's width", "le", NOTHING],
  ] as const)("not for %s", async (_arm, query, parts) => {
    expect(await reach(query, parts)).toEqual([]);
  });
});
