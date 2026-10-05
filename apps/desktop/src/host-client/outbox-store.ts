/**
 * THE PAIRED PAGE'S MIRROR, WITH ITS QUEUED CHANGES KEPT IN THIS BROWSER. The mirror stays in
 * memory, rebuilt from the host at every load; the outbox is the one part nothing rebuilds. The
 * two outbox types go to this browser's IndexedDB before the engine publishes them and come back
 * at the next load, where the engine's restore replays them under their original keys. Rows are
 * keyed by the pairing and written only while the jar still holds it, so a pairing that ended
 * writes nothing. A browser that refuses the database keeps the changes in memory and says so once.
 * Several tabs of one pairing share these rows: each row has one owner, as on the web's mirror.
 */
import {
  BaseMirrorStore, OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE, OutboxNoticeBus, carriedOutboxMarks, decideOutboxRow, outboxNoticeChannel, recordKey,
  type MirrorRecord, type NoticeChannel, type OutboxNotices, type OutboxRowAct, type OutboxRowVerdict,
} from "@ohmail/client-engine";

export const HOST_OUTBOX_DB = "ohmail-host-outbox";
const ROWS = "rows";

const isCarriedType = (type: string): boolean => type === OUTBOX_TYPE || type === OUTBOX_ABANDONED_TYPE;

/** `recordKey` is `type:id` and neither type holds a colon, so the first one splits it. */
function keyParts(key: string): { type: string; id: string } {
  const at = key.indexOf(":");
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

function storedRow(v: unknown): MirrorRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as { type?: unknown; id?: unknown; entity?: unknown };
  if (typeof r.type !== "string" || !isCarriedType(r.type) || typeof r.id !== "string" || r.id === "") return null;
  if (typeof r.entity !== "object" || r.entity === null) return null;
  return { type: r.type, id: r.id, seq: 0, entity: r.entity };
}

/** The browser's database, or `null` where it has none or refuses even the lookup. */
function browserFactory(given: IDBFactory | null | undefined): IDBFactory | null {
  if (given !== undefined) return given;
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("ohmail: the outbox read failed"));
  });
}

/** Only a completed transaction is bytes on disk; an abort and an error both refuse. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("ohmail: the outbox write was aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("ohmail: the outbox write failed"));
  });
}

function openDb(factory: IDBFactory | null): Promise<IDBDatabase> {
  if (factory === null) return Promise.reject(new Error("ohmail: this browser has no IndexedDB"));
  return new Promise((resolve, reject) => {
    const req = factory.open(HOST_OUTBOX_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(ROWS)) req.result.createObjectStore(ROWS);
    };
    req.onsuccess = () => {
      const db = req.result;
      // A delete from elsewhere (site data cleared) must not hang on this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("ohmail: the outbox database did not open"));
    req.onblocked = () => reject(new Error("ohmail: the outbox database is blocked"));
  });
}

export interface HostOutboxStoreOptions {
  /** The pairing these rows belong to; `null` where the jar refused to hold one. */
  scope: string | null;
  /** Is `scope` still the pairing this page serves — read before every disk touch. */
  live: () => boolean;
  /** Injectable for tests; absent, the browser's own. */
  factory?: IDBFactory | null;
  /** Called once when this browser will not keep the changes. */
  onUnkept?: () => void;
  /** The notice channel's maker — the browser's `BroadcastChannel` unless a test hands one in. */
  notices?: (name: string) => NoticeChannel | null;
}

