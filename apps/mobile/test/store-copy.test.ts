/**
 * THE COPY A PHONE TAKES OF ITS OWN STORE BEFORE THE STORE CROSSES INTO 2.0, over a real SQLite file
 * (node's) in a folder of its own. The copy is taken through the store's handle, checked against the
 * store and only then named; one that stands is kept; too little room, or a copy that differs,
 * refuses with nothing named and nothing left half-written.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/* node's SQLite, loaded as the other phone tests load it (vite cannot resolve the `node:` builtin). */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { ENGINE_DB_FILE, removeStandaloneEngine, type PhoneSqlExecutor } from "../src/engine/local-engine";
import {
  COPY_ROOM_SLACK, STORE_COPY_FILE, storeCopyHost, takeStoreCopy, type PlatformFile, type StoreCopyHost,
} from "../src/engine/store-copy";
import { StoreFault, type SecureKV } from "../src/state/servers";
import { engineStoreWorld } from "./helpers/expo-sqlite-shape";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function sqliteAt(path: string): PhoneSqlExecutor & { close(): Promise<void> } {
  const db = new DatabaseSync(path);
  return {
    async all(sql, params) {
      const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
      const columns = rows[0] ? Object.keys(rows[0]) : [];
      return { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
    },
    async run(sql, params) { db.prepare(sql).run(...(params as never[])); },
    async batch(statements) { for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as never[])); },
    async close() { db.close(); },
  };
}

async function storeWithMail(): Promise<{ dir: string; store: PhoneSqlExecutor & { close(): Promise<void> } }> {
  const dir = mkdtempSync(join(tmpdir(), "store-copy-"));
  dirs.push(dir);
  const store = sqliteAt(join(dir, "ohmail-engine.db"));
  for (const sql of [
    "CREATE TABLE ohmail_sqlite_migrations (name TEXT PRIMARY KEY)", "INSERT INTO ohmail_sqlite_migrations VALUES ('0184_last.sql')",
    "CREATE TABLE accounts (id TEXT)", "INSERT INTO accounts VALUES ('acct-1')",
    "CREATE TABLE mailbox_credentials (id TEXT, sealed TEXT)", "INSERT INTO mailbox_credentials VALUES ('mb-1', 'sealed')",
    "CREATE TABLE mailboxes (id TEXT)", "INSERT INTO mailboxes VALUES ('mb-1')",
    "CREATE TABLE messages (id TEXT)", "INSERT INTO messages VALUES ('m-1'), ('m-2')",
  ]) await store.run(sql, []);
  return { dir, store };
}

function hostIn(dir: string, free: number | null, open = (name: string) => sqliteAt(join(dir, name))): StoreCopyHost {
  return {
    storeBytes: async () => statSync(join(dir, "ohmail-engine.db")).size,
    freeBytes: async () => free,
    pathOf: (name) => join(dir, name),
    exists: async (name) => existsSync(join(dir, name)),
    rename: async (from, to) => renameSync(join(dir, from), join(dir, to)),
    remove: async (name) => rmSync(join(dir, name), { force: true }),
    open: async (name) => open(name),
  };
}

