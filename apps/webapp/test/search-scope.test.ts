/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { createEngine } from "../app/shell/engine-config";
import { KeymapProvider } from "@ohmail/app/keys";

/**
 * GAP SEARCH SAYS WHAT IT SEARCHED, AT EVERY MOMENT.
 *
 * The shipped view offered the archive on Enter and answered with a toast: *"Searching the
 * server archive isn't wired up yet. These local results are complete."* Neither half was
 * true. `GET /search` was mounted, `cost: "read"`, RRF-ranked over `message_bodies.body_tsv`
 * and contract-tested, with zero callers; and the local index reads subject, sender and the
 * short snippet, which on the hosted service is a small part of stored body text.
 *
 * So the assertions here are about the two halves of the fix, in the order they matter:
 *
 *  1. the local pass still paints FIRST and with no round trip — that is the whole reason the
 *     local index exists, and replacing it with a network call would be a different product;
 *  2. at no moment does the view claim completeness it does not have. Four states, four
 *     sentences: only-local, archive-searching, archive-answered, archive-refused — plus the
 *     client that has no archive at all (`?demo=1`, and the desktop tier).
 *
 * ── THE COPY IS NO LONGER DECLARED HERE, AND THAT MATTERS ────────────────────────────────
 *
 * This file used to carry an `O14_COPY` const, because `apps/webapp/messages/en.json` belonged
 * to another change when search scope landed, and it said in as many words: *"when they land, this const
 * is deleted and the spread below goes back to plain `messages`"*. They have landed, so it is.
 *
 * It is not tidying. A local copy of the strings means the tests assert against a fixture and
 * the product ships something else — which is exactly what a walk found on a live account: the
 * `=0` arm of `scopeDevice` had a test that exercised it and nobody had ever read the sentence
 * it produced underneath "Nothing on this device."
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");

const intlMessages = messages;

let seq = 0;

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: null, address: `${over.id}@example.test` },
    to: [], cc: [], date: "2026-08-04T09:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  };
}

const snippetOf = (body: string): string => body.replace(/\s+/g, " ").trim().slice(0, 200);

const LONG_BODY =
  "Thank you for your order and for your patience while we packed it. ".repeat(23) +
  "The reference for this shipment is ZQXBRIM and it will arrive on Tuesday.";

function baseAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
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

async function engineWith(
  rows: EngineMessage[],
  over: Partial<EngineAdapter> = {},
): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({ adapter: baseAdapter(over), store, now: () => NOW });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/**
 * `version` is AppShell's mirror-version prop and it is what invalidates the view's local
 * search memo. Passing a constant here would make every re-render show the first pass's
 * result — which is how the hydration case below silently "passed" by never re-searching.
 */
/** The index revision a case hands, which an engine built to hold it reports (`bigEngine`). */
let handedRev = 0;

async function render(engine: OhmailEngine, query: string, version = 1, indexRev = 0): Promise<void> {
  handedRev = indexRev;
  await act(async () => {
    root.render(
      // `children` goes in the PROPS object, not as a third argument: `apps/webapp` is one of
      // the three packages that really do typecheck their tests, and the positional form does
      // not satisfy `NextIntlClientProvider`'s required `children`.
      h(NextIntlClientProvider, {
        locale: "en",
        messages: intlMessages,
        timeZone: "UTC",
        now: NOW,
        /**
         * THE KEYBOARD REGISTRY IS PART OF MOUNTING THIS VIEW SINCE THAT CHANGE.
         *
         * `SearchView` declared zero bindings until that slice — which was the defect: with
         * results on screen the keyboard did nothing at all. It now declares ↑/↓/↵ through
         * `useKeyBindings`, and `useKeymap` throws without a provider ON PURPOSE, because a
         * component that declares bindings into no registry is a silently dead surface. So
         * this mounts the provider rather than routing around the throw.
         */
        children: h(KeymapProvider, {
          children: h(SearchView, {
            engine,
            version,
            indexRev,
            now: NOW,
            query,
            onQuery: () => {},
            onOpen: () => {},
          }),
        }),
      }),
    );
  });
}