/** One type's rows of one pairing, as an IndexedDB key range over `[scope, type, id]`. */
function typeRange(scope: string, type: string): IDBKeyRange | null {
  const KeyRange = (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;
  return KeyRange === undefined ? null : KeyRange.bound([scope, type], [scope, type, []]);
}

export class HostOutboxStore extends BaseMirrorStore {
  private readonly scope: string | null;
  private readonly live: () => boolean;
  private readonly factory: IDBFactory | null;
  private readonly onUnkept: (() => void) | undefined;
  private db: Promise<IDBDatabase> | null = null;
  private unkept = false;
  /** The other tabs of this pairing — every committed outbox write says so. */
  private readonly bus: OutboxNoticeBus | null;

  constructor(opts: HostOutboxStoreOptions) {
    super();
    this.scope = opts.scope;
    this.live = opts.live;
    this.factory = browserFactory(opts.factory);
    this.onUnkept = opts.onUnkept;
    const disk = this.sharedDiskName();
    this.bus = disk === null ? null : new OutboxNoticeBus(outboxNoticeChannel(disk), opts.notices);
  }

  /** The pairing's rows in this browser, which every tab of it opens: `null` with no pairing or no database. */
  sharedDiskName(): string | null {
    return this.scope === null || this.factory === null ? null : `${HOST_OUTBOX_DB}:${this.scope}`;
  }

  outboxNotices(): OutboxNotices | null {
    return this.bus?.notices() ?? null;
  }

  /** The compare-and-set behind adoption: this pairing's outbox rows, read and re-stamped in one transaction. */
  protected async adoptOrphans(
    me: string, live: ReadonlySet<string>, exclude: ReadonlySet<string>,
  ): Promise<MirrorRecord[]> {
    const range = this.usable() ? typeRange(this.scope!, OUTBOX_TYPE) : null;
    if (range === null) return [];
    const db = await this.database();
    const tx = db.transaction(ROWS, "readwrite");
    const rows = tx.objectStore(ROWS);
    const taken: MirrorRecord[] = [];
    for (const v of await request(rows.getAll(range))) {
      const rec = storedRow(v);
      const owner = (rec?.entity as { owner?: unknown } | undefined)?.owner;
      if (rec === null || typeof owner !== "string" || owner === me || live.has(owner) || exclude.has(rec.id)) continue;
      const next: MirrorRecord = { ...rec, entity: { ...(rec.entity as object), owner: me } };
      rows.put({ type: next.type, id: next.id, entity: next.entity }, [this.scope!, next.type, next.id]);
      taken.push(next);
    }
    await committed(tx);
    this.bus?.changed(taken.map((r) => recordKey(r.type, r.id)));
    return taken;
  }

  protected async readOutboxRange(): Promise<MirrorRecord[] | null> {
    if (!this.usable()) return null;
    const ranges = [OUTBOX_TYPE, OUTBOX_ABANDONED_TYPE].map((t) => typeRange(this.scope!, t));
    if (ranges.some((r) => r === null)) return null;
    const db = await this.database();
    const tx = db.transaction(ROWS, "readonly");
    const out: MirrorRecord[] = [];
    for (const range of ranges) {
      for (const v of await request(tx.objectStore(ROWS).getAll(range!))) {
        const rec = storedRow(v);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  /** The compare-and-set behind `decideOutboxRow`: the row read and, when the verdict writes, written in one transaction. */
  protected async decideOnDisk(id: string, act: OutboxRowAct): Promise<{ verdict: OutboxRowVerdict; rec: MirrorRecord | null }> {
    if (!this.usable()) return { verdict: "gone", rec: null };
    const db = await this.database();
    const tx = db.transaction(ROWS, "readwrite");
    const rows = tx.objectStore(ROWS);
    const rec = storedRow(await request(rows.get([this.scope!, OUTBOX_TYPE, id])));
    const { verdict, next } = decideOutboxRow(rec?.entity ?? null, act);
    const written: MirrorRecord | null = next === null || rec === null ? null : { ...rec, entity: next };
    if (written !== null) rows.put({ type: written.type, id: written.id, entity: written.entity }, [this.scope!, written.type, written.id]);
    await committed(tx);
    if (written !== null) this.bus?.changed([recordKey(written.type, written.id)]);
    return { verdict, rec: written };
  }

  private database(): Promise<IDBDatabase> {
    this.db ??= openDb(this.factory);
    return this.db;
  }

  /**
   * EVERY FAILURE ENDS HERE: memory from now on, the sentence once, and this pairing's rows
   * cleared where the database still answers, so what the device holds is nothing rather than
   * a stale half. Never a throw — the engine would refuse the person's change.
   */
  private fallBack(): void {
    if (this.unkept) return;
    this.unkept = true;
    const mine = this.scope;
    if (mine !== null && this.db !== null) {
      void sweep(this.factory, (k) => k[0] === mine).catch(() => undefined);
    }
    this.onUnkept?.();
  }

  /** The disk is asked only for the live pairing and only while it is still kept. */
  private usable(): boolean {
    return !this.unkept && this.scope !== null && this.live();
  }

  /**
   * MERGE, NEVER REPLACE — the window store's rule: a drive can reach the store before the load
   * resolves, and a row memory already holds is the newer word.
   */
  protected async readPersisted(): Promise<void> {
    if (this.scope === null) this.fallBack();
    if (!this.usable()) { this.ver++; return; }
    const rows: MirrorRecord[] = [];
    try {
      const db = await this.database();
      const tx = db.transaction(ROWS, "readonly");
      const keys = await request(tx.objectStore(ROWS).getAllKeys());
      const values = await request(tx.objectStore(ROWS).getAll());
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!Array.isArray(k) || k[0] !== this.scope) continue;
        const rec = storedRow(values[i]);
        if (rec) rows.push(rec);
      }
    } catch {
      this.fallBack();
      this.ver++;
      return;
    }
    for (const rec of rows) {
      const key = recordKey(rec.type, rec.id);
      if (!this.records.has(key)) this.records.set(key, rec);
    }
    this.ver++;
  }

  protected async persist(dirty: MirrorRecord[]): Promise<void> {
    const mine = dirty.filter((r) => isCarriedType(r.type));
    if (mine.length === 0) return;
    await this.write(
      mine.filter((r) => r.entity !== null),
      mine.filter((r) => r.entity === null).map((r) => ({ type: r.type, id: r.id })),
    );
  }

  /** A `410` is about the cursor; the disk holds only rows a wipe carries, so nothing goes. */
  protected async wipe(): Promise<void> {
    /* nothing in this database is anything a wipe removes */
  }

  protected async transact(puts: MirrorRecord[], deletes: string[]): Promise<void> {
    const mine = puts.filter((r) => isCarriedType(r.type));
    const gone = deletes.map(keyParts).filter((k) => isCarriedType(k.type));
    if (mine.length === 0 && gone.length === 0) return;
    await this.write(mine, gone);
  }

  protected async purge(keys: string[]): Promise<void> {
    const gone = keys.map(keyParts).filter((k) => isCarriedType(k.type));
    if (gone.length === 0) return;
    await this.write([], gone);
  }

  /** One transaction, all of it or none; a refusal falls back rather than failing the verb. */
  private async write(puts: MirrorRecord[], deletes: Array<{ type: string; id: string }>): Promise<void> {
    if (!this.usable()) return;
    try {
      const db = await this.database();
      // The pairing can end while the database opens; a row written after that is kept for nobody.
      if (!this.usable()) return;
      const tx = db.transaction(ROWS, "readwrite");
      const rows = tx.objectStore(ROWS);
      // Another tab's Cancel, its debt and the wire fact are never written over, as in `idb.ts`.
      for (const r of puts) {
        const entity = r.entity as Record<string, unknown> | null;
        if (r.type !== OUTBOX_TYPE || entity === null || typeof entity !== "object") continue;
        const prior = storedRow(await request(rows.get([this.scope!, r.type, r.id])));
        const carried = carriedOutboxMarks(entity, prior?.entity ?? null);
        if (carried !== null) r.entity = carried;
      }
      for (const r of puts) rows.put({ type: r.type, id: r.id, entity: r.entity }, [this.scope!, r.type, r.id]);
      for (const k of deletes) rows.delete([this.scope!, k.type, k.id]);
      await committed(tx);
      this.bus?.changed([...puts.map((r) => recordKey(r.type, r.id)), ...deletes.map((k) => recordKey(k.type, k.id))]);
    } catch {
      this.fallBack();
    }
  }
}

/** Delete every row whose key `drop` names, in one transaction. */
async function sweep(factory: IDBFactory | null, drop: (key: unknown[]) => boolean): Promise<void> {
  const db = await openDb(factory);
  try {
    const tx = db.transaction(ROWS, "readwrite");
    const rows = tx.objectStore(ROWS);
    for (const k of await request(rows.getAllKeys())) {
      if (!Array.isArray(k) || drop(k)) rows.delete(k);
    }
    await committed(tx);
  } finally {
    db.close();
  }
}

export type HostOutboxDiscard = "discarded" | "unreadable";

/**
 * WHAT THIS BROWSER KEPT GOES WITH THE PAIRING — every pairing's rows, or every one but
 * `except` (a fresh pairing keeps its own). `unreadable` when the database refused, which the
 * caller reports rather than calls done. A browser with no database held nothing.
 */
export async function discardHostOutbox(
  opts: { except?: string | null; factory?: IDBFactory | null } = {},
): Promise<HostOutboxDiscard> {
  const factory = browserFactory(opts.factory);
  if (factory === null) return "discarded";
  const except = opts.except ?? null;
  try {
    await sweep(factory, (k) => except === null || k[0] !== except);
    return "discarded";
  } catch {
    return "unreadable";
  }
}
