/**
 * THE COPY A PHONE TAKES OF ITS OWN STORE BEFORE THE STORE CROSSES INTO 2.0. A mailbox this phone
 * organizes lives in one SQLite file, and the first 2.0 migration rewrites it; nothing could bring it
 * back. So before that migration writes anything, the store is copied beside itself through the
 * engine's own handle (`VACUUM INTO`), the copy is checked against the store (SQLite's own check, the
 * migration ledger, the four tables' counts), and only a copy that passed is named as one. Any
 * failure refuses the open with the store untouched, in one worded refusal: never "migrate anyway".
 *
 * A finished copy that already stands is kept (a relaunch after a refused open does not copy twice);
 * a part a cut-off copy left is removed first. The copy and its part go with "Stop and remove". Nothing
 * removes a finished copy after the crossing yet.
 */
import { StoreFault } from "../state/servers";
import { ENGINE_DB_FILE, ENGINE_STORE_TABLES, type PhoneSqlExecutor } from "./local-engine";

/** The copy's name, beside `ohmail-engine.db` in expo-sqlite's directory. */
export const STORE_COPY_FILE = "ohmail-engine.before-2.db";
const PART = `${STORE_COPY_FILE}.part`;
/** Room the copy needs beyond twice the store: the migration's own journal, and some to spare. */
export const COPY_ROOM_SLACK = 16 * 1024 * 1024;
const LEDGER = "ohmail_sqlite_migrations";

/** What the copy needs of the platform, by file name beside the store. */
export interface StoreCopyHost {
  /** The store's size and the room left on its volume, in bytes; null where the platform cannot say. */
  storeBytes(): Promise<number | null>;
  freeBytes(): Promise<number | null>;
  /** The full path `VACUUM INTO` writes to, for a name beside the store. */
  pathOf(name: string): string;
  exists(name: string): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Opens a file beside the store, to read the copy back. */
  open(name: string): Promise<PhoneSqlExecutor & { close(): Promise<void> }>;
}

/** What one side holds that the other must match: the ledger, and each table's count. */
async function readingOf(exec: PhoneSqlExecutor): Promise<string> {
  const ledger = (await exec.all(`SELECT name FROM ${LEDGER} ORDER BY name`, [])).rows.map((r) => String(r[0]));
  const counts: string[] = [];
  for (const table of ENGINE_STORE_TABLES) {
    counts.push(`${table}=${String((await exec.all(`SELECT count(*) FROM ${table}`, [])).rows[0]?.[0])}`);
  }
  return JSON.stringify({ ledger, counts });
}

/** A file beside the store as the platform's file system gives it: expo-file-system's `File`, by its location. */
export interface PlatformFile {
  readonly uri: string;
  readonly exists: boolean;
  readonly size: number | null;
  delete(): void | Promise<void>;
  /** expo-file-system's move is asynchronous: the copy is named only once it resolves. */
  move(to: PlatformFile): void | Promise<void>;
}

/** What the copy's host is built over on a phone. */
export interface StoreCopyPlatform {
  /** expo-sqlite's directory, which both platforms give as a bare path. */
  readonly directory: string;
  /** A file by its `file://` location; the platform refuses a bare path. */
  file(uri: string): PlatformFile;
  freeBytes(): number | null;
  open: StoreCopyHost["open"];
}

/** A name beside the store as the `file://` location the file system takes (as `diagnosticFileUri` builds one). */
export function fileUriBesideStore(directory: string, name: string): string {
  const base = directory.startsWith("file://") ? directory : `file://${encodeURI(directory)}`;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
}

/** The copy's host on a phone: each file by its `file://` location, the copy written by its bare path. */
export function storeCopyHost(platform: StoreCopyPlatform): StoreCopyHost {
  const at = (name: string) => platform.file(fileUriBesideStore(platform.directory, name));
  const bare = platform.directory.replace(/^file:\/\//, "").replace(/\/+$/, "");
  return {
    storeBytes: async () => at(ENGINE_DB_FILE).size,
    freeBytes: async () => platform.freeBytes(),
    pathOf: (name) => `${bare}/${name}`,
    exists: async (name) => at(name).exists,
    rename: async (from, to) => { await at(from).move(at(to)); },
    remove: async (name) => { const f = at(name); if (f.exists) await f.delete(); },
    open: (name) => platform.open(name),
  };
}

/** Takes the copy, or keeps the one that stands. Throws a `StoreFault` (and leaves the store as it was) on any failure. */
export async function takeStoreCopy(store: PhoneSqlExecutor, host: StoreCopyHost): Promise<"taken" | "kept"> {
  try {
    if (await host.exists(STORE_COPY_FILE)) return "kept";
    // A part a cut-off copy left counts against the room the copy needs: it goes before the room is read.
    await host.remove(PART);
    const size = await host.storeBytes();
    const free = await host.freeBytes();
    if (size === null || free === null) {
      throw new StoreFault("store_copy_no_room", "the room for the store's copy could not be read");
    }
    if (free < 2 * size + COPY_ROOM_SLACK) {
      throw new StoreFault("store_copy_no_room", `the store's copy needs ${2 * size + COPY_ROOM_SLACK} bytes free and ${free} are`);
    }
    await store.run("VACUUM INTO ?", [host.pathOf(PART)]);
    const copy = await host.open(PART);
    try {
      const check = (await copy.all("PRAGMA quick_check", [])).rows[0]?.[0];
      if (check !== "ok") throw new StoreFault("store_copy_failed", `the store's copy did not pass SQLite's own check (${String(check)})`);
      if ((await readingOf(copy)) !== (await readingOf(store))) {
        throw new StoreFault("store_copy_failed", "the store's copy does not hold what the store holds");
      }
    } finally {
      await copy.close().catch(() => undefined);
    }
    await host.rename(PART, STORE_COPY_FILE);
    if (!(await host.exists(STORE_COPY_FILE))) throw new StoreFault("store_copy_failed", "the store's copy was not named");
    return "taken";
  } catch (err) {
    await host.remove(PART).catch(() => undefined);
    if (err instanceof StoreFault) throw err;
    throw new StoreFault("store_copy_failed", `the store's copy could not be taken: ${err instanceof Error ? err.message : String(err)}`);
  }
}
