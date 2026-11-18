import type { Cursor, EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  MirrorGenerationChanged,
  OUTBOX_TYPE,
  OhmailEngine,
  SNAPSHOT_PREFIX_SEQ_META,
  encodeSeqCursor,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * THE DURABLE CURSOR MOVES ONLY AFTER THE PAGE IT COVERS IS DURABLY COMMITTED — the two ways
 * that promise could still be broken by something OTHER than a failed write.
 *
 * `cursor-durability.test.ts` closed the two failures a single store can cause itself: a page
 * flush that aborts, and a wipe that does not happen. Both are about this process's own writes.
 * The two here are about a fact this process cannot observe going stale underneath it, and they
 * are the same defect: **the cursor advances on something that is no longer true.**
 *
 *   3. **ANOTHER TAB WIPED THE DATABASE.** The mirror is per ACCOUNT, so two tabs share one
 *      IndexedDB database. A `410` in tab A empties it; tab B knows nothing, and its next flush
 *      writes its page and its cursor onto the emptied baseline. On disk: a few rows under a
 *      cursor claiming thousands of seqs. Every one of those deltas has been sent, and `/sync`
 *      sends a delta once, so the mailbox is permanently truncated and looks healthy.
 *
 *   4. **AN ABANDONED SNAPSHOT'S ROWS.** A cold bootstrap that dies mid-stream leaves rows at
 *      the OLD `asOfSeq` and a cursor of "0". A snapshot is a statement of LIVE state, so a later
 *      attempt at a NEWER `asOfSeq` cannot mention anything deleted in between — it simply does
 *      not carry it. Those rows therefore ride into a completed bootstrap, and the cursor then
 *      commits PAST their tombstones. Deleted mail comes back and stays.
 *
 * ## WHY NO EXISTING TEST COULD SEE EITHER
 *
 * Same reason as the first two: both are claims about DISK, visible only after a restart, and at
 * no point is anything in memory wrong. So the oracle here is the same one — a SECOND store
 * loaded over the SAME disk, which is what the next boot does — and every case builds one.
 */

const NOW = new Date("2026-08-31T12:00:00.000Z");
const OWNER = "acct-crosstab";

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

function changes(idsIn: string[], seq: number): SyncChange[] {
  return idsIn.map((id) => ({
    type: "message", op: "create", id, seq, updatedAt: NOW.toISOString(), entity: msg(id),
  }));
}

function page(idsIn: string[], seq: number, cursor: Cursor): SyncResponse {
  return {
    changes: { creates: changes(idsIn, seq), updates: [], moves: [], deletes: [] },
    cursor,
    hasMore: false,
    serverTime: NOW.toISOString(),
  };
}

/** What a NEXT BOOT would find on this disk: message ids, the cursor, and the outbox. */
async function nextBoot(factory: IDBFactory): Promise<{
  ids: string[]; cursor: Cursor; outbox: string[]; prefixSeq: number | undefined;
}> {
  const store = new IndexedDbMirrorStore({ owner: OWNER, factory });
  await store.load();
  const out = {
    ids: store.entries<EngineMessage>("message").map((e) => e.id).sort(),
    cursor: store.getCursor(),
    outbox: store.entries<unknown>(OUTBOX_TYPE).map((e) => e.id).sort(),
    prefixSeq: store.getMeta<number>(SNAPSHOT_PREFIX_SEQ_META),
  };
  store.close();
  return out;
}

// ══ ARM 3 — TWO TABS, ONE DATABASE ═══════════════════════════════════════════════════════════

describe("a wipe in one tab fences every other tab's writes", () => {
  /**
   * THE REGRESSION, and the whole of it is on the disk rather than in either tab.
   *
   * WATCHED RED by deleting the `if (found !== this.generation)` branch from
   * `IndexedDbMirrorStore.persist`: the next boot finds cursor `c-200` over a mirror holding only
   * tab B's two rows — the truncated-and-healthy-looking state.
   *
   * ALSO WATCHED RED by not bumping the counter in `wipe()` (put the old `gen` back instead of
   * `gen + 1`): the fence is there, it never fires, and the same wrong disk comes out. A fence
   * whose stamp does not move is a fence nobody has watched fail.
   */
  it("tab B cannot commit its cursor over the baseline tab A emptied", async () => {
    const factory = new IDBFactory();

    const tabA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    const tabB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabA.load();
    await tabB.load();

    // Both tabs are caught up on the same page.
    await tabA.applyResponse(page(["m1", "m2"], 100, "c-100"));
    await tabB.load();
    expect(tabB.getCursor()).toBe("c-100");

    // Tab A takes a 410 and re-bootstraps: the shared database is emptied.
    await tabA.resetForBootstrap();

    // Tab B, which knows nothing about it, applies its next page.
    await tabB.applyResponse(page(["m3", "m4"], 200, "c-200"));

    const boot = await nextBoot(factory);
    expect(boot.cursor, "the durable cursor was written over a wiped mirror").toBe("0");
    expect(boot.ids, "tab B's page landed on a baseline that no longer existed").toEqual([]);

    tabA.close();
    tabB.close();
  });

  /**
   * THE CARVE-OUT, and it is the half that would be easy to get wrong in the other direction.
   *
   * A wipe is a statement about the CURSOR, never about the user's queued intents — the same
   * rule the engine's `410` branch already writes down when it carries the outbox rows through
   * `resetForBootstrap`. A fenced tab holding an unsent verb must not lose it.
   *
   * WATCHED RED by clearing `this.records` wholesale in `adoptWipedBaseline` instead of keeping
   * the seq-0 records: the outbox row is gone from the next boot, and a verb the person believes
   * they issued is never sent.
   */
  it("the fenced tab's durable outbox survives onto the new baseline", async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    const tabB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabA.load();
    await tabB.load();

    await tabB.applyResponse(page(["m1"], 100, "c-100"));
    await tabB.putLocal(OUTBOX_TYPE, "verb-1", { v: 1, kind: "message_move" });

    await tabA.load();
    await tabA.resetForBootstrap();

    // The write that gets fenced.
    await tabB.applyResponse(page(["m2"], 200, "c-200"));

    const boot = await nextBoot(factory);
    expect(boot.outbox, "the queued verb was dropped by the recovery").toEqual(["verb-1"]);
    expect(boot.ids).toEqual([]);
    expect(boot.cursor).toBe("0");

    tabA.close();
    tabB.close();
  });

  /**
   * The fenced tab must PRESENT ITSELF AS COLD, or its own next drain writes the next hole.
   *
   * Leaving the in-memory cursor where it was would mean the very next `/sync` asks for changes
   * after a point this mirror no longer holds — which is arm 1 reached from the other side, and
   * would make the fence a way of turning one permanent hole into a stream of them.
   *
   * WATCHED RED by removing `this.cursor = "0";` from `adoptWipedBaseline`: the store still
   * answers `c-100` and still lists the mail it no longer has.
   */
  it("the fenced tab drops to cursor 0 and stops claiming the mail it lost", async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    const tabB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabA.load();
    await tabB.load();

    await tabB.applyResponse(page(["m1", "m2"], 100, "c-100"));
    await tabA.load();
    await tabA.resetForBootstrap();
    await tabB.applyResponse(page(["m3"], 200, "c-200"));

    expect(tabB.getCursor()).toBe("0");
    expect(tabB.maxSeq()).toBe(0);
    expect(tabB.entries<EngineMessage>("message")).toEqual([]);

    tabA.close();
    tabB.close();
  });

  /**
   * THE VACUITY GUARD. Every case above would also pass against a `persist` that threw the fence
   * unconditionally — and that implementation persists nothing at all, ever.
   *
   * WATCHED RED by making the fence fire on every write (`if (true)`): the ordinary single-tab
   * mirror never reaches disk and the next boot is empty.
   */
  it("the ordinary case is not fenced — one tab's repeated writes all land", async () => {
    const factory = new IDBFactory();
    const only = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await only.load();
    await only.applyResponse(page(["m1"], 100, "c-100"));
    await only.applyResponse(page(["m2"], 200, "c-200"));
    await only.putLocal(OUTBOX_TYPE, "verb-1", { v: 1 });
    only.close();

    const boot = await nextBoot(factory);
    expect(boot.ids).toEqual(["m1", "m2"]);
    expect(boot.cursor).toBe("c-200");
    expect(boot.outbox).toEqual(["verb-1"]);
  });

  /**
   * A store that performs its OWN wipe must not fence itself out of the mirror it just reset —
   * which is the ordinary `410` path and would otherwise be broken by the fence.
   */
  it("the tab that did the wipe writes against its own new baseline", async () => {
    const factory = new IDBFactory();
    const tab = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tab.load();
    await tab.applyResponse(page(["m1"], 100, "c-100"));
    await tab.resetForBootstrap();
    await tab.applyResponse(page(["m9"], 300, "c-300"));
    tab.close();

    const boot = await nextBoot(factory);
    expect(boot.ids).toEqual(["m9"]);
    expect(boot.cursor).toBe("c-300");
  });

  /** The refusal is a named condition, not a storage failure wearing its clothes. */
  it("names itself, so a caller can tell it from a quota error", () => {
    const err = new MirrorGenerationChanged(1, 2);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MirrorGenerationChanged");
    expect(err.expected).toBe(1);
    expect(err.found).toBe(2);
  });
});

