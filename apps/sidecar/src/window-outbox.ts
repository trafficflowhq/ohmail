/**
 * `GET|POST /local/window/outbox` — the window engine's queued changes, kept on THIS machine.
 *
 * The window's engine holds no mirror on disk, so before this door a change made while the
 * server was out of reach lived in the window's memory only and died with it. The rows are the
 * engine's own outbox records and nothing else: two types, taken whole, never read here. One
 * file in the data directory, replaced by stage-flush-rename on every write, so a reader finds
 * the previous or the next complete set and never a torn one; an empty set removes the file.
 * Every request names the mailbox its window serves, and only this engine's is admitted.
 */
import { readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicFileSynced } from "./fs-atomic.js";
import type { Diagnostic } from "./log.js";

export const WINDOW_OUTBOX_ROUTE = "/local/window/outbox";
export const WINDOW_OUTBOX_FILE = "window-outbox.json";
/** The file and the unreadable copy a failed read sets aside — both the world's own, both discarded with it. */
export const WINDOW_OUTBOX_FILES: readonly string[] = [WINDOW_OUTBOX_FILE, `${WINDOW_OUTBOX_FILE}.unreadable`];

/** The client engine's `OUTBOX_TYPE` and `OUTBOX_ABANDONED_TYPE`, spelled here: this process does not link it. */
export const WINDOW_OUTBOX_TYPES: readonly string[] = ["outbox_entry", "outbox_abandoned"];

/** Under the shell's 32 MiB frame, so one send that crossed the bridge fits in one write. */
const WINDOW_OUTBOX_MAX_BODY_BYTES = 31 * 1024 * 1024;
/** What one GET page carries at most, beside a single row larger than it, which goes alone. */
const WINDOW_OUTBOX_PAGE_BYTES = 8 * 1024 * 1024;
/** The whole set's ceiling. A write past it is refused, so the window says it could not record. */
const WINDOW_OUTBOX_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 20_000;
const ID = /^[\x21-\x7e]{1,200}$/;

interface Row { type: string; id: string; entity: Record<string, unknown> }
interface Held { row: Row; bytes: number }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const keyOf = (type: string, id: string): string => JSON.stringify([type, id]);

function isKey(v: unknown): v is { type: string; id: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.type === "string" && WINDOW_OUTBOX_TYPES.includes(r.type)
    && typeof r.id === "string" && ID.test(r.id);
}

function isRow(v: unknown): v is Row {
  if (!isKey(v)) return false;
  const e = (v as { entity?: unknown }).entity;
  return typeof e === "object" && e !== null && !Array.isArray(e);
}

export interface WindowOutboxDeps {
  dataDir: string;
  /** Does this request carry the install's live launch bearer — the answer every local door gives. */
  authorized: (req: Request) => Promise<boolean>;
  /**
   * The mailbox this engine serves, read per request. A window left open across a switch of
   * account names the previous one, and its write must not land in the next account's outbox.
   */
  scope: () => string;
  log: Diagnostic;
  /** The durable write; tests inject a refusing one. */
  write?: (path: string, contents: string) => Promise<void>;
  /** One GET page's bound; {@link WINDOW_OUTBOX_PAGE_BYTES} unless a test pages small rows. */
  pageBytes?: number;
}

interface WindowOutbox {
  handle(req: Request): Promise<Response>;
}

