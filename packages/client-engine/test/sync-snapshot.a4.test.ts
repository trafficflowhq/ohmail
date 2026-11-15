import { describe, expect, it } from "vitest";
import {
  CursorExpiredError,
  HttpAdapter,
  encodeSeqCursor,
  decodeSeqCursor,
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineDraft,
  type EngineMessage,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
  type SyncSnapshotPage,
} from "../src/index.js";

/**
 * ═══ `GET /sync/snapshot` AS THE COLD-START PATH ══════════════════════════════════════
 *
 * `since=0` replays the whole change log: every intermediate state of every row, in the order
 * they happened. A snapshot is the CURRENT state instead, read at one consistent point named by
 * `asOfSeq`, paged newest-first. The two things that make it safe are both structural rather
 * than hoped for:
 *
 *  · the cursor is committed with the LAST page and nothing else can write it, so a crash
 *    mid-snapshot leaves "0" and the next start re-snapshots; and
 *  · `asOfSeq` is the READ POINT, identical on every page, so the delta drain that resumes from
 *    it cannot miss a change committed while the pages were in flight.
 *
 * Every guard below was watched RED against a named mutation of the implementation, then the
 * implementation was restored.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
const AS_OF = 900;

function msg(id: string): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date: NOW.toISOString(),
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
  };
}

/** A snapshot page's changes: op "create", full DTO, seq === asOfSeq (contract). */
function snapChanges(ids: string[], asOfSeq = AS_OF): SyncChange[] {
  return ids.map((id) => ({
    type: "message", op: "create", id, seq: asOfSeq, updatedAt: NOW.toISOString(), entity: msg(id),
  }));
}

/** The same, for the DRAFTS a page carries — a bounded set per page, not all of them on page 1. */
function draftChanges(ids: string[], asOfSeq = AS_OF): SyncChange[] {
  return ids.map((id) => ({
    type: "draft", op: "create", id, seq: asOfSeq, updatedAt: NOW.toISOString(),
    entity: {
      id, mailboxId: "mb", threadId: null, inReplyToMessageId: null,
      subject: `Draft ${id}`, body: `the text of ${id}`, to: [], cc: [], bcc: [],
      rationale: null, status: "draft", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    },
  }));
}

interface Recorder {
  /** Every `since=` the delta endpoint was asked for, in order. */
  syncSince: string[];
  /** Every paging token the snapshot endpoint was asked for (`null` = first page). */
  snapshotCursors: Array<string | null>;
}

interface HarnessOptions {
  /** Snapshot pages in order. Omit ⇒ the adapter has NO snapshot capability at all. */
  pages?: Array<{ ids: string[]; nextCursor: string | null; asOfSeq?: number; drafts?: string[] }>;
  /** The run of the server's store every page states. Omit ⇒ a server that states none. */
  storeGeneration?: number;
  /** Delta responses, keyed by the `since` they answer. Anything unlisted is a quiet page. */
  sync?: (since: string, n: number) => SyncResponse | Error;
}

