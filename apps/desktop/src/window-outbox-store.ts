/**
 * THE WINDOW'S MIRROR, WITH ITS QUEUED CHANGES KEPT ON THIS MACHINE. The mirror stays in memory,
 * rebuilt at every launch from the engine on this computer; the outbox is the one part nothing
 * rebuilds, and in memory it died with the window. The two outbox types go to the engine's
 * `/local/window/outbox` door before the engine publishes them (write-then-publish) and come back
 * at the next launch, where the engine's restore replays them under their original keys. Every
 * other row costs no request. Each request names the mailbox this window serves and the door
 * refuses any other, so an engine left behind by a switch of account never touches the next one's.
 * One meta key outlives the launch too: the recorded Sent folders (`SENT_FOLDERS_META`), in this
 * window's own storage under the mailbox it serves, so a start's first frame knows 'Envoyés'.
 */
import {
  BaseMirrorStore, OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE, SENT_FOLDERS_META, recordKey, retryAfterMsOf,
  type MirrorRecord,
} from "@ohmail/client-engine";

export const WINDOW_OUTBOX_PATH = "/local/window/outbox";

/** The bridge's shape: a URL and an init, answered with a `Response`. */
export type OutboxFetch = (url: string, init?: unknown) => Promise<Response>;

/** A busy shell names its wait; the write is asked this many times before it is refused. */
const WRITE_ATTEMPTS = 3;
const WRITE_WAIT_CAP_MS = 1_000;
/** Pages one read may follow; a door that never ends is a fault, not a large outbox. */
const MAX_PAGES = 1_000;

const isCarriedType = (type: string): boolean => type === OUTBOX_TYPE || type === OUTBOX_ABANDONED_TYPE;

/** Where a window keeps what outlives it besides the outbox: the webview's `localStorage` in the app. */
export type WindowKeep = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const sentFoldersKey = (scope: string): string => `ohmail.window.sent-folders.${scope}`;

function defaultKeep(): WindowKeep | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Sign-out's half: the mailbox's recorded Sent folders are not read by the next launch. */
export function forgetWindowSentFolders(scope: string, keep: WindowKeep | null = defaultKeep()): void {
  try {
    keep?.removeItem(sentFoldersKey(scope));
  } catch { /* a refused jar: the next mailbox read states them anew */ }
}

/** `recordKey` is `type:id` and neither type holds a colon, so the first one splits it. */
function keyParts(key: string): { type: string; id: string } {
  const at = key.indexOf(":");
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

function wireRow(v: unknown): MirrorRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as { type?: unknown; id?: unknown; entity?: unknown };
  if (typeof r.type !== "string" || !isCarriedType(r.type) || typeof r.id !== "string" || r.id === "") return null;
  if (typeof r.entity !== "object" || r.entity === null) return null;
  return { type: r.type, id: r.id, seq: 0, entity: r.entity };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export interface WindowOutboxStoreOptions {
  /** The mailbox this window serves — `EngineStatus.mailboxId`, the window's own mount key. */
  scope: string;
  /** Carries the changes. */
  write: OutboxFetch;
  /** The GET transport: the bridge's retrying one in the app. */
  read?: OutboxFetch;
  /** Where the recorded Sent folders are kept; the webview's `localStorage` by default. */
  keep?: WindowKeep | null;
}

export class WindowOutboxStore extends BaseMirrorStore {
  private readonly write: OutboxFetch;
  private readonly read: OutboxFetch;
  private readonly path: string;
  private readonly keep: WindowKeep | null;
  private readonly sentFoldersKey: string;

  constructor(opts: WindowOutboxStoreOptions) {
    super();
    this.write = opts.write;
    this.read = opts.read ?? opts.write;
    this.path = `${WINDOW_OUTBOX_PATH}?scope=${encodeURIComponent(opts.scope)}`;
    this.keep = opts.keep === undefined ? defaultKeep() : opts.keep;
    this.sentFoldersKey = sentFoldersKey(opts.scope);
  }

  /**
   * MERGE, NEVER REPLACE: a drive can reach the store before the boot's load resolves, so a
   * page may already be in memory. The disk adds the rows memory lacks; a row memory holds is
   * the newer word, because it reached memory only after it reached the disk.
   */
  protected async readPersisted(): Promise<void> {
    const rows: MirrorRecord[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url: string = after === null ? this.path : `${this.path}&after=${encodeURIComponent(after)}`;
      const res = await this.read(url, { method: "GET" });
      // An engine with no such door holds no outbox; refusing here would stop every drain.
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`ohmail Desktop: the engine answered ${res.status} to the outbox read`);
      const body = (await res.json()) as { rows?: unknown; next?: unknown };
      for (const raw of Array.isArray(body.rows) ? body.rows : []) {
        const rec = wireRow(raw);
        if (rec) rows.push(rec);
      }
      if (typeof body.next !== "string") break;
      after = body.next;
    }
    for (const rec of rows) {
      const key = recordKey(rec.type, rec.id);
      if (!this.records.has(key)) this.records.set(key, rec);
    }
    if (!this.meta.has(SENT_FOLDERS_META)) {
      try {
        const kept = this.keep?.getItem(this.sentFoldersKey) ?? null;
        if (kept !== null) this.meta.set(SENT_FOLDERS_META, JSON.parse(kept) as unknown);
      } catch { /* unreadable: names alone decide until the mailbox read */ }
    }
    this.ver++;
  }

  protected async persist(dirty: MirrorRecord[], _cursor: unknown, metaEntries: Array<[string, unknown]>): Promise<void> {
    for (const [k, v] of metaEntries) {
      if (k !== SENT_FOLDERS_META) continue;
      try {
        this.keep?.setItem(this.sentFoldersKey, JSON.stringify(v));
      } catch { /* refused: the next launch waits for the mailbox read, as before */ }
    }
    const mine = dirty.filter((r) => isCarriedType(r.type));
    if (mine.length === 0) return;
    await this.send(
      mine.filter((r) => r.entity !== null),
      mine.filter((r) => r.entity === null).map((r) => ({ type: r.type, id: r.id })),
    );
  }

  /** A `410` is about the cursor; the disk holds only the rows a wipe carries, so nothing goes. */
  protected async wipe(): Promise<void> {
    /* nothing on the door's disk is anything a wipe removes */
  }

  protected async transact(puts: MirrorRecord[], deletes: string[]): Promise<void> {
    const mine = puts.filter((r) => isCarriedType(r.type));
    const gone = deletes.map(keyParts).filter((k) => isCarriedType(k.type));
    if (mine.length === 0 && gone.length === 0) return;
    await this.send(mine, gone);
  }

  protected async purge(keys: string[]): Promise<void> {
    const gone = keys.map(keyParts).filter((k) => isCarriedType(k.type));
    if (gone.length === 0) return;
    await this.send([], gone);
  }

  /** One atomic write at the door, or a rejection the engine reads as "not recorded". */
  private async send(puts: MirrorRecord[], deletes: Array<{ type: string; id: string }>): Promise<void> {
    const body = JSON.stringify({
      puts: puts.map((r) => ({ type: r.type, id: r.id, entity: r.entity })),
      deletes,
    });
    for (let attempt = 1; ; attempt++) {
      const res = await this.write(this.path, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      if (res.ok) return;
      const wait = res.status === 503 ? retryAfterMsOf(res) : null;
      if (wait === null || attempt >= WRITE_ATTEMPTS) {
        throw new Error(`ohmail Desktop: the engine refused the outbox write (${res.status})`);
      }
      await sleep(Math.min(wait, WRITE_WAIT_CAP_MS));
    }
  }
}