/** Past the 250 ms archive debounce, plus the microtasks its promise resolves through. */
/** A typed question settles when its count is asked: the page at the debounce, the count at the hold. */
async function settleArchive(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, STORE_SEARCH_FOLLOWUP_HOLD_MS + 70));
  });
}

const text = (): string => host.textContent ?? "";
const hits = (): string[] =>
  [...host.querySelectorAll(".hit .subj")].map((n) => n.textContent ?? "");

describe("the local pass still paints first, with no round trip", () => {
  it("local hits are on screen BEFORE the archive is asked anything", async () => {
    // The design constraint that outranks everything else here. Red if the view ever awaits
    // the archive before rendering: `asked` would be non-empty at the first assertion, or the
    // local hit would be missing from it.
    const asked: string[] = [];
    const engine = await engineWith([msg({ id: "a", subject: "Kingfisher invoice" })], {
      searchServer: async (q: string, o: { parts?: string }) => {
        asked.push(`${q}|${o.parts ?? ""}`);
        return { items: [], total: 0 };
      },
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "kingfisher");
    expect(hits()).toEqual(["Kingfisher invoice"]);
    expect(asked).toEqual([]);

    await settleArchive();
    // The page first; the estimate (count, facets, progress) after it, never on its path — and
    // exact here, so no summary follows.
    expect(asked).toEqual(["kingfisher|page", "kingfisher|estimate"]);
  });
});

describe("the sentence under the box is true at every moment (ARCHIVE-024: one list)", () => {
  it("while only the device's rows are in hand it says the whole mailbox is being searched, and claims nothing more", async () => {
    const engine = await engineWith([msg({ id: "a", subject: "Kingfisher invoice", snippet: snippetOf(LONG_BODY) })], {
      searchServer: async () => ({ items: [], total: 0 }),
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "kingfisher");
    expect(text()).toContain("Searching your whole mailbox");
    // No inventory of a device and no claim of completeness, in any words.
    expect(text()).not.toMatch(/this device|200 characters|archive|complete/i);
  });

  it("opening a message does NOT widen the instant index — the store is the body search", async () => {
    // The instant index reads subjects, senders and the snippet; a hydrated body widens nothing
    // here. A term past character 200 is the store's to find, and the list takes its answer.
    const engine = await engineWith(
      [msg({ id: "a", subject: "Kingfisher invoice", snippet: snippetOf(LONG_BODY) })],
      { fetchBody: async () => ({ text: LONG_BODY }), searchServer: async () => ({ items: [], total: 0 }) } as unknown as Partial<EngineAdapter>,
    );
    await render(engine, "ZQXBRIM");
    expect(hits()).toEqual([]);
    await act(async () => { await engine.hydrateBody("a"); });
    await render(engine, "ZQXBRIM", 2);
    expect(hits()).toEqual([]);
    // THE CONTROL: a word inside the 200 characters answers, through the same render.
    await render(engine, "patience", 3);
    expect(hits()).toEqual(["Kingfisher invoice"]);
  });

  it("when the store answers, its page REPLACES the device's rows — the ones on screen keep their places", async () => {
    const live = msg({ id: "live", subject: "Pottery order", snippet: snippetOf(LONG_BODY) });
    const local = msg({ id: "local", subject: "ZQXBRIM in the subject" });
    const stale = msg({ id: "stale", subject: "ZQXBRIM only on this device" });
    const engine = await engineWith([live, local, stale], {
      searchServer: async () => ({ items: [{ ...live }, { ...local }], total: 41 }),
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "ZQXBRIM");
    expect(hits()).toEqual(["ZQXBRIM in the subject", "ZQXBRIM only on this device"]); // the device paints first

    await settleArchive();
    // The row already on screen stays first; the store's other rows follow in its order; a device
    // row the store did not return is gone — one list, the store's.
    expect(hits()).toEqual(["ZQXBRIM in the subject", "Pottery order"]);
    expect(text()).toContain("Searched your whole mailbox — 41 matched");
    expect(text()).not.toContain("Searching your whole mailbox");
  });

  it("a refusal is the not-answered verdict, logged by class, and offers the retry", async () => {
    // The server's text never reaches the screen or the log: it can carry what was typed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    const engine = await engineWith([msg({ id: "a", subject: "Kingfisher invoice" })], {
      searchServer: async () => {
        attempts++;
        throw new Error("Your plan's monthly credits are used up.");
      },
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "kingfisher");
    await settleArchive();
    expect(text()).toContain(messages.search.scopeUnanswered);
    expect(text()).not.toContain("monthly credits");
    // The device's rows stay on screen under the failure sentence.
    expect(hits()).toEqual(["Kingfisher invoice"]);
    expect(attempts).toBe(1);
    expect(warn.mock.calls.map((c) => c.join(" "))).toEqual(["[search] the whole-mailbox pass did not answer: Error"]);
    warn.mockRestore();

    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Search your whole mailbox again");
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await settleArchive();
    expect(attempts).toBe(2);
  });

  it("a client with NO store says what it searches and issues nothing — the demo", async () => {
    const engine = await engineWith([msg({ id: "a", subject: "Kingfisher invoice" })]);
    expect(engine.serverSearchAvailable()).toBe(false);

    await render(engine, "kingfisher");
    await settleArchive();
    expect(text()).toContain("Search covers the sample mailbox.");
    expect(text()).not.toContain("Searching your whole mailbox");
  });

  it("an empty result claims nothing while the store is still searching, and says so once it answered", async () => {
    const engine = await engineWith([msg({ id: "a", subject: "Kingfisher invoice" })], {
      searchServer: async () => ({ items: [], total: 0 }),
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "zzzznothing");
    expect(text()).toContain("Searching your whole mailbox");
    expect(text()).not.toContain(messages.search.emptyTitle);

    await settleArchive();
    // Said once: the verdict, no title beside it.
    expect(text()).not.toContain(messages.search.emptyTitle);
    expect(text()).toContain("Searched your whole mailbox — nothing matched");
  });

  it("MARKER — the LIVE Cloud engine reaches the archive, and this test is how that stops being true quietly", () => {
    /**
     * THE OTHER HALF OF THAT CHANGE, LANDED.
     *
     * `OhmailEngine.searchServer` reaches `GET /search` through an OPTIONAL `searchServer`
     * capability on the adapter. `HttpAdapter` now implements it, and `sync-scheduler.ts`
     * forwards it — `createSyncGate(null).guard()` is an explicit object literal rather than a
     * Proxy, so an unforwarded method would be lost on the LIVE path only while every test
     * here stayed green. That is the wiring bug the `transport` field exists to keep visible,
     * and this assertion is the thing that would catch it.
     *
     * It was asserted as `false` while the transport was missing, on purpose, so that landing
     * the patch turned this test red and put its own comment in front of whoever landed it.
     * That worked; the expectation flipped in the same change.
     *
     * It is asserted as `true` now for the mirror-image reason: REMOVING the capability, or
     * dropping the spread in the gate, turns a Cloud user's search silently back into a
     * small-slice-of-the-corpus search that still calls itself complete. The demo is unaffected — the
     * FixturesAdapter has no server, absence is meaningful, and `scopeNoArchive` is worded
     * about the client rather than the archive precisely so it stays true there.
     */
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" });
    expect(engine.serverSearchAvailable()).toBe(true);
  });

  it("a store row the mirror does not hold is a row like any other — no mark, one list", async () => {
    const engine = await engineWith([], {
      searchServer: async () => ({ items: [msg({ id: "ghost", subject: "Only in the store" })], total: 1 }),
    } as unknown as Partial<EngineAdapter>);

    await render(engine, "store");
    await settleArchive();
    expect(hits()).toEqual(["Only in the store"]);
    expect(text()).not.toMatch(/archive/i);
  });
});

describe("the sentence while the index is still filling", () => {
  /**
   * Past `SEARCH_INDEX_SYNC_MAX` the instant index builds in slices, so the first keystroke has
   * no index to answer from: the screen says it is still reading, never "nothing matched".
   */
  const MANY = 600; // one more than the engine's synchronous bound (500), and cheap to build

  async function bigEngine(): Promise<OhmailEngine> {
    const rows: EngineMessage[] = [];
    for (let i = 0; i < MANY; i++) {
      rows.push(msg({ id: `m-${i}`, subject: `Kingfisher invoice ${i}` }));
    }
    const engine = await engineWith(rows, { searchServer: async () => new Promise(() => {}) } as unknown as Partial<EngineAdapter>);
    /* The list reads the index's revision off the engine itself: held at the one the case hands, so the first paint
       is the one before the build settles, and the case says when the settled index is read. */
    engine.searchIndexRevision = () => handedRev;
    return engine;
  }

  it("says it is still reading rather than that nothing matched", async () => {
    const engine = await bigEngine();
    await render(engine, "kingfisher");

    expect(hits()).toEqual([]);
    expect(text()).toContain(messages.search.scopeIndexing);
    expect(text()).toContain(messages.search.emptyTitleIndexing);
    expect(text()).not.toContain(messages.search.emptyTitle);
  });

  it("…and once the build settles the hits are back and the indexing sentence is gone", async () => {
    const engine = await bigEngine();
    await render(engine, "kingfisher");
    expect(hits()).toEqual([]);

    await act(async () => { await engine.warmSearchIndex(); });
    await render(engine, "kingfisher", 1, 1);

    expect(hits().length).toBeGreaterThan(0);
    expect(text()).toContain("Searching your whole mailbox");
    expect(text()).not.toContain(messages.search.scopeIndexing);
  });
});

describe("FIX-024 — a desktop paired with ohmail Cloud: the account's verdict, or a sentence saying it is not", () => {
  /** The door's answer by part, as the paired desktop's engine sees it through its adapter. */
  function door(parts: Record<string, unknown>): Partial<EngineAdapter> {
    return {
      searchServer: async (_q: string, o: { parts?: string }) => parts[o.parts ?? "both"] ?? parts.page,
    } as unknown as Partial<EngineAdapter>;
  }
  const row = msg({ id: "h", subject: "Heron census" });

  it("the account's answer is the whole-mailbox verdict, with its count and its server ms", async () => {
    const engine = await engineWith([], door({
      page: { items: [row], total: 50, totalExact: false, ms: 37 },
      estimate: { items: [], total: 4321, totalExact: true, ms: 11 },
    }));
    await render(engine, "heron");
    await settleArchive();
    expect(text()).toContain("Searched your whole mailbox — 4,321 matched · ");
  });

  it("the mirror's answer says it covers this computer while ohmail Cloud is unreachable, never the whole mailbox", async () => {
    const engine = await engineWith([], door({
      page: { items: [row], total: 1, ms: 9, answeredFrom: "mirror" },
      estimate: { items: [], total: 1, totalExact: true, ms: 4, answeredFrom: "mirror" },
    }));
    await render(engine, "heron");
    await settleArchive();
    expect(text()).toContain("Search covers the mail on this computer while ohmail Cloud is unreachable — 1 matched · ");
    expect(text()).not.toContain("Searched your whole mailbox");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Search your whole mailbox again")).toBe(true);
  });

  it("the verdict on screen hands ONE record of its timings to a door that takes them, and a re-render adds none", async () => {
    const got: Array<Record<string, unknown>> = [];
    const engine = await engineWith([], {
      ...door({ page: { items: [row], total: 3, totalExact: true, ms: 37 }, estimate: { items: [], total: 3, totalExact: true, ms: 4 } }),
      reportSearchPhases: async (r: Record<string, unknown>) => { got.push(r); },
    } as unknown as Partial<EngineAdapter>);
    await render(engine, "heron");
    await settleArchive();
    expect(text()).toContain("Searched your whole mailbox — 3 matched · ");
    await render(engine, "heron", 2);
    await settleArchive();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ verdict: "matched", serverMs: 37 });
    expect(got[0]!.debounceMs as number, "the typing debounce, 100 ms").toBeGreaterThanOrEqual(90);
  });

  it("a count from the other store never lands on the verdict: the mirror's estimate under the account's page", async () => {
    const engine = await engineWith([], door({
      page: { items: [row], total: 50, totalExact: false, ms: 37 },
      estimate: { items: [], total: 1, totalExact: true, ms: 4, answeredFrom: "mirror" },
      summary: { items: [], total: 4321, totalExact: true, ms: 60 },
    }));
    await render(engine, "heron");
    await settleArchive();
    expect(text()).toContain("Searched your whole mailbox — 4,321 matched · ");
    expect(text()).not.toContain("— 1 matched");
  });
});
