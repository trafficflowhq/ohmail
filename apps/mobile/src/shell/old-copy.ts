/**
 * THE PHONE'S OLD COPY, HANDED ACROSS ONCE. Before the shell, the phone kept each mailbox's copy in a SQLite mirror
 * of its own (`entities`, `meta`). The first start of the shell for that mailbox reads it once, in pages, and hands it
 * to the page, so the list a person had is the list they see before the network answers, and a half-written letter or
 * a queued send is not lost across the update. The page fills only what its own copy lacks, persists it (the queue's
 * rows natively first), then says it is done; native then marks the old copy handed and removes it, read back.
 *
 * Only the live scope's mirror is read, and only after its owner stamp is read and equals the session's owner key.
 * The stamps (`__owner`, and the generation) are not handed across. A copy marked handed is never handed again: a
 * start that finds one finishes its removal. The removal takes the launch's install verdict, so it cannot run before
 * the install is stamped; a fresh install has no old copy to remove.
 *
 * Imports nothing of the engine: the connection layer hands in the mirror's door ({@link OldMirrorPort}).
 */
import type { KeptRow } from "./bridge-kinds";

/** What the connection layer hands in: the old mirror of one owner key, and its removal. */
export interface OldMirrorPort {
  readonly ownerKey: string;
  /** Whether the mirror holds its tables; a probe that leaves nothing behind. */
  exists(): Promise<boolean>;
  /** The mirror's database handle; closed by the caller. */
  open(): Promise<OldMirrorDb>;
  /** The mirror removed and read back; throws when it stayed. */
  forget(): Promise<void>;
}

export interface OldMirrorDb {
  all(sql: string, params?: ReadonlyArray<string | number | null>): Promise<ReadonlyArray<Record<string, unknown>>>;
  batch(statements: ReadonlyArray<{ sql: string; params?: ReadonlyArray<string | number | null> }>): Promise<void>;
  close?(): void | Promise<void>;
}

/** The install verdicts under which the old copy may be removed: the install that wrote it is this one. */
export type RemovalVerdict = "same-install" | "upgrade";

export interface OldCopyPage {
  readonly entities: readonly KeptRow[];
  readonly meta: readonly (readonly [string, string])[];
  readonly next: string | null;
}

/** The mark a handed copy carries until it is gone: a start that finds it finishes the removal. */
const HANDED = "__handed";
/** The meta the copy does not hand across: its stamps, and the hand-across's own mark. */
const STAMPS = new Set(["__owner", "__gen", HANDED]);
/** A page's bounds: rows, and the bytes of their records. */
export const PAGE_ROWS = 200;
export const PAGE_BYTES = 2 * 1024 * 1024;

/** The copy is not handed across; the page is answered with a refusal and nothing is read. Its message is the code. */
export class OldCopyRefused extends Error {
  constructor(readonly why: "foreignOwner" | "absent") {
    super(why);
    this.name = "OldCopyRefused";
  }
}

async function withDb<T>(port: OldMirrorPort, work: (db: OldMirrorDb) => Promise<T>): Promise<T> {
  const db = await port.open();
  try {
    return await work(db);
  } finally {
    await db.close?.();
  }
}

async function metaOf(db: OldMirrorDb, key: string): Promise<string | null> {
  const rows = await db.all("SELECT value FROM meta WHERE key = ?", [key]);
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

export interface OldCopyDoor {
  /**
   * Whether a copy waits to be handed across. A copy already marked handed is removed here (a start that died
   * between the mark and the removal) and answers false.
   */
  present(): Promise<boolean>;
  /** One page of the copy after `after` (a row key), or the first. Refused for a copy not stamped with this owner. */
  page(after: string | null): Promise<OldCopyPage>;
  /** The page has its copy: mark the old one handed, then remove it, read back. */
  done(verdict: RemovalVerdict): Promise<void>;
}

export function oldCopyDoor(port: OldMirrorPort): OldCopyDoor {
  const stamped = async (db: OldMirrorDb): Promise<boolean> =>
    (await metaOf(db, "__owner")) === JSON.stringify(port.ownerKey);
  return {
    async present() {
      if (!(await port.exists())) return false;
      const handed = await withDb(port, (db) => metaOf(db, HANDED));
      if (handed === null) return withDb(port, stamped);
      await port.forget();
      return false;
    },
    async page(after) {
      if (!(await port.exists())) throw new OldCopyRefused("absent");
      return withDb(port, async (db) => {
        if (!(await stamped(db))) throw new OldCopyRefused("foreignOwner");
        const rows = await db.all(
          "SELECT key, record FROM entities WHERE key > ? ORDER BY key LIMIT ?",
          [after ?? "", PAGE_ROWS],
        );
        const entities: KeptRow[] = [];
        let bytes = 0;
        for (const row of rows) {
          const key = String(row.key);
          const json = String(row.record);
          const at = key.indexOf(":");
          if (at <= 0) continue;
          if (entities.length > 0 && bytes + json.length > PAGE_BYTES) break;
          entities.push({ type: key.slice(0, at), id: key.slice(at + 1), json });
          bytes += json.length;
        }
        const meta = after === null
          ? (await db.all("SELECT key, value FROM meta ORDER BY key"))
            .map((r) => [String(r.key), String(r.value)] as const)
            .filter(([key]) => !STAMPS.has(key))
          : [];
        const last = entities.at(-1);
        const more = entities.length < rows.length || rows.length === PAGE_ROWS;
        return { entities, meta, next: more && last ? `${last.type}:${last.id}` : null };
      });
    },
    /* The verdict is the argument, not a read: a caller without a settled install has nothing to pass. */
    async done(_verdict: RemovalVerdict) {
      await withDb(port, async (db) => {
        if (!(await stamped(db))) throw new OldCopyRefused("foreignOwner");
        await db.batch([{
          sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          params: [HANDED, JSON.stringify(true)],
        }]);
      });
      await port.forget();
    },
  };
}

let launch: RemovalVerdict | "other" | null = null;

/** The launch's install verdict, as the connection layer settled it. */
export function settleLaunchVerdict(kind: string): void {
  launch = kind === "same-install" || kind === "upgrade" ? kind : "other";
}

/** The verdict the removal may run under, or null before the launch settled one (or on any other verdict). */
export function launchVerdict(): RemovalVerdict | null {
  return launch === "same-install" || launch === "upgrade" ? launch : null;
}
