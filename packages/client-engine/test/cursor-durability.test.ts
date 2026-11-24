import type { Cursor } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BaseMirrorStore,
  recordKey,
  type MirrorRecord,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * THE DURABLE CURSOR MOVES ONLY AFTER THE PAGE IT COVERS IS DURABLY COMMITTED.
 *
 * ## THE DEFECT — two of the four ways the mirror could outrun its own disk
 *
 * A review found four ways the client mirror persists a delta cursor past rows that never reached
 * disk, and named them one defect in four coats: **the cursor advances on the intent to persist
 * rather than on the fact of it.** Two of the four are properties of `BaseMirrorStore` and are
 * closed here.
 *
 *   1. **A FAILED PAGE FLUSH.** `applyResponse` advanced memory and then awaited a persist that can
 *      abort. The write itself is atomic — page and cursor land together or not at all — so the
 *      failure looked harmless. The NEXT page is where it bites: on any later apply the seq guard
 *      correctly refuses the already-applied changes, so the dirty set is empty and the flush
 *      writes a NEWER cursor over a disk that never received the earlier rows. `/sync` sends a
 *      delta once. The hole is permanent, and after a reload the mirror is simply missing mail.
 *
 *   2. **A FAILED WIPE.** `resetForBootstrap` cleared memory and then awaited a wipe that can fail.
 *      Memory empty, disk still holding the old rows, the 410 re-bootstrap writing a fresh cursor
 *      on top: mail the server had deleted came back on the next restart and stayed.
 *
 * ## WHY NO EXISTING TEST COULD SEE EITHER
 *
 * Both are claims about DISK made visible only by a RESTART, and at no point is anything in memory
 * wrong. Every reader assertion in the suite passes over both. So this file's oracle is always the
 * same: build a SECOND store over the same disk and `load()` it — which is what the next boot does
 * — and ask what that mirror holds.
 *
 * ## THE HARNESS
 *
 * A `BaseMirrorStore` whose persistence is a `Map` standing in for IndexedDB, with the three
 * failure injections the arms need. `persist` writes rows, cursor and meta together, exactly as
 * `IndexedDbMirrorStore` does in one transaction, and a failure writes NOTHING — modelling a
 * transaction abort rather than a partial write, which is the honest shape and also the harder one
 * to pass.
 */

/** The stand-in for IndexedDB: what survives the process. */
interface Disk {
  rows: Map<string, MirrorRecord>;
  meta: Map<string, unknown>;
  cursor: Cursor;
}

const disk = (): Disk => ({ rows: new Map(), meta: new Map(), cursor: "0" });

class TestStore extends BaseMirrorStore {
  failPersist = 0;
  failWipe = 0;
  /** Every completed `persist`, as (row keys, cursor) — the ordering evidence. */
  writes: Array<{ keys: string[]; cursor: Cursor | null }> = [];

  constructor(private readonly d: Disk) {
    super();
  }

  protected async readPersisted(): Promise<void> {
    this.records.clear();
    this.meta.clear();
    this.highSeq = 0;
    for (const [k, rec] of this.d.rows) {
      this.records.set(k, rec);
      if (rec.seq > this.highSeq) this.highSeq = rec.seq;
    }
    for (const [k, v] of this.d.meta) this.meta.set(k, v);
    this.cursor = this.d.cursor;
    this.ver++;
  }

  protected async persist(
    dirty: MirrorRecord[],
    cursor: Cursor | null,
    metaEntries: Array<[string, unknown]>,
  ): Promise<void> {
    if (this.failPersist > 0) {
      this.failPersist--;
      // A TRANSACTION ABORT: nothing at all is written, not even the rows before the failure.
      throw new Error("QuotaExceededError: the transaction aborted");
    }
    for (const rec of dirty) this.d.rows.set(recordKey(rec.type, rec.id), rec);
    for (const [k, v] of metaEntries) this.d.meta.set(k, v);
    if (cursor !== null) this.d.cursor = cursor;
    this.writes.push({ keys: dirty.map((r) => recordKey(r.type, r.id)).sort(), cursor });
  }

  protected async wipe(): Promise<void> {
    if (this.failWipe > 0) {
      this.failWipe--;
      throw new Error("InvalidStateError: the database is blocked");
    }
    this.d.rows.clear();
    this.d.meta.clear();
    this.d.cursor = "0";
  }

  protected async purge(keys: string[]): Promise<void> {
    for (const k of keys) this.d.rows.delete(k);
  }
}

let seq = 0;
const msg = (id: string): SyncChange => ({
  type: "message", op: "create", id, seq: ++seq,
  updatedAt: "2026-08-10T09:00:00.000Z",
  entity: { id, subject: `subject ${id}` },
});

