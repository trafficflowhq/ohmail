import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  MemoryMirrorStore,
  SqlMirrorStore,
  flattenResponse,
  triagePiles,
  type BaseMirrorStore,
  type EngineMessage,
  type MessageStateDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { sqlWorld } from "./helpers/node-sql-executor.js";

/**
 * A LETTER DELETED ON THE SERVER LEAVES ITS PILE, on every mirror store. The server
 * keeps a tombstoned letter's state row; the mirror applied the `message` delete, kept the claim,
 * and the piles filed it as a row reading its id. Claims are keyed as production keys them
 * (`state-row:<messageId>`), not by message id as the demo does.
 * Mutations watched: `claimsOfGoneLetters` dropped from `applyResponse` or from `applyChanges`;
 * the load heal's scan or its flush dropped (read on disk, since a load heals memory either way);
 * the selector's `msg === undefined` arm reverted to an id-titled row.
 */

const rekey = (c: SyncChange): SyncChange => {
  if (c.type !== "message_state") return c;
  const messageId = (c.entity as MessageStateDTO | null)?.messageId ?? c.id;
  return { ...c, id: `state-row:${messageId}` };
};

async function seededChanges(): Promise<SyncChange[]> {
  return flattenResponse(await new FixturesAdapter().sync({ since: "0", limit: 2000 })).map(rekey);
}

type Kind = "memory" | "sql" | "idb";

function opener(kind: Kind): () => BaseMirrorStore {
  if (kind === "memory") {
    const one = new MemoryMirrorStore();
    return () => one;
  }
  if (kind === "sql") {
    const world = sqlWorld();
    return () => new SqlMirrorStore({ dbName: "pile-gone", open: world.open });
  }
  const factory = new IDBFactory();
  return () => new IndexedDbMirrorStore({ dbName: "pile-gone", factory });
}

const ids = (store: BaseMirrorStore) => triagePiles(store).replyLater.map((e) => e.messageId);

async function seeded(kind: Kind) {
  const open = opener(kind);
  const store = open();
  await store.load();
  await store.applyChanges(await seededChanges());
  const before = ids(store);
  const letter = before[0]!;
  expect(before.length, "the fixture parks letters in Answer Later").toBeGreaterThan(1);
  expect(store.record("message_state", `state-row:${letter}`)?.entity).toBeTruthy();
  return { store, open, before, letter, seq: store.maxSeq() };
}

const deleteOf = (id: string, seq: number): SyncChange =>
  ({ type: "message", op: "delete", id, seq, updatedAt: "2026-10-12T01:39:38.903Z" });

describe.each<Kind>(["memory", "sql", "idb"])("a gone letter leaves its pile — %s store", (kind) => {
  it("the sync that deletes the letter takes its claim: the pile and its count drop by one", async () => {
    const { store, before, letter, seq } = await seeded(kind);
    // The drain's own door: a `/sync` page, cursor and all.
    await store.applyResponse({ changes: { creates: [], updates: [], moves: [], deletes: [deleteOf(letter, seq + 1)] },
      cursor: String(seq + 1), hasMore: false, serverTime: "2026-10-12T01:40:00Z" });
    expect(ids(store)).toEqual(before.filter((x) => x !== letter));
    expect(store.record("message_state", `state-row:${letter}`)?.entity).toBeNull();
    expect(triagePiles(store).replyLater.some((e) => e.title === letter)).toBe(false);
  });

  it("a claim reaching a letter already gone is taken too, whichever arrives first", async () => {
    const { store, before, letter, seq } = await seeded(kind);
    await store.applyChanges([deleteOf(letter, seq + 1)]);
    const claim = { messageId: letter, state: "reply_later", bubbleUpAt: null, setAt: "2026-10-12T01:40:00Z",
      updatedAt: "2026-10-12T01:40:00Z" } as unknown as MessageStateDTO;
    await store.applyChanges([{ type: "message_state", op: "update", id: `state-row:${letter}`, seq: seq + 2,
      updatedAt: "2026-10-12T01:40:00Z", entity: claim }]);
    expect(ids(store)).toEqual(before.filter((x) => x !== letter));
    expect(store.record("message_state", `state-row:${letter}`)?.entity).toBeNull();
  });

  it("a letter that comes back returns to its pile (the rule for a move out and back)", async () => {
    const { store, before, letter, seq } = await seeded(kind);
    const row = store.get<EngineMessage>("message", letter)!;
    const claim = store.record("message_state", `state-row:${letter}`)!.entity as MessageStateDTO;
    await store.applyChanges([deleteOf(letter, seq + 1)]);
    await store.applyChanges([{ type: "message", op: "create", id: letter, seq: seq + 2,
      updatedAt: "2026-10-12T02:00:00Z", entity: { ...row, triage: claim } }]);
    expect(new Set(ids(store))).toEqual(new Set(before));
  });

  it("a page that moves the letter and re-writes its claim leaves it filed (the positive control)", async () => {
    const { store, before, letter, seq } = await seeded(kind);
    const row = store.get<EngineMessage>("message", letter)!;
    const claim = store.record("message_state", `state-row:${letter}`)!.entity as MessageStateDTO;
    await store.applyChanges([
      { type: "message", op: "move", id: letter, seq: seq + 1, updatedAt: "2026-10-12T02:00:00Z",
        entity: { ...row, folder: "ohmail/News" }, move: { from: row.folder, to: "ohmail/News" } },
      { type: "message_state", op: "update", id: `state-row:${letter}`, seq: seq + 2,
        updatedAt: "2026-10-12T02:00:00Z", entity: { ...claim, updatedAt: "2026-10-12T02:00:00Z" } },
    ]);
    expect(new Set(ids(store))).toEqual(new Set(before));
    expect(store.record("message_state", `state-row:${letter}`)?.entity).toBeTruthy();
  });
});

