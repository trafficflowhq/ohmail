import type { EngineMessage, MessageBodyWire, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { SearchIndex } from "../src/search.js";
import { OhmailEngine, type ServerSearchWire } from "../src/engine.js";
import { MemoryMirrorStore } from "../src/store.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";
import type { SyncChange, SyncResponse } from "../src/types.js";

/**
 * GAP WHAT SEARCH ACTUALLY COVERS, AND THE SENTENCE THAT SAID OTHERWISE.
 *
 * The shipped product told the user *"Searching the server archive isn't wired up yet. These
 * local results are complete."* They were not. The local index reads `subject`, `from` and
 * `snippet`; `m.body` is a fixtures-only extra the wire `MessageDTO` has no field for
 * (`packages/services/src/dto/types.ts` → `MessageDTO`), and `snippet` is `bodySnippet()` in
 * `packages/core/src/pipeline.ts`: whitespace-collapsed, `.slice(0, 200)`.
 *
 * Measured on the hosted service on 2026-08-04 (both live mailboxes):
 *
 *   most stored bodies are longer than the snippet cap, and a large share longer than
 *   their own snippet · the median body runs well past the cap · many snippets
 *   sit exactly on the cap and some are empty · only a small part of the stored body
 *   characters fell inside a snippet, so little of the mail was locally searchable.
 *
 * The first three tests are the DEFECT ITSELF, and the second of them is the one that would
 * have caught it originally: a term that exists only past character 200 of a LIVE-shaped row
 * has to be findable through some path the user actually has. Before this slice there was
 * none — `GET /search` was mounted, spend-classed `read`, RRF-ranked, contract-tested and had
 * ZERO callers on any surface.
 *
 * The demo-shaped control beside it is deliberate: without it, a regression that broke the
 * INDEX rather than the coverage would pass the live case for the wrong reason.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date: "2026-08-04T09:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** `packages/core/src/pipeline.ts` → `bodySnippet`: collapse whitespace, trim, `.slice(0, 200)`. */
const snippetOf = (body: string): string => body.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * A body shaped like the production median (well past the snippet cap) with its distinguishing term well
 * past the snippet cap. "ZQXBRIM" appears nowhere else, so a hit for it is a hit on the body.
 */
const LONG_BODY =
  "Thank you for your order and for your patience while we packed it. ".repeat(23) +
  "The reference for this shipment is ZQXBRIM and it will arrive on Tuesday.";

interface Calls { body: string[]; server: string[] }

function adapterOf(over: Partial<EngineAdapter> = {}): EngineAdapter & { calls: Calls } {
  const calls: Calls = { body: [], server: [] };
  return {
    calls,
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async (id: string): Promise<MessageBodyWire | null> => {
      calls.body.push(id);
      return null;
    },
    ...over,
  };
}

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    messages.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return store;
}

async function engineWith(
  messages: EngineMessage[],
  over: Partial<EngineAdapter> = {},
): Promise<{ engine: OhmailEngine; calls: Calls; store: MemoryMirrorStore }> {
  const store = await mirrorOf(messages);
  const adapter = adapterOf(over);
  return { engine: new OhmailEngine({ adapter, store, now: () => NOW }), calls: adapter.calls, store };
}

/** The archive transport, as the HttpAdapter will implement it: one `GET /search`. */
function archiveOf(rows: EngineMessage[]): {
  searchServer: (q: string, o: { limit?: number }) => Promise<ServerSearchWire>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    searchServer: async (q) => {
      calls.push(q);
      // Stands in for `websearch_to_tsquery` over `message_bodies.body_tsv` — the point is
      // that the SERVER matches on the whole body, which is the half this device does not have.
      const hits = rows.filter((r) => (r.body ?? "").toLowerCase().includes(q.toLowerCase()));
      return { items: hits.map((r) => ({ ...r, body: undefined })), total: hits.length };
    },
  };
}