function harness(opts: HarnessOptions): { adapter: EngineAdapter; rec: Recorder } {
  const rec: Recorder = { syncSince: [], snapshotCursors: [] };
  let syncCalls = 0;

  const base = {
    sync: async (params: { since: string }): Promise<SyncResponse> => {
      rec.syncSince.push(params.since);
      const out = opts.sync?.(params.since, syncCalls++);
      if (out instanceof Error) throw out;
      return (
        out ?? {
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: params.since,
          hasMore: false,
          serverTime: NOW.toISOString(),
        }
      );
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  };

  if (!opts.pages) return { adapter: base as unknown as EngineAdapter, rec };

  const pages = opts.pages;
  const snapshot = async (params: { cursor?: string } = {}): Promise<SyncSnapshotPage> => {
    rec.snapshotCursors.push(params.cursor ?? null);
    const i = params.cursor === undefined ? 0 : Number(params.cursor);
    const page = pages[i];
    if (!page) throw new Error(`no snapshot page for cursor ${String(params.cursor)}`);
    const asOfSeq = page.asOfSeq ?? AS_OF;
    return {
      asOfSeq,
      changes: [...snapChanges(page.ids, asOfSeq), ...draftChanges(page.drafts ?? [], asOfSeq)],
      nextCursor: page.nextCursor,
      window: { days: 30, minRows: 500, maxRows: 900 },
      // Spread, so a server that states no run produces a page with the field ABSENT rather than
      // one carrying `undefined` — the two are the same to a reader and not to a key census.
      ...(opts.storeGeneration === undefined ? {} : { storeGeneration: opts.storeGeneration }),
    };
  };

  return { adapter: { ...base, snapshot } as unknown as EngineAdapter, rec };
}

/**
 * `{ mode: "full" }` is SAID: the engine's absent branch is a window, and a windowed WARM mirror
 * owes `rehydrateForPolicy`'s labeled-tail walk before the drain — a second `snapshot` call that
 * the 410 guards below would read as a re-bootstrap. The window has its own file.
 */
function engineOf(adapter: EngineAdapter, store: MemoryMirrorStore): OhmailEngine {
  return new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: { mode: "full" } });
}

async function freshStore(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  return store;
}

function ids(store: MemoryMirrorStore): string[] {
  return store.entries<EngineMessage>("message").map((e) => e.id).sort();
}

function draftIds(store: MemoryMirrorStore): string[] {
  return store.entries<EngineDraft>("draft").map((e) => e.id).sort();
}

// ── THE COLD START ─────────────────────────────────────────────────────────────────────────

describe("a cold mirror", () => {
  /**
   * WATCHED RED by deleting the `if (this.store.getCursor() === "0" && this.snapshotFn)` line at
   * the top of `drain()`: `syncSince` becomes `["0", …]` and `snapshotCursors` is empty.
   */
  it("takes the snapshot instead of since=0 when the adapter has the capability", async () => {
    const { adapter, rec } = harness({
      pages: [
        { ids: ["a", "b"], nextCursor: "1" },
        { ids: ["c"], nextCursor: null },
      ],
    });
    const store = await freshStore();
    await engineOf(adapter, store).start();

    expect(rec.snapshotCursors).toEqual([null, "1"]);
    // The delta drain resumes from asOfSeq — it never asks for `since=0`.
    expect(rec.syncSince).toEqual([encodeSeqCursor(AS_OF)]);
    expect(ids(store)).toEqual(["a", "b", "c"]);
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));
  });

  /**
   * ── AND THE CURSOR IT MINTS CARRIES THE RUN THE SNAPSHOT NAMED ─────────────────────────────
   *
   * This is the one cursor on the wire the SERVER does not write: the client makes it out of
   * `asOfSeq`. A desktop store can lose a committed tail and re-derive it at the same seqs, and
   * the server refuses a cursor belonging to the run that lost it — so a cursor minted here
   * without the run would be refused on the next launch, or worse, admitted by a store still on
   * its first run and then silently skip the re-derived rows.
   *
   * WATCHED RED by dropping the second argument at `encodeSeqCursor(page.asOfSeq, …)` in
   * `runSnapshot`: both assertions read the run-less cursor. The case above it, whose server
   * states no run, is the positive control that the hosted wire does not move.
   */
  it("mints its first delta cursor carrying the run the snapshot stated", async () => {
    const { adapter, rec } = harness({
      pages: [{ ids: ["a"], nextCursor: null }],
      storeGeneration: 5,
    });
    const store = await freshStore();
    await engineOf(adapter, store).start();

    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF, 5));
    expect(rec.syncSince).toEqual([encodeSeqCursor(AS_OF, 5)]);
    // The seq still reads out of it — the run is carried, not substituted for the position.
    expect(decodeSeqCursor(store.getCursor())).toBe(AS_OF);
  });

  /**
   * THE FALLBACK IS NOT DEAD CODE — it is what the FixturesAdapter and every adapter older than
   * this route take.
   *
   * WATCHED RED by having the engine ASSUME the capability: resolving `snapshotFn` to a throwing
   * stub rather than `null` when the adapter has no `snapshot`. That is the realistic form of
   * this bug — "every adapter has it by now" — and it takes the demo down at `start()`.
   */
  it("falls back to since=0 when the adapter has NO snapshot capability", async () => {
    const { adapter, rec } = harness({});
    const store = await freshStore();
    await engineOf(adapter, store).start();

    expect(rec.snapshotCursors).toEqual([]);
    expect(rec.syncSince).toEqual(["0"]);
  });

  /**
   * WATCHED RED by dropping the cursor half of the condition (`if (this.snapshotFn) await
   * this.runSnapshot()`): every drain re-snapshots the whole mailbox, which is a full bootstrap
   * on every 8-second poll. Three tests go with it.
   */
  it("does NOT re-snapshot on a warm mirror", async () => {
    const { adapter, rec } = harness({ pages: [{ ids: ["a"], nextCursor: null }] });
    const store = await freshStore();
    const engine = engineOf(adapter, store);
    await engine.start();
    rec.snapshotCursors.length = 0;

    await engine.syncOnce();
    await engine.syncOnce();

    expect(rec.snapshotCursors).toEqual([]);
  });
});

