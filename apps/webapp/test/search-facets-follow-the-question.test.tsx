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
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";

/**
 * THE STORE'S FACET CHIPS ARE THE QUESTION ON SCREEN'S (REVIEW-026 H1). The first render after a
 * new text still holds the old question's answer, and the chips were kept under the NEW text: the
 * old senders stood under the next question until its count landed (600 ms with the hold), and for
 * good when that count failed. The reviewer's probe, both arms. And a pressed facet settles the
 * question: its page and its count are asked at once, never after the typing hold.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
const h = React.createElement;
const NOW = new Date("2026-09-26T12:00:00.000Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement;
let root: Root;
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

function Live({ e, door }: { e: OhmailEngine; door: { type?: (q: string) => void } }) {
  const [query, setQuery] = React.useState("");
  door.type = setQuery;
  return h(SearchView, { engine: e, version: 1, now: NOW, query, onQuery: setQuery, onOpen: () => {} });
}

async function mounted(e: OhmailEngine) {
  const door: { type?: (q: string) => void } = {};
  root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(KeymapProvider, { children: h(Live, { e, door }) }) }));
  for (let i = 0; i < 100 && door.type === undefined; i++) await sleep(10);
  return door;
}

/** Type A, wait for its chips, type B; how long A's chip stood under B (ms, -1 never), and B's own. */
async function staleAfterRetype(e: OhmailEngine): Promise<{ staleUntil: number; secondDrawn: number }> {
  const door = await mounted(e);
  door.type!("alphaword");
  for (let i = 0; i < 300 && !(host.textContent ?? "").includes("firstsender"); i++) await sleep(5);
  expect(host.textContent, "the first question's facet never drew, so the reading below says nothing").toContain("firstsender");
  const t0 = performance.now();
  door.type!("betaword");
  let staleUntil = -1, secondDrawn = -1;
  for (let i = 0; i < 300; i++) {
    await sleep(5);
    const txt = host.textContent ?? "";
    if (txt.includes("firstsender")) staleUntil = performance.now() - t0;
    if (secondDrawn < 0 && txt.includes("secondsender")) secondDrawn = performance.now() - t0;
  }
  return { staleUntil, secondDrawn };
}

beforeEach(() => {
  asked = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
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
    door.type!("alphaword");
    for (let i = 0; i < 300 && !(host.textContent ?? "").includes("firstsender"); i++) await sleep(5);
    const chip = [...host.querySelectorAll(".facets button")].find((b) => (b.textContent ?? "").includes("firstsender")) as HTMLElement;
    expect(chip, "no chip to press").toBeTruthy();
    const t0 = performance.now();
    chip.click();
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
  const facet = () => [...host.querySelectorAll<HTMLElement>(".facets button")].find((b) => (b.textContent ?? "").includes("firstsender"));

  it("each facet is a tabbable toggle button; the pressed one says so and a second press clears it", async () => {
    const door = await mounted(await engine());
    door.type!("alphaword");
    for (let i = 0; i < 300 && !facet(); i++) await sleep(5);
    const b = facet() as HTMLButtonElement;
    expect(b, "the From facet is not a button").toBeTruthy();
    expect(b.type).toBe("button");
    expect(b.tabIndex).toBe(0);
    expect(b.getAttribute("aria-pressed")).toBe("false");
    b.click();
    for (let i = 0; i < 200 && facet()?.getAttribute("aria-pressed") !== "true"; i++) await sleep(5);
    expect(facet()!.getAttribute("aria-pressed"), "the active filter is not shown on its control").toBe("true");
    expect(asked.some((a) => a.sender === "firstsender@x.test")).toBe(true);
    facet()!.click();
    for (let i = 0; i < 200 && facet()?.getAttribute("aria-pressed") !== "false"; i++) await sleep(5);
    expect(facet()!.getAttribute("aria-pressed"), "a second press did not clear the filter").toBe("false");
  });

  it("a typed from: or in: says it is not a filter and points at the facets", async () => {
    const door = await mounted(await engine());
    door.type!("alphaword");
    await sleep(30);
    expect(host.querySelector("[data-testid=search-no-operators]")).toBeNull();
    for (const q of ["from:firstsender alphaword", "alphaword in:inbox"]) {
      door.type!(q);
      for (let i = 0; i < 100 && !host.querySelector("[data-testid=search-no-operators]"); i++) await sleep(5);
      expect(host.querySelector("[data-testid=search-no-operators]")?.textContent, q).toContain("not filters");
    }
  });
});