const page = (changes: SyncChange[], cursor: Cursor): SyncResponse => ({
  changes: { creates: changes, updates: [], moves: [], deletes: [] },
  cursor, hasMore: false, serverTime: "2026-08-10T12:00:00.000Z",
});

/** The next boot's mirror, over the same disk. */
async function reboot(d: Disk): Promise<TestStore> {
  const s = new TestStore(d);
  await s.load();
  return s;
}

describe("the durable cursor never runs ahead of the rows it covers", () => {
  it("a page whose flush ABORTED is carried into the next one, cursor and all", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();

    store.failPersist = 1;
    await expect(store.applyResponse(page([msg("a"), msg("b")], "10")))
      .rejects.toThrow(/aborted/);

    // The next page succeeds. Under the defect this wrote cursor "20" over a disk holding
    // neither `a` nor `b`, and `/sync` never sends those deltas again.
    await store.applyResponse(page([msg("c")], "20"));

    const next = await reboot(d);
    expect(
      [...next.snapshot().keys()].sort(),
      "the aborted page's rows never reached disk and the cursor moved past them",
    ).toEqual(["message:a", "message:b", "message:c"]);
    expect(next.getCursor()).toBe("20");
  });

  it("the carried page rides in the SAME write as the cursor, not a later one", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();

    store.failPersist = 1;
    await expect(store.applyResponse(page([msg("a")], "10"))).rejects.toThrow();
    await store.applyResponse(page([msg("b")], "20"));

    // One write, carrying both rows AND the cursor. A design that wrote the carried rows first and
    // the cursor second would pass the case above and still leave a window a kill fits inside.
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toEqual({ keys: ["message:a", "message:b"], cursor: "20" });
  });

  it("a later echo may settle the pending cursor — but only WITH its page", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();

    store.failPersist = 1;
    await expect(store.applyResponse(page([msg("a")], "10"))).rejects.toThrow();
    // `applyChanges` passes `cursor: null` — it invents nothing. What it CAN do is be the write
    // that finally lands the pending page, and then the pending cursor rides with it. That is
    // sound precisely because the two are in one transaction: cursor "10" was earned by the page
    // holding `a`, and `a` is in this write. The claim under test is the conjunction, not the
    // cursor on its own — a write carrying "10" WITHOUT `a` is the whole defect.
    await store.applyChanges([msg("e")]);

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.cursor).toBe("10");
    expect(
      store.writes[0]!.keys,
      "the cursor was settled by a write that did not carry the page it covers",
    ).toEqual(["message:a", "message:e"]);
  });

  it("a FAILED WIPE is owed, and nothing is written until it is settled", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();
    await store.applyResponse(page([msg("old1"), msg("old2")], "10"));

    // The 410 re-bootstrap. The wipe fails, twice.
    store.failWipe = 2;
    await expect(store.resetForBootstrap()).rejects.toThrow(/blocked/);

    // The re-bootstrap's first page now tries to write. Under the defect this landed a fresh
    // cursor on a disk still holding `old1`/`old2`, and they came back on the next boot for good.
    await expect(store.applyResponse(page([msg("new1")], "5"))).rejects.toThrow(/blocked/);

    const stillOld = await reboot(d);
    expect(
      [...stillOld.snapshot().keys()].sort(),
      "a store that cannot clear itself must not write past the state it failed to clear",
    ).toEqual(["message:old1", "message:old2"]);
    expect(stillOld.getCursor(), "the durable cursor moved while the wipe was still owed").toBe("10");
  });

  it("…and once the wipe succeeds the old rows are gone, in the same act", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();
    await store.applyResponse(page([msg("old1")], "10"));

    store.failWipe = 1;
    await expect(store.resetForBootstrap()).rejects.toThrow();
    await store.applyResponse(page([msg("new1")], "5"));

    const after = await reboot(d);
    expect([...after.snapshot().keys()]).toEqual(["message:new1"]);
    expect(after.getCursor()).toBe("5");
  });

  it("a PRUNED row is not written back by the carry-forward", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();

    store.failPersist = 1;
    await expect(store.applyResponse(page([msg("keep"), msg("drop")], "10"))).rejects.toThrow();

    // The windowed store evicts a row whose flush never landed. Carrying it forward anyway would
    // undo the eviction through the very mechanism added to stop writes going missing — the
    // failure this fix could have opened.
    await store.prune([{ type: "message", id: "drop" }]);
    await store.applyResponse(page([msg("next")], "20"));

    const next = await reboot(d);
    expect([...next.snapshot().keys()].sort()).toEqual(["message:keep", "message:next"]);
  });

  it("a RELOAD between a failed flush and the next one does not resurrect the carried row", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();

    store.failPersist = 1;
    await expect(store.applyResponse(page([msg("ghost")], "10"))).rejects.toThrow();

    // `load()` REPLACES the record map from disk, which no longer holds `ghost` — the flush that
    // would have put it there aborted. Memory has disowned the row. Writing it back on the next
    // flush would put it on disk while the reader shows it gone: the carry-forward inverting the
    // very defect it exists to close, and the failure mode this fix could most easily have
    // introduced.
    await store.load();
    expect(store.get("message", "ghost"), "the reload should have dropped it").toBeUndefined();

    await store.applyResponse(page([msg("real")], "20"));

    const next = await reboot(d);
    expect([...next.snapshot().keys()]).toEqual(["message:real"]);
    expect(next.getCursor()).toBe("20");
  });

  it("two overlapping flushes both reach disk, and the newer record wins", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();

    // Started in one tick, settled together. The claim is the conjunction the carry-forward must
    // not break: neither write is lost, and the record on disk is the later one — a flush that
    // retired more than it wrote, or one whose carried batch resurrected the older record over
    // the newer, would fail one half or the other.
    const first = store.applyResponse(page([msg("x")], "10"));
    const newer = msg("x");
    const second = store.applyChanges([newer]);
    await Promise.all([first, second]);

    const next = await reboot(d);
    expect(next.get("message", "x")).toBeDefined();
    expect(
      (d.rows.get("message:x") as MirrorRecord).seq,
      "the later record did not survive the overlap",
    ).toBe(newer.seq);
    expect(next.getCursor()).toBe("10");
  });
});