// ── THE ROUTE THAT IS NOT THERE YET ────────────────────────────────────────────────────────

describe("a snapshot route that fails on its FIRST page", () => {
  function brokenFirstPage(rec: { snapshotCalls: number; syncSince: string[] }): EngineAdapter {
    return {
      sync: async (p: { since: string; types?: string[] }): Promise<SyncResponse> => {
        // Each ask, with its type filter — the degraded bootstrap now opens with the rules-first
        // pass (`types=rule`), so the bare `since` alone would conflate two different requests.
        rec.syncSince.push(p.types?.join(",") === "rule" ? `${p.since}[rule]` : p.since);
        return {
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: p.since, hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      snapshot: async (): Promise<SyncSnapshotPage> => {
        rec.snapshotCalls++;
        throw new Error("404 — this Cloud has not deployed /sync/snapshot");
      },
    } as unknown as EngineAdapter;
  }

  /**
   * THE DEPLOY-ORDER CASE, AND IT IS NOT HYPOTHETICAL. This client can ship before the route
   * does. An engine that hard-failed its cold start would render an empty mailbox in silence —
   * `http-adapter-binding.test.ts` exists because exactly that shipped once.
   *
   * WATCHED RED by removing the try/catch from `runSnapshot`'s page fetch: `start()` rejects with
   * the 404 and the mirror never bootstraps at all.
   */
  it("falls back to since=0 and completes the drain", async () => {
    const rec = { snapshotCalls: 0, syncSince: [] as string[] };
    const store = await freshStore();

    await expect(engineOf(brokenFirstPage(rec), store).start()).resolves.toBeUndefined();

    expect(rec.snapshotCalls).toBe(1);
    // The degraded fallback opens with the rules-first pass, then the mixed replay — decisions
    // land before the mail they govern (see `bootstrap-rules-first.test.ts` for the whole claim).
    expect(rec.syncSince).toEqual(["0[rule]", "0"]);
  });

  /**
   * ONE wasted request per engine, not one per drain forever.
   *
   * WATCHED RED by deleting `this.snapshotUnavailable = true;` from the catch: the count climbs
   * with every poll, which on the shipped 8-second scheduler is a request per tab per 8 s against
   * a route that is not there.
   */
  it("latches off, so it is asked exactly once for the life of the engine", async () => {
    const rec = { snapshotCalls: 0, syncSince: [] as string[] };
    const store = await freshStore();
    const engine = engineOf(brokenFirstPage(rec), store);

    await engine.start();
    await engine.syncOnce();
    await engine.syncOnce();

    expect(rec.snapshotCalls).toBe(1);
    // This fake's empty pages return cursor "0", so the mirror STAYS cold and every drain is the
    // degraded bootstrap: rules-first pass, then the mixed replay — a pair per drain. That the
    // pair repeats is this fake's arrested cursor, not a leak; a real drain commits a cursor and
    // never re-enters the fallback (pinned by "owes no rules pass" in bootstrap-rules-first, and
    // by the sidecar's own incremental test).
    expect(rec.syncSince).toEqual(["0[rule]", "0", "0[rule]", "0", "0[rule]", "0"]);
  });

  /**
   * A failure on a LATER page must NOT fall back — falling back would be silently wrong.
   *
   * Rows carrying `seq === asOfSeq` are already in the mirror, so a `since=0` replay would have
   * every change at or below `asOfSeq` dropped by the seq guard and the un-paged remainder would
   * never arrive by either route. The mirror would settle permanently truncated and look healthy.
   *
   * WATCHED RED by removing the `if (applied) throw err;` line: `start()` resolves, the mirror
   * holds only page 1, and the cursor is a perfectly ordinary-looking delta cursor.
   */
  it("does NOT fall back once a page has been applied — it rethrows and leaves the cursor at 0", async () => {
    const store = await freshStore();
    const adapter = {
      sync: async (p: { since: string }): Promise<SyncResponse> => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: p.since, hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      snapshot: async (params: { cursor?: string } = {}): Promise<SyncSnapshotPage> => {
        if (params.cursor !== undefined) throw new Error("the connection dropped on page 2");
        return {
          asOfSeq: AS_OF, changes: snapChanges(["a"]), nextCursor: "1",
          window: { days: 30, minRows: 500 },
        };
      },
    } as unknown as EngineAdapter;

    await expect(engineOf(adapter, store).start()).rejects.toThrow("connection dropped");
    expect(store.getCursor()).toBe("0");
    expect(ids(store)).toEqual(["a"]);
  });
});

// ── GUARD 5: THE CURSOR IS COMMITTED WITH THE LAST PAGE AND NOTHING ELSE ───────────────────

describe("the cursor", () => {
  /**
   * WATCHED RED by committing on EVERY page — replacing the `applyChanges` branch of
   * `runSnapshot` with an `applyResponse` carrying `cursor: String(page.asOfSeq)`. The mirror
   * then holds a cursor of 900 over two of the three pages, and the assertion that a crash
   * leaves "0" fails.
   */
  it("stays at 0 for every page but the last, so a crash mid-snapshot re-snapshots", async () => {
    const cursorsSeen: string[] = [];
    const { adapter } = harness({
      pages: [
        { ids: ["a"], nextCursor: "1" },
        { ids: ["b"], nextCursor: "2" },
        { ids: ["c"], nextCursor: null },
      ],
    });
    const store = await freshStore();
    const engine = engineOf(adapter, store);
    // Sample the cursor after every page lands — `notify` fires once per applied page.
    // `syncOnce`, not `start`: `hydrate()` publishes once of its own before any page arrives,
    // and the subject here is what the DRAIN writes.
    engine.subscribe(() => cursorsSeen.push(store.getCursor()));
    await engine.syncOnce();

    // Three snapshot pages then one delta drain: "0", "0", then the committed asOfSeq.
    expect(cursorsSeen.slice(0, 3)).toEqual(["0", "0", encodeSeqCursor(AS_OF)]);
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));
  });

  /**
   * THE CRASH, FOR REAL: the transport dies on page 3. WATCHED RED by the same "commit on every
   * page" mutation, which leaves the cursor at 900 over a mirror holding two of three pages —
   * the one state this design must make unreachable, because the delta drain would then resume
   * past rows that never arrived.
   */
  it("leaves 0 when the snapshot dies mid-way, and the retry re-snapshots idempotently", async () => {
    let failNext = true;
    const pages: SyncSnapshotPage[] = [
      { asOfSeq: AS_OF, changes: snapChanges(["a"]), nextCursor: "1", window: { days: 30, minRows: 500 } },
      { asOfSeq: AS_OF, changes: snapChanges(["b"]), nextCursor: "2", window: { days: 30, minRows: 500 } },
      { asOfSeq: AS_OF, changes: snapChanges(["c"]), nextCursor: null, window: { days: 30, minRows: 500 } },
    ];
    const adapter = {
      sync: async (p: { since: string }): Promise<SyncResponse> => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: p.since, hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      snapshot: async (params: { cursor?: string } = {}): Promise<SyncSnapshotPage> => {
        const i = params.cursor === undefined ? 0 : Number(params.cursor);
        if (i === 2 && failNext) {
          failNext = false;
          throw new Error("transport died on the last page");
        }
        return pages[i]!;
      },
    } as unknown as EngineAdapter;

    const store = await freshStore();
    const engine = engineOf(adapter, store);

    await expect(engine.start()).rejects.toThrow("transport died");
    // Two of three pages landed; the cursor never moved.
    expect(ids(store)).toEqual(["a", "b"]);
    expect(store.getCursor()).toBe("0");

    // The next start re-snapshots from scratch. Pages 1 and 2 carry `seq === asOfSeq` for rows
    // already at that seq, so the seq guard skips them — a re-run is idempotent, not a rewrite.
    await engine.syncOnce();
    expect(ids(store)).toEqual(["a", "b", "c"]);
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));
  });
});

