/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { ARCHIVE_TIMEOUT_MS, SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";

/**
 * THE WHOLE-MAILBOX PASS ENDS IN EXACTLY ONE OF THREE VERDICTS, on every outcome: matched,
 * nothing matched, or the server did not answer. It once read "Searching the whole archive…" with
 * no completion. Each case drives one way the pass can end and reads the sentence; `verdicts()`
 * counts the three plus the in-progress sentence, so two on screen at once is a failure too.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-23T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: "portal@insure.example" },
    to: [], cc: [], date: "2026-09-01T09:00:00.000Z", folder: "INBOX",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

function adapter(over: Partial<EngineAdapter>): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

const create = (m: EngineMessage): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });

async function engineWith(rows: EngineMessage[], over: Record<string, unknown>): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map(create));
  return { engine: new OhmailEngine({ adapter: adapter(over as Partial<EngineAdapter>), store, now: () => NOW }), store };
}

let host: HTMLDivElement;
let root: Root;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  window.localStorage.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  warn.mockRestore();
  vi.useRealTimers();
});

async function render(engine: OhmailEngine, query: string, version = 1): Promise<void> {
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, { children: h(SearchView, { engine, version, now: NOW, query, onQuery: () => {}, onOpen: () => {} }) }),
    }));
  });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Past a typed question's hold: its page, then its count. */
const SETTLED = STORE_SEARCH_FOLLOWUP_HOLD_MS + 50;
const text = (): string => host.textContent ?? "";

const SENTENCES = {
  searching: "Searching your whole mailbox…",
  matched: /Searched your whole mailbox — (at least |about )?[\d,]+ matched/,
  nothing: "Searched your whole mailbox — nothing matched",
  unanswered: "Your server did not answer — showing the recent mail this device holds.",
  failed: "Your server could not run this search — showing the recent mail this device holds.",
} as const;
/** Which of the four sentences are on screen — exactly one is the invariant. */
function verdicts(): string[] {
  const t = text();
  return Object.entries(SENTENCES)
    .filter(([, s]) => (typeof s === "string" ? t.includes(s) : s.test(t)))
    .map(([k]) => k);
}
const logged = (): string[] => warn.mock.calls.map((c: unknown[]) => c.join(" ")).filter((l: string) => l.startsWith("[search]"));

const CORPUS = [msg("local", "myAXA Portal")];

describe("the whole-mailbox verdict always renders", () => {
  it("a REJECTED pass says the server did not answer at once — not at the ceiling", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: async () => ({ items: [], total: 0 }) });
    (engine as unknown as { searchServer: () => Promise<never> }).searchServer = () =>
      Promise.reject(new TypeError("the words somebody typed"));
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["unanswered"]);
    expect(logged()).toEqual(["[search] the whole-mailbox pass did not answer: TypeError"]);
  });

  it("a REFUSED pass (the transport throws) is the same verdict, logged by class and status", async () => {
    const refusal = Object.assign(new Error("a sentence about the account"), { name: "MutationRejectedError", status: 504, code: "server_error" });
    const { engine } = await engineWith(CORPUS, { searchServer: async () => { throw refusal; } });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["unanswered"]);
    expect(text()).not.toContain("a sentence about the account");
    expect(logged()).toEqual(["[search] the whole-mailbox pass did not answer: MutationRejectedError 504 server_error"]);
  });

  it("a pass the server ANSWERED with a fault (500) says it could not run the search, and keeps the retry", async () => {
    const refusal = Object.assign(new Error("a sentence about the account"), { name: "MutationRejectedError", status: 500, code: "internal" });
    const { engine } = await engineWith(CORPUS, { searchServer: async () => { throw refusal; } });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["failed"]);
    expect(text()).not.toContain("a sentence about the account");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toContain("Search your whole mailbox again");
  });

  it("a transport that throws SYNCHRONOUSLY is a failed outcome, never a rejection of the engine", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: () => { throw new RangeError("sync"); } });
    await expect(engine.searchServer("axa")).resolves.toMatchObject({ state: "failed", errorClass: "RangeError" });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["unanswered"]);
  });

  it("an EMPTY answer says nothing matched, and the empty state says the whole mailbox", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: async () => ({ items: [], total: 0 }) });
    await render(engine, "zzqx");
    expect(verdicts()).toEqual(["searching"]);
    await advance(300);
    expect(verdicts()).toEqual(["nothing"]);
    // Said once: the verdict, no title beside it.
    expect(text()).not.toContain("Nothing matched.");
  });

  it("a LATE answer, after the device arm re-rendered, still lands its count", async () => {
    let settle: ((v: { items: EngineMessage[]; total: number; tier: "exact" }) => void) | null = null;
    const { engine, store } = await engineWith(CORPUS, {
      searchServer: () => new Promise((res) => { settle = res as typeof settle; }),
    });
    await render(engine, "axa");
    await advance(300);
    expect(verdicts()).toEqual(["searching"]);
    // The device arm re-renders over a changed mirror while the pass is out.
    await act(async () => { await store.applyChanges([create(msg("new", "AXA claim update"))]); });
    await render(engine, "axa", 2);
    await advance(2_000);
    expect(verdicts()).toEqual(["searching"]);
    await act(async () => { settle!({ items: [msg("wire", "Quarterly letter")], total: 3, tier: "exact" }); });
    expect(verdicts()).toEqual(["matched"]);
    expect(text()).toContain("Searched your whole mailbox — 3 matched");
  });

  it("a CUT page says at least N, the estimate about N, and the exact count replaces it in place", async () => {
    const asked: string[] = [];
    type Wire = { items: EngineMessage[]; total: number; totalExact: boolean; totalEstimate?: number; ms: number };
    let estimate: ((v: Wire) => void) | null = null;
    let count: ((v: Wire) => void) | null = null;
    const { engine } = await engineWith(CORPUS, {
      searchServer: (_q: string, opts: { parts?: string }) => {
        asked.push(opts.parts ?? "both");
        if (opts.parts === "estimate") return new Promise((res) => { estimate = res as typeof estimate; });
        if (opts.parts === "summary") return new Promise((res) => { count = res as typeof count; });
        return Promise.resolve({ items: [msg("wire", "Quarterly letter")], total: 212, totalExact: false, ms: 12 });
      },
    });
    await render(engine, "axa");
    await advance(SETTLED);
    expect(asked).toEqual(["page", "estimate"]);
    expect(text()).toContain("Searched your whole mailbox — at least 212 matched · ");
    await act(async () => { estimate!({ items: [], total: 212, totalExact: false, totalEstimate: 7_874, ms: 9 }); });
    expect(asked).toEqual(["page", "estimate", "summary"]);
    expect(text()).toContain("Searched your whole mailbox — about 7,874 matched · ");
    expect(verdicts()).toEqual(["matched"]);
    await act(async () => { count!({ items: [], total: 7_901, totalExact: true, ms: 40 }); });
    expect(text()).toContain("Searched your whole mailbox — 7,901 matched · ");
    expect(text()).not.toContain("about 7,874");
    expect(verdicts()).toEqual(["matched"]);
  });

  it("the estimate is its own outcome: no rows and no cursor, so it cannot be read as a page", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: async () => ({ items: [], total: 3, totalExact: false, totalEstimate: 9 }) });
    const est = await engine.searchServer("axa", { parts: "estimate" });
    if (est.state !== "ready") throw new Error(est.state);
    // @ts-expect-error — an estimate carries no rows; this line compiles only if it grew them.
    expect(est.items).toBeUndefined();
    expect(est).toMatchObject({ total: 3, totalExact: false, totalEstimate: 9 });
  });

  it("an UNCUT search takes its exact count from the estimate and asks no summary", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, {
      searchServer: async (_q: string, opts: { parts?: string }) => {
        asked.push(opts.parts ?? "both");
        if (opts.parts === "estimate") return { items: [], total: 38, totalExact: true, ms: 4 };
        return { items: [msg("wire", "Quarterly letter")], total: 38, totalExact: true, ms: 12 };
      },
    });
    await render(engine, "axa");
    await advance(SETTLED);
    await advance(SETTLED);
    expect(asked).toEqual(["page", "estimate"]);
    expect(text()).toContain("Searched your whole mailbox — 38 matched · ");
  });

  it("an exact estimate asks no summary, and a count that fails leaves the lower bound", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, {
      searchServer: async (q: string, opts: { parts?: string }) => {
        asked.push(`${q}:${opts.parts ?? "both"}`);
        if (q === "exact") return { items: [], total: 4, totalExact: true, ms: 3 };
        if (opts.parts === "summary") throw new Error("count refused");
        return { items: [], total: 250, totalExact: false, ms: 9 };
      },
    });
    await render(engine, "exact");
    await advance(SETTLED);
    // The estimate is always the second response — it carries the facets; exact, it is the last.
    expect(asked).toEqual(["exact:page", "exact:estimate"]);
    expect(text()).toContain("Searched your whole mailbox — 4 matched · ");
    await render(engine, "cut");
    await advance(SETTLED);
    // An estimate with no `totalEstimate` says nothing about how many: the lower bound stands.
    expect(asked).toEqual(["exact:page", "exact:estimate", "cut:page", "cut:estimate", "cut:summary"]);
    expect(text()).toContain("Searched your whole mailbox — at least 250 matched · ");
  });

  it("a pass that NEVER settles ends at the ceiling in the not-answered verdict", async () => {
    const { engine } = await engineWith(CORPUS, { searchServer: () => new Promise<never>(() => {}) });
    await render(engine, "axa");
    await advance(ARCHIVE_TIMEOUT_MS - 1);
    expect(verdicts()).toEqual(["searching"]);
    await advance(2);
    expect(verdicts()).toEqual(["unanswered"]);
    expect(logged()).toEqual(["[search] the whole-mailbox pass did not answer: timeout"]);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toContain("Search your whole mailbox again");
  });

  it("a one-character query asks nothing and never claims to be searching", async () => {
    const asked: string[] = [];
    const { engine } = await engineWith(CORPUS, { searchServer: async (q: string) => { asked.push(q); return { items: [], total: 0 }; } });
    await render(engine, "m");
    await advance(ARCHIVE_TIMEOUT_MS * 2);
    expect(asked).toEqual([]);
    expect(verdicts()).toEqual([]);
    // The positive control: two characters are a question, and it is answered.
    await render(engine, "my");
    await advance(SETTLED);
    expect(asked).toEqual(["my", "my"]); // the page, then its estimate — exact, so no summary
    expect(verdicts()).toEqual(["nothing"]);
  });
});
