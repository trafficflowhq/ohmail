import type { EngineMessage, MessageBodyWire, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { SearchIndex } from "../src/search.js";
import { OhmailEngine } from "../src/engine.js";
import { MemoryMirrorStore } from "../src/store.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";
import type { SyncChange, SyncResponse } from "../src/types.js";

/**
 * SECOND HALF — THE INDEX IS UPDATED, NOT REBUILT.
 *
 * The mitigation bounded the cost of the rebuild; it did not remove it, and what it cost was
 * freshness — past a few hundred messages the index was rebuilt at most once every thirty seconds,
 * so mail arriving inside that floor was not in the instant answer. `SearchIndex.apply` consumes
 * the messages that MOVED, so a version bump costs those and nothing else, and the floor is gone.
 *
 * TWO THINGS MAKE IT CORRECT RATHER THAN MERELY FAST, and both are what this file measures:
 *
 *   · THE REVERSE MAP. A removal takes back exactly what the message posted. Guess at it — walk
 *     the terms, or re-tokenize fields that have already changed — and a posting survives its
 *     message: a query answers with mail the mirror does not hold, and clicking it opens nothing.
 *   · THE CEILING AT THE TOP. The catch-up refuses past `SEARCH_INDEX_SYNC_MAX` changed messages
 *     rather than spending the keystroke, so a re-bootstrap that replaces every row falls back to
 *     the sliced build instead of arriving as one whole-mirror walk inside a keypress.
 */

const NOW = new Date("2026-09-13T12:00:00.000Z");

/** Past the engine's synchronous bound, so the incremental path is the one under test. */
const N = 2_000;

const TOPICS = [
  "Kiln schedule", "Invoice for July", "Shelf measurements", "Newsletter arrivals",
  "Order shipped", "Meeting moved", "Draft chapter", "Studio rent", "Workshop places", "Glaze evening",
];
const NAMES = ["Lena", "Jonas", "Mara", "Piet", "Nora", "Ivo", "Greta", "Samu"];

let seq = 0;

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  const n = Number(/\d+/.exec(over.id)?.[0] ?? 0);
  return {
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `${TOPICS[n % TOPICS.length]} ${n}`,
    from: { name: NAMES[n % NAMES.length]!, address: `${NAMES[n % NAMES.length]!.toLowerCase()}@atelier.example` },
    to: [],
    cc: [],
    date: new Date(NOW.getTime() - n * 60_000).toISOString(),
    folder: "ohmail/News",
    snippet: `We looked at batch ${n} again on Tuesday.`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

async function mirrorOf(n: number): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const rows: SyncChange[] = [];
  for (let i = 0; i < n; i++) {
    const m = msg({ id: `m-${i}` });
    rows.push({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });
  }
  await store.applyChanges(rows);
  return store;
}

async function write(store: MemoryMirrorStore, changes: SyncChange[]): Promise<void> {
  await store.applyChanges(changes);
}

const create = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });
const update = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "update", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });
const remove = (id: string): SyncChange =>
  ({ type: "message", op: "delete", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: null });

function adapterOf(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async (): Promise<MessageBodyWire | null> => null,
  };
}

const ids = (hits: { message: EngineMessage }[]): string[] => hits.map((h) => h.message.id);