// ── GUARD 4: THE 410 RE-BOOTSTRAP ──────────────────────────────────────────────────────────

describe("a 410", () => {
  /**
   * WATCHED RED by removing the top-of-loop snapshot check (the `continue` after
   * `resetForBootstrap` then falls straight through to `sync({since: "0"})`): `syncSince`
   * becomes `["stale", "0"]` and the assertion that "0" is never requested fails.
   */
  it("re-snapshots rather than replaying since=0, then resumes deltas from asOfSeq", async () => {
    const { adapter, rec } = harness({
      pages: [{ ids: ["a", "b"], nextCursor: null }],
      sync: (since) => {
        if (since === "stale") return new CursorExpiredError();
        return {
          changes: {
            creates: [{ type: "message", op: "create", id: "late", seq: AS_OF + 1, updatedAt: NOW.toISOString(), entity: msg("late") }],
            updates: [], moves: [], deletes: [],
          },
          cursor: encodeSeqCursor(AS_OF + 1),
          hasMore: false,
          serverTime: NOW.toISOString(),
        };
      },
    });
    const store = await freshStore();
    // A warm mirror holding a cursor the server has since expired.
    await store.applyChanges([{ type: "message", op: "create", id: "old", seq: 5, updatedAt: NOW.toISOString(), entity: msg("old") }]);
    store.forceCursor("stale");
    // Stamped FRESH, deliberately: a warm cursor with no stamp is a stale resume, and the
    // freshness fetch would put its own snapshot call in front of the sequence this test pins.
    // That path has its own guards (stale-resume-freshness.test.ts, including freshness→410);
    // here the 410 branch is the thing under test, so the fixture keeps it in isolation.
    await store.setMeta(LAST_DRAIN_AT_META, NOW.toISOString());

    await engineOf(adapter, store).syncOnce();

    // The expired cursor, then the delta drain from asOfSeq. Never "0".
    expect(rec.syncSince).toEqual(["stale", encodeSeqCursor(AS_OF)]);
    expect(rec.syncSince).not.toContain("0");
    expect(rec.snapshotCursors).toEqual([null]);
    // Local state was discarded by the re-bootstrap and rebuilt from the snapshot + the delta.
    expect(ids(store)).toEqual(["a", "b", "late"]);
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF + 1));
  });

  /**
   * The pre-snapshot path, unchanged. WATCHED RED by making the 410 branch call `runSnapshot()`
   * unconditionally instead of routing through the capability check: an adapter without the
   * route then throws instead of replaying.
   */
  it("still replays since=0 when the adapter has no snapshot capability", async () => {
    const { adapter, rec } = harness({
      sync: (since) => (since === "stale" ? new CursorExpiredError() : undefined as unknown as SyncResponse),
    });
    const store = await freshStore();
    store.forceCursor("stale");

    await engineOf(adapter, store).syncOnce();

    expect(rec.syncSince).toEqual(["stale", "0"]);
  });

  /**
   * THE ONCE-PER-DRAIN GUARD, KEPT. A server that expires the cursor it just issued is surfaced,
   * not looped on — at most one snapshot can follow a 410 within one drain. The arm that decides
   * it is the snapshot-issued arm now (`snapshot-cursor-refused.test.ts` watches it red, and the
   * hold that spans drains); `!rebootstrapped` still bounds the route-less path.
   */
  it("surfaces a SECOND 410 within one drain instead of snapshotting again", async () => {
    const { adapter, rec } = harness({
      pages: [{ ids: ["a"], nextCursor: null }],
      sync: () => new CursorExpiredError(),
    });
    const store = await freshStore();
    store.forceCursor("stale");
    // Fresh stamp for the same reason the re-snapshot test above sets one: this pins the
    // once-per-drain 410 bound, not the stale-resume freshness fetch.
    await store.setMeta(LAST_DRAIN_AT_META, NOW.toISOString());

    await expect(engineOf(adapter, store).syncOnce()).rejects.toBeInstanceOf(CursorExpiredError);
    expect(rec.snapshotCursors).toHaveLength(1);
    expect(rec.syncSince).toEqual(["stale", encodeSeqCursor(AS_OF)]);
  });
});

