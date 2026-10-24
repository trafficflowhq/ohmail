import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  COMPOSE_FILE_TYPE,
  COMPOSE_LETTER_TYPE,
  IndexedDbMirrorStore,
  OUTBOX_TYPE,
  ROUTING_JOURNAL_TYPE,
  SqlMirrorStore,
  mirrorDbName,
  type SqlExecutor,
  type SyncChange,
} from "@ohmail/client-engine";
import { sqlWorld } from "./helpers/node-sql-executor.js";

/**
 * A SEND QUEUED IN ONE TAB MUST SURVIVE ANOTHER TAB'S 410 WIPE.
 *
 * The mirror is per ACCOUNT, so two tabs share one database, and the set of rows that rides
 * through the wipe used to be built from the WIPING tab's memory alone. Tab B durably queues a
 * send; tab A takes a 410; the wipe clears the store and re-puts only what tab A remembers.
 * Close B and the person pressed Send and the mail never goes. The keep set is derived inside
 * the wipe's own transaction from the store's CONTENTS, unioned with the caller's set.
 */

const OWNER = "acct-wipe-outbox";
const NOW = "2026-09-14T12:00:00.000Z";

/** A queued verb, opaque to the store — only its type and its seq decide anything. */
const verb = (v: number) => ({ v, kind: "message_send" });

function tagChange(id: string, seq: number): SyncChange {
  return { type: "tag", op: "create", id, seq, updatedAt: NOW, entity: { id, name: id } } as SyncChange;
}