describe("apply — a removal takes back exactly what the message posted", () => {
  it("a removed message answers no query it used to answer, and leaves its neighbours alone", () => {
    const idx = new SearchIndex();
    const sender = { name: "Lena Berg", address: "lena@atelier.example" };
    idx.add(msg({ id: "m-1", subject: "Kingfisher invoice", snippet: "the quokkaledger reference", from: sender }));
    idx.add(msg({ id: "m-2", subject: "Kingfisher receipt", snippet: "an ordinary preview", from: sender }));
    expect(ids(idx.search("kingfisher").items).sort()).toEqual(["m-1", "m-2"]);

    idx.apply({ upserted: [], removed: ["m-1"] });

    // Every field it posted under: the shared subject term, its own snippet term, and its address.
    expect(ids(idx.search("kingfisher").items)).toEqual(["m-2"]);
    expect(idx.search("quokkaledger").items).toHaveLength(0);
    expect(ids(idx.messagesWith("lena@atelier.example", "any").items)).toEqual(["m-2"]);
    expect(idx.coverage()).toEqual({ messages: 1, full: 0 });
    // …and the prefix arm, which walks the term list rather than looking one up.
    expect(ids(idx.search("quokka").items)).toEqual([]);
  });

  it("an UPDATE drops the old terms — the previous subject stops answering", () => {
    /*
     * THE CASE A RE-TOKENIZING REMOVAL GETS WRONG. Taking a message out by reading its CURRENT
     * fields removes the postings it would make NOW, not the ones it made then, so the old
     * subject's term keeps its posting and the message answers a query about words it no longer
     * carries. The reverse map is read instead, which is why this passes.
     */
    const idx = new SearchIndex();
    idx.add(msg({ id: "m-1", subject: "Kingfisher invoice", snippet: "quokkaledger" }));
    expect(ids(idx.search("kingfisher").items)).toEqual(["m-1"]);

    idx.apply({ upserted: [msg({ id: "m-1", subject: "Heron receipt", snippet: "sandpiper" })], removed: [] });

    expect(idx.search("kingfisher").items).toHaveLength(0);
    expect(idx.search("quokkaledger").items).toHaveLength(0);
    expect(ids(idx.search("heron").items)).toEqual(["m-1"]);
    expect(ids(idx.search("sandpiper").items)).toEqual(["m-1"]);
    // One message, not two: an upsert replaces, it does not accumulate.
    expect(idx.coverage()).toEqual({ messages: 1, full: 0 });
  });

  it("a term whose last posting goes takes its posting map with it", () => {
    // Not thrift: the prefix and fuzzy arms walk the TERM LIST on every keystroke, so an empty
    // map left behind is work paid for ever on a mailbox that turns over.
    const idx = new SearchIndex();
    idx.add(msg({ id: "m-1", subject: "Kingfisher invoice" }));
    idx.add(msg({ id: "m-2", subject: "Kingfisher receipt" }));
    const terms = (): string[] => [...(idx as unknown as { postings: Map<string, unknown> }).postings.keys()];
    expect(terms()).toContain("invoice");
    expect(terms()).toContain("kingfisher");

    idx.apply({ upserted: [], removed: ["m-1"] });
    expect(terms(), "the term only m-1 posted survived its message").not.toContain("invoice");
    expect(terms(), "a term another message still posts was dropped").toContain("kingfisher");
  });

  it("an address posted by nobody is gone FROM THE MAP, and one still posted stays", () => {
    /*
     * READ STRUCTURALLY, and that is the point rather than laziness. `messagesWith` already skips
     * a posting whose message it cannot find, so a leaked address entry is INVISIBLE through the
     * public answer — the assertions below on `counts` and `items` pass with the removal's
     * address half deleted outright (measured: that mutation is green through the answer alone).
     * What the leak costs is memory that grows for as long as the tab is open on a mailbox that
     * turns over, plus a walk over dead entries on every address query. A memory invariant is
     * watched where it lives, so this reads the map.
     */
    const idx = new SearchIndex();
    idx.add(msg({ id: "m-1", to: [{ name: null, address: "solo@example.test" }] }));
    idx.add(msg({ id: "m-2", to: [{ name: null, address: "shared@example.test" }] }));
    idx.add(msg({ id: "m-3", to: [{ name: null, address: "shared@example.test" }] }));
    const addresses = (idx as unknown as { addresses: Map<string, Map<string, unknown>> }).addresses;
    expect([...addresses.keys()]).toContain("solo@example.test");

    idx.apply({ upserted: [], removed: ["m-1", "m-2"] });

    expect([...addresses.keys()], "an address nobody posts any more kept its bucket")
      .not.toContain("solo@example.test");
    expect([...addresses.get("shared@example.test")!.keys()], "a dead posting survived its message")
      .toEqual(["m-3"]);
    // …and the public answer agrees with the map, which is what makes the map's shape worth pinning.
    expect(idx.messagesWith("solo@example.test", "any").counts).toEqual({ any: 0, from: 0, to: 0 });
    expect(ids(idx.messagesWith("shared@example.test", "to").items)).toEqual(["m-3"]);
  });
});