// ── THE ADAPTER'S OWN PARSE ────────────────────────────────────────────────────────────────

describe("HttpAdapter.snapshot", () => {
  function adapterOver(handler: (url: string) => Response): HttpAdapter {
    return new HttpAdapter({ baseUrl: "http://x", fetch: async (url: string) => handler(url) });
  }
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("hits /sync/snapshot with no query on the first page and echoes the paging token back", async () => {
    const urls: string[] = [];
    const a = adapterOver((url) => {
      urls.push(url);
      return json({ asOfSeq: 42, changes: [], nextCursor: "page-2", window: { days: 30, minRows: 500 } });
    });
    const first = await a.snapshot();
    expect(first.nextCursor).toBe("page-2");
    await a.snapshot({ cursor: "page-2" });

    expect(urls).toEqual(["http://x/sync/snapshot", "http://x/sync/snapshot?cursor=page-2"]);
  });

  it("reads an absent nextCursor as the last page (§8), and defaults the window", async () => {
    const a = adapterOver(() => json({ asOfSeq: 42, changes: [] }));
    const page = await a.snapshot();

    expect(page.nextCursor).toBeNull();
    expect(page.window).toEqual({ days: 0, minRows: 0 });
  });

  /**
   * THE WINDOW'S CEILING IS CARRIED, AND ITS ABSENCE IS NOT A ZERO. The two floors default to 0
   * because a number is all their readers can use; a ceiling of 0 would be a claim the server
   * serves nothing, so a server that states none leaves the key off.
   */
  it("carries the window's ceiling, and leaves it absent when the server states none", async () => {
    const withCeiling = adapterOver(() =>
      json({ asOfSeq: 42, changes: [], window: { days: 90, minRows: 5000, maxRows: 10000 } }));
    expect((await withCeiling.snapshot()).window).toEqual({ days: 90, minRows: 5000, maxRows: 10000 });

    const without = adapterOver(() => json({ asOfSeq: 42, changes: [], window: { days: 90, minRows: 5000 } }));
    const page = await without.snapshot();
    expect(page.window).toEqual({ days: 90, minRows: 5000 });
    expect("maxRows" in page.window).toBe(false);
  });

  /**
   * THE STORE'S RUN TRAVELS TO THE ENGINE. A local store past its first run refuses a delta cursor
   * that names none, and the engine can only name what this adapter hands it: without the field a
   * store at generation 9 answered 410 to every cursor its own snapshot issued (the Windows rig).
   */
  it("carries the store run the server states, and leaves it absent when the server states none", async () => {
    const stated = adapterOver(() => json({ asOfSeq: 42, changes: [], storeGeneration: 9 }));
    expect((await stated.snapshot()).storeGeneration).toBe(9);
    const none = await adapterOver(() => json({ asOfSeq: 42, changes: [] })).snapshot();
    expect("storeGeneration" in none).toBe(false);
  });

  /**
   * THE ONE FIELD THAT DOES NOT DEGRADE. WATCHED RED by replacing the throw with
   * `asOfSeq: Number(wire.asOfSeq) || 0`: the adapter answers a page whose asOfSeq is 0, the
   * engine commits a cursor of "0", and the next drain re-snapshots forever over a full mirror.
   */
  it("REFUSES a response with no usable asOfSeq rather than committing a cursor of 0", async () => {
    const a = adapterOver(() => json({ changes: [], nextCursor: null }));
    await expect(a.snapshot()).rejects.toThrow(/asOfSeq/);
  });

  it("throws the server's own sentence on a non-2xx", async () => {
    const a = adapterOver(() => json({ error: { message: "no credit left", code: "spend_exhausted" } }, 402));
    await expect(a.snapshot()).rejects.toThrow("no credit left");
  });
});