describe("the copy before the store crosses into 2.0", () => {
  it("is taken through the store's handle, checked, and named; a copy that stands is kept", async () => {
    const { dir, store } = await storeWithMail();
    expect(await takeStoreCopy(store, hostIn(dir, 1e12))).toBe("taken");
    const copy = sqliteAt(join(dir, STORE_COPY_FILE));
    expect((await copy.all("SELECT count(*) AS n FROM messages", [])).rows[0]?.[0]).toBe(2);
    expect((await copy.all("SELECT sealed FROM mailbox_credentials", [])).rows[0]?.[0]).toBe("sealed");
    await copy.close();
    expect(existsSync(join(dir, `${STORE_COPY_FILE}.part`))).toBe(false);
    expect(await takeStoreCopy(store, hostIn(dir, 1e12))).toBe("kept");
    await store.close();
  });

  it("refuses with too little room, and names nothing", async () => {
    const { dir, store } = await storeWithMail();
    await expect(takeStoreCopy(store, hostIn(dir, 1024))).rejects.toMatchObject({ code: "store_copy_no_room" });
    await expect(takeStoreCopy(store, hostIn(dir, null))).rejects.toMatchObject({ code: "store_copy_no_room" });
    expect(existsSync(join(dir, STORE_COPY_FILE))).toBe(false);
    await store.close();
  });

  it("refuses a copy that does not hold what the store holds, and leaves no part behind", async () => {
    const { dir, store } = await storeWithMail();
    const other = await storeWithMail();
    await other.store.run("DELETE FROM messages WHERE id = 'm-2'", []);
    const differs = hostIn(dir, 1e12, () => sqliteAt(join(other.dir, "ohmail-engine.db")));
    const refused = await takeStoreCopy(store, differs).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StoreFault);
    expect(refused).toMatchObject({ code: "store_copy_failed" });
    expect(existsSync(join(dir, STORE_COPY_FILE))).toBe(false);
    expect(existsSync(join(dir, `${STORE_COPY_FILE}.part`))).toBe(false);
    await store.close();
    await other.store.close();
  });

  it("removes a part a cut-off copy left before it reads the room, so the part does not block its own retry", async () => {
    const { dir, store } = await storeWithMail();
    const size = statSync(join(dir, "ohmail-engine.db")).size;
    // The volume had just enough room before the copy was cut off between `VACUUM INTO` and the rename.
    const volume = 3 * size + COPY_ROOM_SLACK;
    const used = () => readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
    await store.run("VACUUM INTO ?", [join(dir, `${STORE_COPY_FILE}.part`)]);
    const host = { ...hostIn(dir, 0), freeBytes: async () => volume - used() };
    expect(await takeStoreCopy(store, host)).toBe("taken");
    expect(existsSync(join(dir, `${STORE_COPY_FILE}.part`))).toBe(false);
    await store.close();
  });

  it("words a fault of the platform's as the copy's refusal, from the first file it reads", async () => {
    const { dir, store } = await storeWithMail();
    const faulty = { ...hostIn(dir, 1e12), exists: async () => { throw new Error("Exception in HostFunction: a platform's stack"); } };
    await expect(takeStoreCopy(store, faulty)).rejects.toMatchObject({ code: "store_copy_failed" });
    await store.close();
  });
});

describe("the copy's host on the phone's file system", () => {
  /**
   * expo-file-system's `File` as Android answers it: a location that is not an absolute `file://` URI is refused at
   * once, and a move is the module's asynchronous one, done on a later turn.
   */
  const platformFile = (uri: string): PlatformFile => {
    if (!uri.startsWith("file:///")) throw new Error("java.lang.IllegalArgumentException: URI is not absolute");
    const path = decodeURIComponent(uri.slice("file://".length));
    return {
      uri,
      get exists() { return existsSync(path); },
      get size() { return statSync(path).size; },
      delete() { rmSync(path); },
      move: (to) => new Promise<void>((done) => {
        setTimeout(() => { renameSync(path, decodeURIComponent(to.uri.slice("file://".length))); done(); }, 5);
      }),
    };
  };

  it("names each file beside the store by its file:// location, and copies a store kept at a bare path", async () => {
    const { dir, store } = await storeWithMail();
    const host = storeCopyHost({
      directory: dir, file: platformFile, freeBytes: () => 1e12, open: async (name) => sqliteAt(join(dir, name)),
    });
    expect(await takeStoreCopy(store, host)).toBe("taken");
    expect(existsSync(join(dir, STORE_COPY_FILE))).toBe(true);
    expect(existsSync(join(dir, `${STORE_COPY_FILE}.part`))).toBe(false);
    await store.close();
  });
});

describe("Stop and remove takes the copy with the store", () => {
  const kv = (): SecureKV => {
    const map = new Map<string, string>();
    return { get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, remove: async (k) => { map.delete(k); } };
  };
  async function phoneWithCopies() {
    const world = engineStoreWorld();
    for (const name of [ENGINE_DB_FILE, STORE_COPY_FILE, `${STORE_COPY_FILE}.part`]) {
      const db = await world.open(name);
      await (await db.prepareAsync("CREATE TABLE messages (id TEXT)")).executeAsync([]);
      await (await db.prepareAsync("INSERT INTO messages VALUES ('m-1')")).executeAsync([]);
      await db.closeAsync();
    }
    return world;
  }

  it("deletes the store, the copy and a part a cut-off copy left, and reads all three back", async () => {
    const world = await phoneWithCopies();
    try {
      await removeStandaloneEngine({ openDatabase: world.open, deleteDatabase: world.drop, exists: world.exists, kv: kv() });
      for (const name of [ENGINE_DB_FILE, STORE_COPY_FILE, `${STORE_COPY_FILE}.part`]) expect(await world.exists(name), name).toBe(false);
    } finally {
      world.cleanup();
    }
  });

  it("does not call a removal done while the copy stands", async () => {
    const world = await phoneWithCopies();
    try {
      const refusing = async (name: string) => { if (name !== STORE_COPY_FILE) await world.drop(name); };
      await expect(removeStandaloneEngine({ openDatabase: world.open, deleteDatabase: refusing, exists: world.exists, kv: kv() }))
        .rejects.toMatchObject({ code: "engine_store_not_deleted" });
    } finally {
      world.cleanup();
    }
  });
});