describe("refresh — the delta is found by entity identity, over every write path", () => {
  it("costs the messages that moved, not the mirror", async () => {
    /*
     * THE CLAIM, AS A RATIO. A rebuild indexes N messages; a catch-up after one page indexes that
     * page. Counted in `add` CALLS rather than milliseconds, because that is the work the freeze
     * was made of and a count does not depend on the machine the suite runs on.
     */
    const store = await mirrorOf(N);
    const idx = SearchIndex.build(store);
    let adds = 0;
    const counted = idx as unknown as { add: (m: EngineMessage) => void };
    const real = counted.add.bind(idx);
    counted.add = (m: EngineMessage) => { adds++; real(m); };

    const page: SyncChange[] = [];
    for (let i = 0; i < 50; i++) page.push(create(msg({ id: `new-${i}` })));
    await write(store, page);

    expect(idx.refresh(store, 500)).toBe(50);
    expect(adds, "a catch-up re-indexed more than the page that arrived").toBe(50);
    expect(idx.coverage().messages).toBe(N + 50);
    expect(ids(idx.search("kiln", { limit: 5_000 }).items)).toContain("new-0");

    // The ratio the change is about: the moved messages against the whole mirror, measured in the same unit.
    expect(adds / N).toBeLessThan(0.05);
  });

  it("a mirror that did not move costs no indexing at all", async () => {
    const store = await mirrorOf(200);
    const idx = SearchIndex.build(store);
    let adds = 0;
    const counted = idx as unknown as { add: (m: EngineMessage) => void };
    const real = counted.add.bind(idx);
    counted.add = (m: EngineMessage) => { adds++; real(m); };

    expect(idx.refresh(store, 500)).toBe(0);
    expect(adds).toBe(0);
  });

  it("sees a delete, an update and a create in one page", async () => {
    const store = await mirrorOf(200);
    const idx = SearchIndex.build(store);
    expect(ids(idx.search("kingfisher").items)).toEqual([]);

    await write(store, [
      remove("m-0"),
      update(msg({ id: "m-1", subject: "Kingfisher invoice" })),  // m-0's sender, kept below
      create(msg({ id: "arrived", subject: "Kingfisher receipt" })),
    ]);

    expect(idx.refresh(store, 500)).toBe(3);
    expect(idx.coverage().messages).toBe(200);
    expect(ids(idx.search("kingfisher").items).sort()).toEqual(["arrived", "m-1"]);
    expect(idx.messagesWith("lena@atelier.example", "any").items.map((h) => h.message.id))
      .not.toContain("m-0");
  });

  it("refuses past its ceiling rather than spending the call, and refuses BEFORE indexing anything", async () => {
    /*
     * THE BOUND ENTERED AT THE TOP. A re-bootstrap replaces every row, and a catch-up that took
     * that on would be exactly the whole-mirror walk inside a keystroke this change removes. The
     * refusal is also asserted to have written NOTHING: a refusal after a partial apply would
     * leave an index that is neither the old one nor the new one.
     */
    const store = await mirrorOf(200);
    const idx = SearchIndex.build(store);
    const before = idx.search("kiln", { limit: 5_000 }).items.length;

    const page: SyncChange[] = [];
    for (let i = 0; i < 60; i++) page.push(create(msg({ id: `new-${i}`, subject: "Kingfisher invoice" })));
    await write(store, page);

    expect(idx.refresh(store, 50)).toBeNull();
    expect(idx.coverage().messages, "the refusal applied part of the page").toBe(200);
    expect(idx.search("kingfisher").items).toHaveLength(0);
    expect(idx.search("kiln", { limit: 5_000 }).items.length).toBe(before);

    // The control: the same page, under a ceiling that admits it.
    expect(idx.refresh(store, 500)).toBe(60);
    expect(idx.coverage().messages).toBe(260);
  });
});