// ── DRAFTS PAGE LIKE MESSAGES ──────────────────────────────────────────────────────────────

describe("drafts the server pages", () => {
  /**
   * Page 1 used to carry every draft the account holds. It now carries the newest page of them
   * and the rest ride later pages, which the drain already follows — `nextCursor` is the only
   * thing that decides how long it runs, and it stays non-null while drafts remain. The claim is
   * that the mirror ends up holding ALL of them, with their text, from a paged feed.
   *
   * WATCHED RED by stopping the drain at the first page (`return` in place of the loop's
   * continuation): two of the three drafts never arrive.
   */
  it("all arrive with their text, across pages", async () => {
    const { adapter, rec } = harness({
      pages: [
        { ids: ["a"], drafts: ["d1", "d2"], nextCursor: "1" },
        { ids: [], drafts: ["d3"], nextCursor: null },
      ],
    });
    const store = await freshStore();
    await engineOf(adapter, store).start();

    expect(rec.snapshotCursors).toEqual([null, "1"]);
    expect(draftIds(store)).toEqual(["d1", "d2", "d3"]);
    expect(store.get<EngineDraft>("draft", "d3")?.body).toBe("the text of d3");
    // A page carrying drafts and NO messages is an ordinary page, not the end of the drain.
    expect(ids(store)).toEqual(["a"]);
  });

  /**
   * The crash window is the same one messages have: the cursor is committed with the LAST page,
   * so a drain that dies after the drafts of page 1 leaves cursor "0" and re-snapshots.
   */
  it("a drain that dies mid-way commits no cursor, and the retry re-delivers them", async () => {
    let fail = true;
    const { adapter } = harness({
      pages: [
        { ids: ["a"], drafts: ["d1"], nextCursor: "1" },
        { ids: [], drafts: ["d2"], nextCursor: null },
      ],
    });
    const wrapped = {
      ...adapter,
      snapshot: async (params: { cursor?: string } = {}) => {
        if (params.cursor === "1" && fail) { fail = false; throw new Error("page 2 died"); }
        return (adapter as unknown as { snapshot: (p: { cursor?: string }) => Promise<SyncSnapshotPage> })
          .snapshot(params);
      },
    } as unknown as EngineAdapter;
    const store = await freshStore();
    const engine = engineOf(wrapped, store);

    await expect(engine.start()).rejects.toThrow("page 2 died");
    expect(store.getCursor()).toBe("0");

    await engine.syncOnce();
    expect(draftIds(store)).toEqual(["d1", "d2"]);
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));
  });
});