export function createWindowOutbox(deps: WindowOutboxDeps): WindowOutbox {
  const path = join(deps.dataDir, WINDOW_OUTBOX_FILE);
  const write = deps.write ?? ((p: string, c: string) => writeAtomicFileSynced(p, c, 0o600));
  const pageBytes = deps.pageBytes ?? WINDOW_OUTBOX_PAGE_BYTES;
  let held: Map<string, Held> | null = null;
  // ONE AT A TIME: a read waits for the write before it, and two writes never interleave their
  // read-modify-rename, so a change the window was told is recorded is in every later read.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const refuse = (status: number, reason: string): Response => {
    deps.log("window_outbox_refused", { route: WINDOW_OUTBOX_ROUTE, status, reason });
    const code = status === 413 ? "too_large" : status === 409 ? "outbox_scope_mismatch" : "invalid_request";
    return json(status, { error: { code, message: `the outbox request was refused: ${reason}` } });
  };

  const load = async (): Promise<Map<string, Held>> => {
    if (held) return held;
    const next = new Map<string, Held>();
    let raw: string | null = null;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw !== null) {
      let rows: unknown[] | null = null;
      try {
        const parsed = JSON.parse(raw) as { v?: unknown; rows?: unknown };
        if (parsed.v === 1 && Array.isArray(parsed.rows)) rows = parsed.rows;
      } catch { /* read below as unreadable */ }
      if (rows === null) {
        // KEPT ASIDE, NOT DELETED: a file this build cannot read is somebody's queued work, and the
        // next launch must not refuse every read on it either.
        await rename(path, `${path}.unreadable`).catch(() => undefined);
        deps.log("window_outbox_read_failed", { reason: "the saved outbox could not be read, so it was set aside and the window starts with none" });
      } else {
        for (const r of rows) {
          if (isRow(r)) next.set(keyOf(r.type, r.id), { row: r, bytes: JSON.stringify(r).length });
        }
      }
    }
    held = next;
    return next;
  };

  const persist = async (next: Map<string, Held>): Promise<void> => {
    if (next.size === 0) {
      await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
      return;
    }
    await write(path, JSON.stringify({ v: 1, rows: [...next.values()].map((h) => h.row) }));
  };

  // PAGED BY KEY, not by position: a delete between two pages would shift a position and skip a row.
  const read = async (url: URL): Promise<Response> => {
    const set = await load();
    const after = url.searchParams.get("after");
    const keys = [...set.keys()].sort();
    const rows: Row[] = [];
    let bytes = 0;
    let last: string | null = null;
    let more = false;
    for (const k of keys) {
      if (after !== null && k <= after) continue;
      const h = set.get(k)!;
      if (rows.length > 0 && bytes + h.bytes > pageBytes) { more = true; break; }
      rows.push(h.row);
      bytes += h.bytes;
      last = k;
    }
    return json(200, { rows, next: more ? last : null });
  };

  const change = async (req: Request): Promise<Response> => {
    const text = await req.text();
    if (text.length > WINDOW_OUTBOX_MAX_BODY_BYTES) return refuse(413, "body over the bound");
    let body: { puts?: unknown; deletes?: unknown };
    try { body = JSON.parse(text) as typeof body; } catch { return refuse(400, "not JSON"); }
    const puts = Array.isArray(body.puts) ? body.puts : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];
    if (!puts.every(isRow)) return refuse(400, "a put that is not an outbox row");
    if (!deletes.every(isKey)) return refuse(400, "a delete that is not an outbox key");
    const set = await load();
    const next = new Map(set);
    // PUTS, THEN DELETES — the order the engine's own store applies one commit in.
    for (const r of puts as Row[]) {
      next.set(keyOf(r.type, r.id), { row: { type: r.type, id: r.id, entity: r.entity }, bytes: JSON.stringify(r).length });
    }
    for (const d of deletes as Array<{ type: string; id: string }>) next.delete(keyOf(d.type, d.id));
    let total = 0;
    for (const h of next.values()) total += h.bytes;
    if (next.size > MAX_ROWS || total > WINDOW_OUTBOX_MAX_TOTAL_BYTES) return refuse(413, "the outbox is over its bound");
    try {
      await persist(next);
    } catch (err) {
      deps.log("window_outbox_write_failed", { err, reason: "the window's queued changes could not be written, so the change was refused" });
      return json(500, { error: { code: "storage_refused", message: "the outbox could not be written to disk" } });
    }
    held = next;
    return new Response(null, { status: 204 });
  };

  return {
    async handle(req) {
      if (!(await deps.authorized(req))) {
        return json(401, { error: { code: "unauthorized", message: "authentication required" } });
      }
      const url = new URL(req.url);
      const served = deps.scope();
      if (served === "" || url.searchParams.get("scope") !== served) {
        return refuse(409, "a mailbox this engine does not serve");
      }
      if (req.method === "GET") return serial(() => read(url));
      if (req.method === "POST") return serial(() => change(req));
      return json(405, { error: { code: "method_not_allowed", message: "the outbox takes GET and POST" } });
    },
  };
}