describe("the corpus the local index can see", () => {
  it("the snippet caps at 200 characters and the term sits past it", () => {
    const s = snippetOf(LONG_BODY);
    expect(s).toHaveLength(200);
    expect(LONG_BODY.length).toBeGreaterThan(1_500); // longer than a typical body
    expect(LONG_BODY.indexOf("ZQXBRIM")).toBeGreaterThan(200);
    expect(s).not.toContain("ZQXBRIM");
  });

  it("a DEMO-shaped row carries `body` and it is STILL not searched locally", async () => {
    /**
     * WHAT THIS ASSERTED BEFORE 0.19, AND WHY IT IS INVERTED RATHER THAN DELETED.
     *
     * `FixturesAdapter` rows carry `body`, a field the wire `MessageDTO` has not got, and the
     * index used to read it — which is why every local-search test in this package passed while
     * a live account could not find the same words. The index no longer reads a body from any
     * source, so the fixture world and a live account now answer the SAME question, and this
     * row is the assertion that they do. One rule, one sentence on screen, true on every
     * surface: the alternative was a scope line that had to be right per surface.
     */
    const { engine } = await engineWith([msg({ id: "demo", snippet: snippetOf(LONG_BODY), body: LONG_BODY })]);
    const res = engine.search("ZQXBRIM");
    expect(res.items).toHaveLength(0);
    expect(res.coverage).toEqual({ messages: 1, full: 0 });
    // …and the 200 characters it DOES hold answer, so this is a narrowed index, not a dead one.
    expect(engine.search("patience").items.map((h) => h.message.id)).toEqual(["demo"]);
  });

  it("a LIVE-shaped row is snippet-only — the local index misses it, and SAYS so", async () => {
    // THE DEFECT. Red if `coverage` ever reports this row as `full`: that number is what the
    // UI's sentence is built from, and a wrong one puts the old claim back in different words.
    const { engine } = await engineWith([msg({ id: "live", snippet: snippetOf(LONG_BODY) })]);
    const res = engine.search("ZQXBRIM");
    expect(res.items).toHaveLength(0);
    expect(res.coverage).toEqual({ messages: 1, full: 0 });
    // …and it is genuinely indexed, just truncated: the snippet's own words still match.
    expect(engine.search("patience").items.map((h) => h.message.id)).toEqual(["live"]);
  });

  it("THE GUARD: a term past character 200 of a live-shaped row is still findable — via the archive", async () => {
    // This is the assertion whose absence let that change ship. It fails the moment the archive pass
    // stops reaching a term the local index cannot see, which is the whole defect.
    const row = msg({ id: "live", snippet: snippetOf(LONG_BODY), body: LONG_BODY });
    const archive = archiveOf([row]);
    const { engine } = await engineWith(
      [msg({ id: "live", snippet: snippetOf(LONG_BODY) })],
      archive as unknown as Partial<EngineAdapter>,
    );

    expect(engine.search("ZQXBRIM").items).toHaveLength(0);   // local: still blind
    const out = await engine.searchServer("ZQXBRIM");
    expect(out.state).toBe("ready");
    expect(out.state === "ready" && out.items.map((m) => m.id)).toEqual(["live"]);
    expect(out.state === "ready" && out.total).toBe(1);
    expect(archive.calls).toEqual(["ZQXBRIM"]);
  });

  it("HYDRATING A BODY DOES NOT WIDEN THE LOCAL INDEX — and `coverage.full` stays 0", async () => {
    /**
     * THE MITIGATION'S OWN GUARD. This asserted the opposite: that an opened message
     * put its whole text into the instant index. It did — and a mailbox with thousands of
     * hydrated bodies then made one index build seconds of main-thread JavaScript, which a
     * version bump asked for again on the next keystroke. Measured on a large mirror
     * with most of its bodies hydrated: many times the characters tokenized per build against a few
     * with them gone, and typing one word while the mirror moved cost seconds of CPU.
     *
     * So the reverse is now the contract, and it is asserted in the one place where the old
     * behaviour was cheapest to bring back by accident: the body IS on the device, the record
     * IS `ready`, and the index still does not read it. A `full` that ever moves off 0 puts the
     * whole-text claim back into the sentence on screen, so the number is pinned beside it.
     */
    const { engine, store } = await engineWith(
      [msg({ id: "live", snippet: snippetOf(LONG_BODY) })],
      { fetchBody: async () => ({ text: LONG_BODY }) },
    );
    expect(engine.search("ZQXBRIM").items).toHaveLength(0);

    await engine.hydrateBody("live");
    expect(store.get("message_body", "live")).toMatchObject({ state: "ready" });

    const res = engine.search("ZQXBRIM");
    expect(res.items).toHaveLength(0);
    expect(res.coverage).toEqual({ messages: 1, full: 0 });
  });

  it("a body that is `loading` or `failed` is not counted either — nor is a `ready` one", async () => {
    // The number cannot inflate itself by counting requests, and (since that change) cannot
    // inflate itself by counting text either. Both states, one assertion.
    const { engine, store } = await engineWith(
      [msg({ id: "live", snippet: snippetOf(LONG_BODY) })],
      { fetchBody: async () => { throw new Error("500 from the body endpoint"); } },
    );
    await engine.hydrateBody("live");
    expect(store.get("message_body", "live")).toMatchObject({ state: "failed" });
    expect(engine.search("patience").coverage).toEqual({ messages: 1, full: 0 });
  });
});