// ══ ARM 4 — THE ABANDONED SNAPSHOT PREFIX ════════════════════════════════════════════════════

const AS_OF_A = 100;
const AS_OF_B = 200;

interface SnapshotScript {
  /** Pages by index; a page that is an Error is thrown when it is asked for. */
  attempts: Array<Array<{ ids: string[]; nextCursor: string | null; asOfSeq: number } | Error>>;
}

/** An adapter whose snapshot walks one scripted ATTEMPT per `start()`. */
function scriptedAdapter(script: SnapshotScript): EngineAdapter {
  let attempt = -1;
  return {
    sync: async (p: { since: string }): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: p.since, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    snapshot: async (params: { cursor?: string } = {}): Promise<SyncSnapshotPage> => {
      if (params.cursor === undefined) attempt++;
      const pages = script.attempts[attempt];
      if (!pages) throw new Error(`no scripted attempt ${attempt}`);
      const i = params.cursor === undefined ? 0 : Number(params.cursor);
      const p = pages[i];
      if (!p) throw new Error(`no scripted page ${i}`);
      if (p instanceof Error) throw p;
      return {
        asOfSeq: p.asOfSeq,
        changes: changes(p.ids, p.asOfSeq),
        nextCursor: p.nextCursor,
        window: { days: 30, minRows: 500 },
      };
    },
  } as unknown as EngineAdapter;
}