/**
 * THE CARRY IS DROPPED WHEN MEMORY IS REPLACED FROM DISK — `load()` as a template method.
 *
 * The carry-forward above is correct while memory holds the carried rows. `load()` replaces
 * memory from disk, and the identity sweep in `flush` then drops those rows because memory has
 * disowned them — leaving the carried CURSOR to be written on its own, by the next unrelated
 * local write, past a page the disk never received. Nothing in memory is wrong at any point,
 * which is why the reader cannot see it; the oracle is the next boot, as everywhere in this file.
 */
describe("a reload drops the carried cursor along with the carried page", () => {
  it("an unrelated local write after a reload does not advance the durable cursor", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();

    // A page whose flush aborted: `a` is in memory and in `unflushed`, cursor "10" is pending.
    store.failPersist = 1;
    await expect(store.applyResponse(page([msg("a")], "10"))).rejects.toThrow(/aborted/);

    // The reload. Disk holds nothing, so memory is emptied — and the carry must go with it.
    await store.load();

    // Anything at all that flushes. The durable outbox's own write is the ordinary one.
    await store.putLocal("outbox", "o1", { id: "o1" });

    expect(
      d.cursor,
      "a local write wrote the reloaded store's pending cursor over a page disk never held",
    ).toBe("0");

    const next = await reboot(d);
    expect(next.getCursor()).toBe("0");
    expect([...next.snapshot().keys()]).toEqual(["outbox:o1"]);
  });

  it("the reload does not cost a page the disk DID receive", async () => {
    seq = 0;
    const d = disk();
    const store = new TestStore(d);
    await store.load();
    await store.applyResponse(page([msg("a")], "10"));

    await store.load();
    await store.putLocal("outbox", "o1", { id: "o1" });

    /* THE POSITIVE CONTROL. A rule that cleared the carry could equally have cleared a cursor
       that was already durable; this is the ordinary reload, and it keeps everything. */
    expect(d.cursor).toBe("10");
    expect([...(await reboot(d)).snapshot().keys()].sort()).toEqual(["message:a", "outbox:o1"]);
  });

  it("TODAY THE ENGINE CANNOT REACH THE SEQUENCE, and that is why this is a guard and not a fix", async () => {
    /* The engine hydrates through a single-flight that latches on its first success and runs
       before its only drain (`OhmailEngine.hydrate`), so a second `load()` after a page has been
       applied is unreachable from the engine. The clearing above is what keeps the store correct
       if that ever changes — recorded as a case so the change cannot be read as unnecessary and
       removed. What IS asserted here is the shape of the protection: `load()` is the base class's
       and a subclass supplies `readPersisted`, so no store can hydrate around it. */
    const store = new TestStore(disk());
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)))
      .not.toContain("load");
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)))
      .toContain("readPersisted");
    await store.load();
  });
});