/** Writes the PRE-FIX shape straight to disk: the letter's tombstone beside its live claim. */
async function plantGhost(kind: "sql" | "idb") {
  const world = sqlWorld();
  const factory = new IDBFactory();
  const open = kind === "sql"
    ? () => new SqlMirrorStore({ dbName: "pile-ghost", open: world.open })
    : () => new IndexedDbMirrorStore({ dbName: "pile-ghost", factory });
  const a = open();
  await a.load();
  await a.applyChanges(await seededChanges());
  const before = ids(a);
  const letter = before[0]!;
  const claim = a.record("message_state", `state-row:${letter}`)!;
  await a.applyChanges([deleteOf(letter, a.maxSeq() + 1)]);
  a.close();
  const key = `message_state:state-row:${letter}`;
  if (kind === "sql") {
    await world.open("pile-ghost").batch([{
      sql: "INSERT INTO entities (key, record) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET record = excluded.record",
      params: [key, JSON.stringify(claim)],
    }]);
  } else {
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("pile-ghost", 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction("entities", "readwrite");
        tx.objectStore("entities").put(claim, key);
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  /** The claim as it sits ON DISK, read past the store: a load heals memory whether or not it wrote. */
  const onDisk = async (): Promise<unknown> => {
    if (kind === "sql") {
      const rows = await world.open("pile-ghost").all("SELECT record FROM entities WHERE key = ?", [key]);
      return rows.length === 0 ? undefined : (JSON.parse(String(rows[0]!.record)) as { entity: unknown }).entity;
    }
    return new Promise<unknown>((resolve, reject) => {
      const req = factory.open("pile-ghost", 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const get = req.result.transaction("entities", "readonly").objectStore("entities").get(key);
        get.onsuccess = () => { req.result.close(); resolve((get.result as { entity: unknown } | undefined)?.entity); };
        get.onerror = () => reject(get.error);
      };
    });
  };
  return { open, before, letter, onDisk };
}

describe.each<"sql" | "idb">(["sql", "idb"])("a mirror that already kept a ghost heals at load — %s store", (kind) => {
  it("the persisted claim over a deleted letter is not filed, and leaves the disk", async () => {
    const { open, before, letter, onDisk } = await plantGhost(kind);
    expect(await onDisk(), "the planted ghost is on disk before the load").toBeTruthy();
    const b = open();
    await b.load();
    expect(ids(b)).toEqual(before.filter((x) => x !== letter));
    expect(b.record("message_state", `state-row:${letter}`)?.entity).toBeNull();
    b.close();
    expect(await onDisk(), "the heal reached the disk").toBeNull();
  });
});

describe("the pile files no claim whose letter the reader cannot produce", () => {
  it("a claim with no letter is neither drawn nor counted; one with its letter is", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(await seededChanges());
    const live = ids(store);
    const ghost = "94179640-1ad8-43bf-8863-bccdd7b58e2b";
    const claim = { messageId: ghost, state: "reply_later", bubbleUpAt: null, setAt: "2026-10-12T01:19:58Z",
      updatedAt: "2026-10-12T01:19:58Z" } as unknown as MessageStateDTO;
    await store.applyChanges([{ type: "message_state", op: "update", id: `state-row:${ghost}`,
      seq: store.maxSeq() + 1, updatedAt: "2026-10-12T01:19:58Z", entity: claim }]);
    expect(store.record("message_state", `state-row:${ghost}`)?.entity, "an absent letter keeps its claim").toBeTruthy();
    const piles = triagePiles(store);
    expect(piles.replyLater.map((e) => e.messageId)).toEqual(live);
    expect(piles.replyLater.some((e) => e.title === ghost)).toBe(false);
  });
});