describe("an abandoned bootstrap's rows do not ride into the next one", () => {
  /**
   * THE REGRESSION. Every step here is a real one: a dropped connection mid-bootstrap, a message
   * deleted before the client comes back, and a second bootstrap that completes.
   *
   * The kill is real too — the store is CLOSED between the attempts and a new one is opened over
   * the same disk, which is what a reload does. Nothing carries over in memory.
   *
   * WATCHED RED by deleting the `pruneBySeq` call from `claimSnapshotPrefix`: `m2` is in the next
   * boot's mirror, at seq 100, under a cursor of 200 — and no delta will ever remove it, because
   * its `delete` change is at 150.
   */
  it("a message deleted between two attempts is GONE after the second completes", async () => {
    const factory = new IDBFactory();
    const adapter = scriptedAdapter({
      attempts: [
        // Attempt A at seq 100: page 1 lands, page 2 dies.
        [{ ids: ["m1", "m2"], nextCursor: "1", asOfSeq: AS_OF_A }, new Error("the connection dropped")],
        // The server deletes m2 at seq 150. Attempt B reads live state at seq 200 and, correctly,
        // says nothing at all about m2.
        [{ ids: ["m1"], nextCursor: null, asOfSeq: AS_OF_B }],
      ],
    });

    const storeA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await storeA.load();
    await expect(new OhmailEngine({ adapter, store: storeA, now: () => NOW }).start())
      .rejects.toThrow("the connection dropped");
    storeA.close();

    // What the interrupted attempt left on disk — the precondition, asserted rather than assumed.
    const mid = await nextBoot(factory);
    expect(mid.ids).toEqual(["m1", "m2"]);
    expect(mid.cursor).toBe("0");
    expect(mid.prefixSeq).toBe(AS_OF_A);

    const storeB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await storeB.load();
    await new OhmailEngine({ adapter, store: storeB, now: () => NOW }).start();
    storeB.close();

    const boot = await nextBoot(factory);
    expect(boot.ids, "a message the server deleted survived the second bootstrap").toEqual(["m1"]);
    expect(boot.cursor).toBe(encodeSeqCursor(AS_OF_B));
    expect(boot.prefixSeq).toBe(AS_OF_B);
  });

  /**
   * THE FAILURE THIS COULD HAVE OPENED, and it is the one that matters more than the defect.
   *
   * The sweep deletes by SEQ, and the durable outbox is a record like any other. If it were
   * swept, a bootstrap that had to retry would silently destroy the verbs a person had issued —
   * trading a resurrected message for an unsent one, which is the worse trade.
   *
   * Client-local records live at seq 0 (`putLocal`), so the sweep's predicate has to be the EXACT
   * seq and nothing looser. WATCHED RED by widening it to `rec.seq <= seq` in `pruneBySeq` —
   * which is the plausible mutation, "tidy up everything at or below the abandoned point" — and
   * the verb goes with the abandoned rows. (`pruneBySeq` also refuses seq 0 outright, for the
   * account whose log is empty and whose `asOfSeq` is therefore 0.)
   */
  it("the sweep never touches the durable outbox", async () => {
    const factory = new IDBFactory();
    const adapter = scriptedAdapter({
      attempts: [
        [{ ids: ["m1", "m2"], nextCursor: "1", asOfSeq: AS_OF_A }, new Error("the connection dropped")],
        [{ ids: ["m1"], nextCursor: null, asOfSeq: AS_OF_B }],
      ],
    });

    const storeA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await storeA.load();
    await expect(new OhmailEngine({ adapter, store: storeA, now: () => NOW }).start())
      .rejects.toThrow("the connection dropped");
    // A verb issued while the mailbox was still bootstrapping.
    await storeA.putLocal(OUTBOX_TYPE, "verb-1", { v: 1, kind: "message_move" });
    storeA.close();

    const storeB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await storeB.load();
    await new OhmailEngine({ adapter, store: storeB, now: () => NOW }).start();
    storeB.close();

    const boot = await nextBoot(factory);
    expect(boot.outbox, "the sweep took a queued verb with it").toEqual(["verb-1"]);
    expect(boot.ids).toEqual(["m1"]);
  });

  /**
   * THE MARKER IS DURABLE BEFORE THE FIRST ROW IS, and the order is the whole point.
   *
   * The failing write here is the PAGE, not the marker — so with the correct order the disk ends
   * up holding a marker that names an attempt with no rows, which is the harmless direction: the
   * next attempt sweeps nothing and rebuilds. Reverse the two and the disk holds ROWS WITH NO
   * MARKER, which is the defect: the next attempt has nothing to sweep by and the stale rows
   * survive a completed bootstrap.
   *
   * WATCHED RED by moving `await this.claimSnapshotPrefix(page.asOfSeq)` below the page apply in
   * `runSnapshot`: `m2` is in the final mirror.
   */
  it("rows are never durable without the marker that names them", async () => {
    const factory = new IDBFactory();
    const adapter = scriptedAdapter({
      attempts: [
        [{ ids: ["m1", "m2"], nextCursor: "1", asOfSeq: AS_OF_A }, new Error("never reached")],
        [{ ids: ["m1"], nextCursor: null, asOfSeq: AS_OF_B }],
      ],
    });

    // A store that lets exactly one flush through and then refuses — the process dying between
    // the two writes a snapshot attempt's first page makes.
    class OneWriteStore extends IndexedDbMirrorStore {
      writes = 0;
      protected async persist(
        dirty: Parameters<IndexedDbMirrorStore["persist"]>[0],
        cursor: Parameters<IndexedDbMirrorStore["persist"]>[1],
        metaEntries: Parameters<IndexedDbMirrorStore["persist"]>[2],
      ): Promise<void> {
        if (++this.writes > 1) throw new Error("QuotaExceededError: the transaction aborted");
        return super.persist(dirty, cursor, metaEntries);
      }
    }

    const storeA = new OneWriteStore({ owner: OWNER, factory });
    await storeA.load();
    await expect(new OhmailEngine({ adapter, store: storeA, now: () => NOW }).start()).rejects.toThrow();
    storeA.close();

    // Precondition: with the marker written FIRST, the one write that landed is the marker.
    const mid = await nextBoot(factory);
    expect(mid.prefixSeq).toBe(AS_OF_A);
    expect(mid.ids).toEqual([]);

    const storeB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await storeB.load();
    await new OhmailEngine({ adapter, store: storeB, now: () => NOW }).start();
    storeB.close();

    const boot = await nextBoot(factory);
    expect(boot.ids).toEqual(["m1"]);
    expect(boot.cursor).toBe(encodeSeqCursor(AS_OF_B));
  });

  /**
   * A RETRY AT THE SAME POINT SWEEPS NOTHING. The prefix belongs to this attempt: re-applying it
   * is free (the seq guard refuses the repeat) and deleting it first would turn every resumed
   * bootstrap into a full re-download.
   *
   * WATCHED RED by sweeping unconditionally (dropping the `prior !== asOfSeq` test): the rows
   * page 1 already delivered are deleted and re-fetched on every attempt.
   */
  it("an attempt at the SAME asOfSeq keeps the prefix it already has", async () => {
    const factory = new IDBFactory();
    const adapter = scriptedAdapter({
      attempts: [
        [{ ids: ["m1", "m2"], nextCursor: "1", asOfSeq: AS_OF_A }, new Error("the connection dropped")],
        [{ ids: ["m3"], nextCursor: null, asOfSeq: AS_OF_A }],
      ],
    });

    const storeA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await storeA.load();
    await expect(new OhmailEngine({ adapter, store: storeA, now: () => NOW }).start())
      .rejects.toThrow("the connection dropped");
    storeA.close();

    const storeB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await storeB.load();
    await new OhmailEngine({ adapter, store: storeB, now: () => NOW }).start();
    storeB.close();

    const boot = await nextBoot(factory);
    expect(boot.ids).toEqual(["m1", "m2", "m3"]);
    expect(boot.cursor).toBe(encodeSeqCursor(AS_OF_A));
  });
});