describe("the engine — a version bump costs the messages that moved", () => {
  async function engineOn(store: MemoryMirrorStore): Promise<OhmailEngine> {
    return new OhmailEngine({ adapter: adapterOf(), store, now: () => NOW });
  }

  it("a large mirror answers with mail that arrived a moment ago, in the same synchronous call", async () => {
    const store = await mirrorOf(N);
    const engine = await engineOn(store);
    await engine.warmSearchIndex();
    expect(engine.search("kiln").items.length).toBeGreaterThan(0);

    await write(store, [create(msg({ id: "arrived", subject: "Kingfisher invoice" }))]);
    expect(ids(engine.search("kingfisher").items)).toEqual(["arrived"]);

    await write(store, [remove("arrived")]);
    expect(engine.search("kingfisher").items).toHaveLength(0);
  });

  it("a page larger than the ceiling falls back to the sliced build rather than to a frozen frame", async () => {
    const store = await mirrorOf(N);
    const engine = await engineOn(store);
    await engine.warmSearchIndex();

    const page: SyncChange[] = [];
    for (let i = 0; i < 600; i++) page.push(create(msg({ id: `new-${i}`, subject: "Kingfisher invoice" })));
    await write(store, page);

    // The catch-up refuses, so the call answers `indexing` rather than paying 600 indexings.
    const during = engine.search("kingfisher");
    expect(during.items).toHaveLength(0);
    expect(during.indexing).toBe(true);

    await engine.warmSearchIndex();
    expect(engine.search("kingfisher", { limit: 5_000 }).items.length).toBe(600);
    expect(engine.search("kingfisher").indexing).toBe(false);
  });
});

describe("the fuzzy arm — pruned, and not narrowed", () => {
  it("a first-character typo still reaches its answer", () => {
    /*
     * THE PRUNE THE BRIEF ASKED FOR AND THIS DOES NOT DO. Refusing a term that does not share the
     * query's first bigram is cheap and LOSSY: `anna` against `hanna` shares three of five and six
     * trigrams for a Dice similarity of 0.55, well over the 0.4 threshold, and a first-character
     * typo is among the commonest there is. What ships instead is a set-size refusal that is
     * provably lossless — `2c/(|A|+|B|)` with `c ≤ min` cannot reach 0.4 once one set is more than
     * four times the other — so nothing a person could have found before is unreachable now.
     */
    const idx = new SearchIndex();
    idx.add(msg({ id: "m-1", subject: "hanna" }));
    const res = idx.search("anna");
    expect(res.tier).toBe("similar");
    expect(ids(res.similar)).toEqual(["m-1"]);
  });

  it("the size refusal drops only what could not have matched", () => {
    // A long term against a short query: `cannotReach` refuses it, and Dice agrees it could not
    // have cleared the threshold. The pair is the assertion — a refusal alone measures nothing.
    const idx = new SearchIndex();
    idx.add(msg({ id: "long", subject: "internationalization" }));
    idx.add(msg({ id: "near", subject: "kiln" }));
    const res = idx.search("kilm");
    expect(ids(res.similar), "a term twenty characters long answered a four-character query")
      .not.toContain("long");
    expect(ids(res.similar), "the prune took the real answer with it").toContain("near");
  });

  it("a term below the fuzzy floor mints no trigram set", () => {
    // The floor both sides read: `fuzzyHits` skips these terms before looking a set up, so one
    // minted for them is memory nothing reads — and short terms are the common ones.
    const idx = new SearchIndex();
    idx.add(msg({ id: "m-1", subject: "in the kiln" }));
    const cache = (idx as unknown as { trigramCache: Map<string, Set<string>> }).trigramCache;
    expect([...cache.keys()]).toContain("kiln");
    expect([...cache.keys()], "a two-character term earned a trigram set no arm can reach")
      .not.toContain("in");
  });
});