/** What a NEXT BOOT finds on this disk — the only oracle, since nothing in memory is wrong. */
async function idbBoot(factory: IDBFactory): Promise<{
  outbox: Array<{ id: string; entity: unknown }>; tags: string[]; bodies: string[]; keys: string[];
}> {
  const store = new IndexedDbMirrorStore({ owner: OWNER, factory });
  await store.load();
  const out = {
    outbox: store.entries<unknown>(OUTBOX_TYPE).map((e) => ({ id: e.id, entity: e.entity }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    tags: store.entries<unknown>("tag").map((e) => e.id).sort(),
    bodies: store.entries<unknown>("message_body").map((e) => e.id).sort(),
    keys: await idbKeys(factory),
  };
  store.close();
  return out;
}

/**
 * The RAW keys, tombstones included. `entries()` hides a record whose entity is null, so a
 * resurrected tombstone is invisible to every store-level read — it has to be read off disk.
 */
async function idbKeys(factory: IDBFactory): Promise<string[]> {
  const req = factory.open(mirrorDbName(OWNER));
  const db = await new Promise<IDBDatabase>((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const tx = db.transaction(["entities"], "readonly");
  const keys = await new Promise<IDBValidKey[]>((res, rej) => {
    const r = tx.objectStore("entities").getAllKeys();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return keys.map(String).sort();
}

async function sqlBoot(world: ReturnType<typeof sqlWorld>): Promise<{
  outbox: Array<{ id: string; entity: unknown }>; tags: string[]; bodies: string[]; keys: string[];
}> {
  const store = new SqlMirrorStore({ owner: OWNER, open: world.open });
  await store.load();
  const out = {
    outbox: store.entries<unknown>(OUTBOX_TYPE).map((e) => ({ id: e.id, entity: e.entity }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    tags: store.entries<unknown>("tag").map((e) => e.id).sort(),
    bodies: store.entries<unknown>("message_body").map((e) => e.id).sort(),
    keys: await sqlKeys(world),
  };
  store.close();
  return out;
}

async function sqlKeys(world: ReturnType<typeof sqlWorld>): Promise<string[]> {
  const db: SqlExecutor = await world.open(mirrorDbName(OWNER));
  const rows = await db.all("SELECT key FROM entities");
  return rows.map((r) => String(r.key)).sort();
}

// ══ CONTROL 3 — THE ARM THAT DECIDES WHETHER THE UNION IS SAFE AT ALL ════════════════════════

/**
 * A row memory has DISOWNED may not be resurrected by the disk read. The store's carry-forward
 * contract says an unflushed record is written only while it is still THE record in memory,
 * because writing a disowned one back resurrects it on disk while the reader shows it gone. The
 * disk union is the same hazard from the other side, and it is why the disk read is filtered by
 * the store's OWN classifier rather than by presence: a retired send that came back would be
 * sent twice. Written first, before the union it licenses.
 */
describe("the disk read may not undo what memory put down", () => {
  /**
   * WATCHED RED by dropping `rec.entity !== null` from `isCarried` in `store.ts`: the tombstone
   * rides through the wipe and the retired verb is back on disk under its own key.
   */
  it("[idb] a tombstoned outbox row is not carried back through the wipe", async () => {
    const factory = new IDBFactory();
    const tab = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tab.load();
    await tab.putLocal(OUTBOX_TYPE, "verb-retired", verb(1));
    await tab.putLocal(OUTBOX_TYPE, "verb-live", verb(1));
    // The send goes out and its row is retired — a tombstone, durable, disowned by every reader.
    await tab.putLocal(OUTBOX_TYPE, "verb-retired", null);
    expect(await idbKeys(factory)).toContain(`${OUTBOX_TYPE}:verb-retired`);

    await tab.resetForBootstrap();
    tab.close();

    const boot = await idbBoot(factory);
    expect(boot.keys, "the wipe resurrected a verb memory had retired").toEqual([`${OUTBOX_TYPE}:verb-live`]);
    expect(boot.outbox.map((e) => e.id)).toEqual(["verb-live"]);
  });

  /**
   * A HARD-DELETED row has no disk state left to resurrect — the ordinary retirement path
   * (`commitLocal` deletes), stated so the tombstone case above is not read as the only one.
   */
  it("[idb] a verb deleted before the 410 does not come back", async () => {
    const factory = new IDBFactory();
    const tab = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tab.load();
    await tab.commitLocal([{ type: OUTBOX_TYPE, id: "verb-sent", entity: verb(1) }], []);
    await tab.commitLocal([], [{ type: OUTBOX_TYPE, id: "verb-sent" }]);
    await tab.resetForBootstrap();
    tab.close();

    expect((await idbBoot(factory)).keys).toEqual([]);
  });

  /**
   * THE CALLER'S SET IS THE AUTHORITY FOR THE KEYS IT NAMES. The disk read only ADDS keys nobody
   * in memory holds; it may not overwrite the record the wiping store's own reader is showing,
   * which is the one state the wipe is otherwise free to make durable.
   *
   * WATCHED RED by putting the disk rows into the union AFTER the caller's set in
   * `wipeKeepUnion`: the wiping tab's reader says v1 and its disk says v2.
   */
  it("[idb] the caller's record wins a tie; the disk copy does not overwrite it", async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabA.load();
    await tabA.putLocal(OUTBOX_TYPE, "verb-tie", verb(1));

    const tabB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabB.load();
    await tabB.putLocal(OUTBOX_TYPE, "verb-tie", verb(2));
    tabB.close();

    await tabA.resetForBootstrap();
    expect(tabA.entries<{ v: number }>(OUTBOX_TYPE).map((e) => e.entity.v)).toEqual([1]);
    tabA.close();

    const boot = await idbBoot(factory);
    expect(boot.outbox, "the disk read overwrote the record the wiping tab was showing")
      .toEqual([{ id: "verb-tie", entity: verb(1) }]);
  });
});

// ══ CONTROL 1 — THE ROUND'S SEQUENCE, AND CONTROL 2 BESIDE IT ═══════════════════════════════

describe("the wipe keeps the durable outbox, wherever it was queued", () => {
  /**
   * THE REGRESSION. Tab B queues a send AFTER tab A's load, so the row is on disk and in no
   * other tab's memory; tab A takes a 410 and wipes. Round 1 read durable entries 1 → 0 here.
   *
   * WATCHED RED by returning the caller's set alone from `wipeKeepUnion` (the memory-only rule
   * this replaced): the boot's outbox is empty and the queued send is gone for good.
   */
  it("[idb] tab B's queued send survives tab A's 410", async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabA.load();

    // Tab B queues the send after A's load — A's memory never holds this row.
    const tabB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabB.load();
    await tabB.putLocal(OUTBOX_TYPE, "verb-B", verb(1));
    tabB.close(); // the person closes the tab before the send is delivered

    await tabA.resetForBootstrap();
    tabA.close();

    const boot = await idbBoot(factory);
    expect(boot.outbox.map((e) => e.id), "the other tab's queued send was erased by the wipe")
      .toEqual(["verb-B"]);
  });

  /** Both tabs' verbs, since neither set is the whole answer. */
  it("[idb] the wiping tab's own verb and the other tab's both survive", async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabA.load();
    await tabA.putLocal(OUTBOX_TYPE, "verb-A", verb(1));

    const tabB = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tabB.load();
    await tabB.putLocal(OUTBOX_TYPE, "verb-B", verb(1));
    tabB.close();

    await tabA.resetForBootstrap();
    tabA.close();

    expect((await idbBoot(factory)).outbox.map((e) => e.id)).toEqual(["verb-A", "verb-B"]);
  });

  /**
   * CONTROL 2 — the union did not WIDEN what survives. A wipe exists because the cursor is
   * dead; every row a re-bootstrap brings back must go, or it comes back twice.
   *
   * Defended TWICE — `keyMayCarry` narrows the read and `isCarried` decides — so either
   * mutation alone is a no-op here and measures the other gate. WATCHED RED with BOTH open
   * (`keyMayCarry` → `true` and the filter dropped from `wipeKeepUnion`): the whole mirror rides
   * through its own wipe and the next boot is the mailbox the 410 said was unreachable.
   */
  it("[idb] nothing that is not carried-class rides through", async () => {
    const factory = new IDBFactory();
    const tab = new IndexedDbMirrorStore({ owner: OWNER, factory });
    await tab.load();
    await tab.applyChanges([tagChange("t1", 100), tagChange("t2", 100)]);
    await tab.putLocal("message_body", "m1", { html: "<p>hi</p>" });
    await tab.putLocal(OUTBOX_TYPE, "verb-1", verb(1));
    expect((await idbKeys(factory)).length).toBe(4);

    await tab.resetForBootstrap();
    tab.close();

    const boot = await idbBoot(factory);
    expect(boot.tags, "server rows survived a wipe and will arrive again").toEqual([]);
    expect(boot.bodies, "a body survived a wipe; a re-bootstrap re-fetches it").toEqual([]);
    expect(boot.outbox.map((e) => e.id)).toEqual(["verb-1"]);
  });
});

// ══ CONTROL 4 — THE SAME ARMS AGAINST THE SQL STORE ═════════════════════════════════════════

/**
 * The React Native arm carries the same `wipe(keep)` contract, so it carries the same defect:
 * a fix in one store only is half-applied by construction. Same four arms, same classifier.
 *
 * Each store reads its OWN disk, and that is measured rather than claimed: making one store's
 * `carriedOnDisk` answer nothing reddens that store's arms and leaves the other's green.
 */
describe("the sql mirror keeps the durable outbox through its wipe", () => {
  it("[sql] a second store's queued send survives the 410", async () => {
    const world = sqlWorld();
    const a = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await a.load();

    const b = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await b.load();
    await b.putLocal(OUTBOX_TYPE, "verb-B", verb(1));
    b.close();

    await a.resetForBootstrap();
    a.close();

    expect((await sqlBoot(world)).outbox.map((e) => e.id), "the queued send was erased by the wipe")
      .toEqual(["verb-B"]);
  });

  it("[sql] a tombstoned outbox row is not carried back through the wipe", async () => {
    const world = sqlWorld();
    const store = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await store.load();
    await store.putLocal(OUTBOX_TYPE, "verb-retired", verb(1));
    await store.putLocal(OUTBOX_TYPE, "verb-live", verb(1));
    await store.putLocal(OUTBOX_TYPE, "verb-retired", null);
    expect(await sqlKeys(world)).toContain(`${OUTBOX_TYPE}:verb-retired`);

    await store.resetForBootstrap();
    store.close();

    const boot = await sqlBoot(world);
    expect(boot.keys, "the wipe resurrected a verb memory had retired").toEqual([`${OUTBOX_TYPE}:verb-live`]);
  });

  it("[sql] the caller's record wins a tie", async () => {
    const world = sqlWorld();
    const a = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await a.load();
    await a.putLocal(OUTBOX_TYPE, "verb-tie", verb(1));

    const b = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await b.load();
    await b.putLocal(OUTBOX_TYPE, "verb-tie", verb(2));
    b.close();

    await a.resetForBootstrap();
    a.close();

    expect((await sqlBoot(world)).outbox).toEqual([{ id: "verb-tie", entity: verb(1) }]);
  });

  it("[sql] nothing that is not carried-class rides through", async () => {
    const world = sqlWorld();
    const store = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await store.load();
    await store.applyChanges([tagChange("t1", 100), tagChange("t2", 100)]);
    await store.putLocal("message_body", "m1", { html: "<p>hi</p>" });
    await store.putLocal(OUTBOX_TYPE, "verb-1", verb(1));
    expect((await sqlKeys(world)).length).toBe(4);

    await store.resetForBootstrap();
    store.close();

    const boot = await sqlBoot(world);
    expect(boot.tags).toEqual([]);
    expect(boot.bodies).toEqual([]);
    expect(boot.outbox.map((e) => e.id)).toEqual(["verb-1"]);
  });

  it("[sql] a routing press still in its window rides the 410 with the outbox", async () => {
    /* The phone keeps its routing window's journal in the mirror: a press not yet sent derives
       from nothing the re-bootstrap returns, so a wipe that dropped it would lose the press. */
    const world = sqlWorld();
    const store = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await store.load();
    const id = "ohmail.routing.intents.local";
    await store.commitLocal([{ type: ROUTING_JOURNAL_TYPE, id, entity: { value: "[]" } }], []);

    await store.resetForBootstrap();
    store.close();

    expect((await sqlBoot(world)).keys, "the wipe dropped a press the person had made")
      .toEqual([`${ROUTING_JOURNAL_TYPE}:${id}`]);
  });

  it("[sql] a letter being written and its file ride the 410: nothing re-derives them", async () => {
    const world = sqlWorld();
    const store = new SqlMirrorStore({ owner: OWNER, open: world.open });
    await store.load();
    await store.commitLocal([
      { type: COMPOSE_LETTER_TYPE, id: "l-1", entity: { v: 1, id: "l-1", body: "Half a thought" } },
      { type: COMPOSE_FILE_TYPE, id: "f-1", entity: { letterId: "l-1", contentBase64: "AAAA" } },
    ], []);

    await store.resetForBootstrap();
    store.close();

    expect((await sqlBoot(world)).keys.sort(), "the wipe dropped a letter the person was writing")
      .toEqual([`${COMPOSE_FILE_TYPE}:f-1`, `${COMPOSE_LETTER_TYPE}:l-1`]);
  });
});
