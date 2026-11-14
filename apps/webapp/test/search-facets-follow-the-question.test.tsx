/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/react";
import { enterSearchRoute, RegisteredSearch, typeSearch } from "./search-registered-fixture";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";

/**
 * THE STORE'S FACET CHIPS ARE THE QUESTION ON SCREEN'S (REVIEW-026 H1). The first render after a
 * new text still holds the old question's answer, and the chips were kept under the NEW text: the
 * old senders stood under the next question until its count landed (600 ms with the hold), and for
 * good when that count failed. The reviewer's probe, both arms. And a pressed facet settles the
 * question: its page and its count are asked at once, never after the typing hold.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
const NOW = new Date("2026-09-26T12:00:00.000Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement;
let root: Root;
let leaveSearch: () => void;
let asked: Array<{ at: number; q: string; parts: string; sender: string | null }> = [];

const facetsFor = (q: string) => ({
  folder: {}, sender: [{ address: `${q === "alphaword" ? "firstsender" : "secondsender"}@x.test`, count: q === "alphaword" ? 7 : 2 }],
  unread: { true: 0, false: 0 }, hasAttachments: { true: 0, false: 0 }, date: { today: 0, last7: 0, last30: 0, older: 0 },
});

async function engine(opts: { failSecond?: boolean } = {}): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const m = {
    id: "m1", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "alphaword betaword", from: { name: null, address: "device@x.test" }, to: [], cc: [], date: "2026-09-01T09:00:00.000Z", folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  } as unknown as EngineMessage;
  await store.applyChanges([{ type: "message", op: "create", id: m.id, seq: 1, updatedAt: m.updatedAt, entity: m } as SyncChange]);
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (q: string, o: { parts?: string; filters?: { sender?: string } }) => {
      asked.push({ at: performance.now(), q, parts: o.parts ?? "both", sender: o.filters?.sender ?? null });
      await sleep(10);
      if (opts.failSecond && o.parts !== "page" && q === "betaword") throw new Error("estimate unavailable");
      if (o.parts === "estimate") return { items: [], total: 3, totalExact: true, facets: facetsFor(q) };
      return { items: [{ ...m, id: "s-" + q }], total: 3, nextCursor: null, ms: 5 };
    },
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

async function mounted(e: OhmailEngine) {
  root.render(<RegisteredSearch engine={e} now={NOW} />);
  await within(host).findByRole("textbox", { name: messages.search.aria });
  return { type: (query: string) => typeSearch(host, query) };
}

function fromMenu() {
  const from = within(host).queryByRole("button", { name: messages.search.facetFrom });
  if (from?.getAttribute("aria-expanded") === "false") fireEvent.click(from);
  return within(document.body).queryByRole("menu", { name: messages.search.facetFrom });
}

function facetOption(name: RegExp) {
  const menu = fromMenu();
  return menu && within(menu).queryByRole("menuitem", { name });
}

/** Type A, wait for its chips, type B; how long A's chip stood under B (ms, -1 never), and B's own. */
async function staleAfterRetype(e: OhmailEngine): Promise<{ staleUntil: number; secondDrawn: number }> {
  const door = await mounted(e);
  door.type("alphaword");
  for (let i = 0; i < 300 && !facetOption(/firstsender/); i++) await sleep(5);
  expect(facetOption(/firstsender/), "the first question's facet never drew, so the reading below says nothing").toBeTruthy();
  const t0 = performance.now();
  door.type("betaword");
  let staleUntil = -1, secondDrawn = -1;
  for (let i = 0; i < 300; i++) {
    await sleep(5);
    if (facetOption(/firstsender/)) staleUntil = performance.now() - t0;
    if (secondDrawn < 0 && facetOption(/secondsender/)) secondDrawn = performance.now() - t0;
  }
  return { staleUntil, secondDrawn };
}

beforeEach(() => {
  asked = [];
  leaveSearch = enterSearchRoute();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
  leaveSearch();
});

describe("the store's facet chips belong to the question on screen", () => {
  it("the previous question's chips never stand under the next one", async () => {
    const r = await staleAfterRetype(await engine());
    expect(r.staleUntil, "the first question's facet stood under the second").toBe(-1);
    expect(r.secondDrawn, "the second question's own facet never drew").toBeGreaterThan(0);
  });

  it("…nor when the next question's count fails", async () => {
    const r = await staleAfterRetype(await engine({ failSecond: true }));
    expect(r.staleUntil, "the first question's facet stood under a question whose count failed").toBe(-1);
  });

  it("a pressed facet asks its page and its count at once", async () => {
    const door = await mounted(await engine());
    door.type("alphaword");
    for (let i = 0; i < 300 && !facetOption(/firstsender/); i++) await sleep(5);
    const chip = facetOption(/firstsender/);
    expect(chip, "no chip to press").toBeTruthy();
    const t0 = performance.now();
    fireEvent.click(chip!);
    for (let i = 0; i < 200 && !asked.some((a) => a.sender !== null && a.parts === "estimate"); i++) await sleep(5);
    const page = asked.find((a) => a.sender !== null && a.parts === "page");
    const count = asked.find((a) => a.sender !== null && a.parts === "estimate");
    expect(page, "the pressed facet asked no page").toBeTruthy();
    expect(count, "the pressed facet's count was never asked").toBeTruthy();
    expect(page!.at - t0, "the press waited the typing debounce").toBeLessThan(60);
    expect(count!.at - t0, "the press's count waited the typing hold").toBeLessThan(300);
  });
});

describe("the facets are controls a keyboard reaches", () => {
  it("each facet is a tabbable toggle button; the pressed one says so and a second press clears it", async () => {
    const door = await mounted(await engine());
    door.type("alphaword");
    for (let i = 0; i < 300 && !facetOption(/firstsender/); i++) await sleep(5);
    const from = within(host).getByRole("button", { name: messages.search.facetFrom });
    expect(from.tabIndex).toBe(0);
    fireEvent.click(facetOption(/firstsender/)!);

    const selected = await within(host).findByRole("button", { name: /firstsender/, pressed: true });
    expect((selected as HTMLButtonElement).type).toBe("button");
    expect(selected.tabIndex).toBe(0);
    expect(asked.some((a) => a.sender === "firstsender@x.test")).toBe(true);
    fireEvent.click(selected);
    expect(await within(host).findByRole("button", { name: messages.search.facetFrom, expanded: false })).toBeTruthy();
  });

  it("a typed from: or in: says it is not a filter and points at the facets", async () => {
    const door = await mounted(await engine());
    door.type("alphaword");
    await sleep(30);
    expect(within(host).queryByText(/from: and in: are not filters here/)).toBeNull();
    for (const q of ["from:firstsender alphaword", "alphaword in:inbox"]) {
      door.type(q);
      for (let i = 0; i < 100 && !within(host).queryByText(/from: and in: are not filters here/); i++) await sleep(5);
      expect(within(host).queryByText(/from: and in: are not filters here/)?.textContent, q).toContain("not filters");
    }
  });
});