describe("the archive seam", () => {
  it("an adapter with no `searchServer` is UNAVAILABLE, and nothing is requested", async () => {
    // The demo and the desktop tier. `unavailable` is a first-class answer the UI states —
    // it is not an empty result, because "we searched everything and found nothing" is a claim
    // and this is the case where nothing was searched at all.
    const { engine } = await engineWith([msg({ id: "m1" })]);
    expect(engine.serverSearchAvailable()).toBe(false);
    expect(await engine.searchServer("anything")).toEqual({ state: "unavailable" });
  });

  it("a transport answering `null` is UNAVAILABLE, not an empty `ready`", async () => {
    const { engine } = await engineWith([msg({ id: "m1" })], {
      searchServer: async () => null,
    } as unknown as Partial<EngineAdapter>);
    expect(engine.serverSearchAvailable()).toBe(true);
    expect(await engine.searchServer("anything")).toEqual({ state: "unavailable" });
  });

  it("`EngineOptions.serverSearch` overrides the adapter", async () => {
    const store = await mirrorOf([msg({ id: "m1" })]);
    const engine = new OhmailEngine({
      adapter: adapterOf(),
      store,
      now: () => NOW,
      serverSearch: async () => ({ items: [msg({ id: "server-only" })], total: 41 }),
    });
    expect(engine.serverSearchAvailable()).toBe(true);
    const out = await engine.searchServer("q");
    expect(out.state === "ready" && out.items.map((m) => m.id)).toEqual(["server-only"]);
    expect(out.state === "ready" && out.total).toBe(41);
  });

  it("NEVER rejects — a refusal becomes a `failed` outcome carrying the server's sentence", async () => {
    // Every caller is a React effect behind a debounce. A rejection there is an unhandled
    // promise and, at worst, an error boundary over somebody's mailbox — so the outcome is a
    // value the UI renders, exactly as `hydrateBody` decided for the same reason.
    const { engine } = await engineWith([msg({ id: "m1" })], {
      searchServer: async () => { throw new Error("Your plan's monthly credits are used up."); },
    } as unknown as Partial<EngineAdapter>);
    const out = await engine.searchServer("q");
    // The outcome also carries the error's CLASS for a log line (FIX-023), never its text there.
    expect(out).toEqual({ state: "failed", error: "Your plan's monthly credits are used up.", errorClass: "Error" });
  });

  it("single-flight per query: two concurrent callers make ONE request", async () => {
    const archive = archiveOf([msg({ id: "a", body: "hello ZQXBRIM" })]);
    const { engine } = await engineWith([msg({ id: "a" })], archive as unknown as Partial<EngineAdapter>);
    const [x, y] = await Promise.all([engine.searchServer("ZQXBRIM"), engine.searchServer("ZQXBRIM")]);
    expect(archive.calls).toEqual(["ZQXBRIM"]);
    expect(x).toEqual(y);
    // …and the entry is released, so the next question is asked rather than replayed.
    await engine.searchServer("ZQXBRIM");
    expect(archive.calls).toEqual(["ZQXBRIM", "ZQXBRIM"]);
  });

  it("an empty query asks nothing and answers empty", async () => {
    const archive = archiveOf([]);
    const { engine } = await engineWith([msg({ id: "a" })], archive as unknown as Partial<EngineAdapter>);
    // `tier: "exact"` on the short-circuit, not `"similar"`: an empty query did not fail to find
    // a literal match, it asked nothing — and a surface reading this must not put a "Similar"
    // heading over a blank box.
    expect(await engine.searchServer("   ")).toEqual({
      state: "ready", items: [], total: 0, tier: "exact", totalExact: true, ms: null,
      nextCursor: null, bounded: false, indexed: null, facets: null,
    });
    expect(archive.calls).toEqual([]);
  });
});

describe("the index does not read `message_body` at all", () => {
  it("SearchIndex.build ignores a READY body record, whatever it holds", async () => {
    // Straight at the index, without the engine, so the rule is attributable to `build` rather
    // than showing up as "search got worse". The body is present, ready and holds a word that
    // appears nowhere else — the strongest shape of the thing that must not happen.
    const store = await mirrorOf([msg({ id: "a", snippet: "" }), msg({ id: "b", snippet: "" })]);
    await store.putLocal("message_body", "a", { messageId: "a", state: "ready", text: "kingfisher" });
    await store.putLocal("message_body", "b", { messageId: "b", state: "loading", text: "" });

    const idx = SearchIndex.build(store);
    expect(idx.search("kingfisher").items).toHaveLength(0);
    expect(idx.coverage()).toEqual({ messages: 2, full: 0 });
  });

  it("…and the subject of the very same row is indexed — the walk ran", () => {
    // ANTI-VACUITY. Every assertion above is an absence, and an index that indexed NOTHING
    // would satisfy all of them. This is the positive control that the corpus was walked.
    const idx = new SearchIndex();
    idx.add(msg({ id: "a", subject: "Kingfisher invoice", snippet: "a short preview" }));
    expect(idx.search("kingfisher").items.map((h) => h.message.id)).toEqual(["a"]);
    expect(idx.search("preview").items.map((h) => h.message.id)).toEqual(["a"]);
    expect(idx.coverage()).toEqual({ messages: 1, full: 0 });
  });
});
