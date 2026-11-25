/**
 * THE PAGE'S COPY WITH THE QUEUE KEPT NATIVELY. Every row the store carries through a wipe (the
 * outbox, the routing journal, the letters being written) is written to the native keeper before
 * the page's own copy writes it, and a native refusal fails the write: nothing is published that the
 * keeper does not hold. Deletions go the same way. So the native rows are never older than the page's.
 *
 * At start the keeper's rows are read FIRST, then the page's copy fills, then the two are merged with
 * nothing awaited before the base store stamps its types (`store.ts` warns of that window): where the
 * two differ the native row wins, and a carried row the keeper lacks is dropped (its removal reached
 * native and the page's copy had not caught up). A web view whose storage the system emptied comes
 * back with its queue, and a send waiting in it leaves once, under its own key.
 */
import type { KeptRow } from "../../src/shell/bridge-kinds";
import {
  IndexedDbMirrorStore, isCalendarQueueType, isCarriedLocalType, recordKey, type IndexedDbMirrorStoreOptions, type MirrorRecord,
} from "./engine-package";

/** The keeper's door, as the store needs it: the scope is native's, whatever the page names. */
export interface QueueKeeper {
  rows(): Promise<readonly KeptRow[]>;
  write(puts: readonly KeptRow[], deletes: readonly (readonly [string, string])[]): Promise<boolean>;
}

export class KeeperRefused extends Error {
  constructor() {
    super("the native keeper refused the queue's rows; nothing was written");
    this.name = "KeeperRefused";
  }
}

const typeOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf(":")));
const pairOf = (key: string): [string, string] => [typeOf(key), key.slice(key.indexOf(":") + 1)];
const rowOf = (rec: MirrorRecord): KeptRow => ({ type: rec.type, id: rec.id, json: JSON.stringify(rec) });

export class KeptIdbStore extends IndexedDbMirrorStore {
  private readonly keepsCalendar: boolean;

  constructor(opts: IndexedDbMirrorStoreOptions, private readonly keeper: QueueKeeper) {
    super(opts);
    this.keepsCalendar = opts.calendarOnly === true;
  }

  private carries(type: string): boolean {
    return this.keepsCalendar ? isCalendarQueueType(type) : isCarriedLocalType(type);
  }

  private async keep(puts: readonly MirrorRecord[], deletes: readonly string[]): Promise<void> {
    if (puts.length === 0 && deletes.length === 0) return;
    const ok = await this.keeper.write(puts.map(rowOf), deletes.map(pairOf));
    if (!ok) throw new KeeperRefused();
  }

  protected override async persist(...args: Parameters<IndexedDbMirrorStore["persist"]>): Promise<void> {
    await this.keep(args[0].filter((r) => this.carries(r.type)), []);
    return super.persist(...args);
  }

  protected override async transact(puts: MirrorRecord[], deletes: string[]): Promise<void> {
    await this.keep(puts.filter((r) => this.carries(r.type)), deletes.filter((k) => this.carries(typeOf(k))));
    return super.transact(puts, deletes);
  }

  protected override async purge(keys: string[]): Promise<void> {
    await this.keep([], keys.filter((k) => this.carries(typeOf(k))));
    return super.purge(keys);
  }

  /**
   * Rows, a cursor and meta taken from elsewhere (the phone's old copy), written as a flush writes them: the queue's
   * rows natively first, a refusal failing the write. Memory is not touched: a store opened after this reads them.
   */
  async adopt(records: MirrorRecord[], cursor: string | null, meta: Array<[string, unknown]>): Promise<void> {
    await this.persist(records, cursor, meta);
  }

  private async nativeRows(): Promise<Map<string, MirrorRecord>> {
    const records = new Map<string, MirrorRecord>();
    for (const row of await this.keeper.rows()) {
      if (!this.carries(row.type)) continue;
      try {
        const record = JSON.parse(row.json) as MirrorRecord;
        if (!this.keepsCalendar || (record.type === row.type && record.id === row.id && record.seq === 0)) {
          records.set(recordKey(row.type, row.id), record);
        }
      } catch {
        // A row native holds but cannot be read back is not invented into the queue.
      }
    }
    return records;
  }

  protected override async readCalendarOutboxRange(now: number): Promise<MirrorRecord[] | null> {
    if (!this.keepsCalendar) return super.readCalendarOutboxRange(now);
    const rows = await this.nativeRows();
    const expired: string[] = [];
    for (const [key, row] of rows) {
      if (row.type === "calendar_settlement" && Number((row.entity as { expiresAt?: unknown })?.expiresAt) <= now) {
        rows.delete(key);
        expired.push(key);
      }
    }
    await this.keep([], expired);
    return [...rows.values()];
  }

  protected override async readPersisted(): Promise<void> {
    const native = await this.nativeRows();
    await super.readPersisted();
    for (const [key, rec] of this.records) {
      if (this.carries(rec.type) && !native.has(key)) this.records.delete(key);
    }
    for (const [key, rec] of native) this.records.set(key, rec);
    this.ver++;
  }
}
